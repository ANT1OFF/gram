import {
  isSubscriptionLimitWindow,
  LimitRecord,
  limitCurrent,
  nextLimitReading,
  type ServerEvent,
  type AgentKind,
  type LimitReport,
  type SubscriptionLimitReport,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { EventHub } from "../events/event-hub.ts";
import { SqlClient, type SqlError } from "../platform/unstable.ts";

type UsageLimitEvent = Extract<ServerEvent, { type: "usageLimit" }>;

/**
 * A reading that only moved its `at` is written again once this much later, so a window read on
 * every request isn't a write per request while its age after a restart stays close.
 */
const LIMIT_WRITE_EVERY_MS = 60_000;

/** A broken database is a defect, as in `ThreadStore`. */
const run = <A>(effect: Effect.Effect<A, SqlError>) =>
  effect.pipe(Effect.catch((error) => Effect.die(error)));
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(LimitRecord));
const encode = Schema.encodeSync(Schema.fromJsonString(LimitRecord));
const keyOf = (record: Pick<LimitRecord, "agent" | "profileId" | "window">) =>
  `${record.agent}/${record.profileId ?? ""}/${record.window}`;
/** What a record says apart from when it was read. */
const restOf = (record: LimitRecord) => JSON.stringify({ ...record, at: undefined });

export interface UsageLimitReadingsShape {
  /** Every window's latest reading still current now, gateways' included, by agent and window. */
  readonly current: Effect.Effect<ReadonlyArray<LimitRecord>>;
  /** Authoritative CLI snapshot: removes missing subscription windows, preserving gateway records.
   * Pass `current` captured before the query: newer stream readings win, even in the same ms. */
  readonly replaceSubscription: (
    agent: AgentKind,
    reports: ReadonlyArray<SubscriptionLimitReport>,
    beforeQuery: ReadonlyArray<LimitRecord>,
  ) => Effect.Effect<void>;
  /** Takes one `usageLimit` event as it arrives; the layer feeds it every one the hub publishes. */
  readonly record: (event: UsageLimitEvent) => Effect.Effect<void>;
  /**
   * Once each time a reading was taken in, after `current` has it: a stream event's or a CLI
   * snapshot's, whether or not it changed what `current` says.
   */
  readonly changes: Stream.Stream<void>;
  /**
   * A turn on `login` (an agent's own, or a gateway profile's) that opened at `since` went through:
   * the rejections read before it no longer stop anything, so they stand as allowed, their share
   * kept. A rejection read since stays.
   */
  readonly admitted: (
    login: Pick<LimitRecord, "agent" | "profileId">,
    since: number,
  ) => Effect.Effect<void>;
}

/**
 * The latest reading of each subscription limit window, per agent, login (the CLI's own or a
 * gateway profile's) and window, with the window's samples for the forecast. Stored in
 * `usage_limits` (`0027_usage_limits`), so a restart or a reload finds them, and dropped once
 * their window has reset (`limitExpiresAt`).
 */
export class UsageLimitReadings extends Context.Service<
  UsageLimitReadings,
  UsageLimitReadingsShape
>()("@gram/server/UsageLimitReadings") {
  static readonly layer: Layer.Layer<UsageLimitReadings, never, EventHub | SqlClient.SqlClient> =
    Layer.effect(
      UsageLimitReadings,
      Effect.gen(function* () {
        const hub = yield* EventHub;
        const sql = yield* SqlClient.SqlClient;

        const lock = yield* Semaphore.make(1);
        const changed = yield* PubSub.unbounded<void>();
        const records = new Map<string, LimitRecord>();
        /** When each key was last written, and what was written apart from `at`. */
        const written = new Map<string, { readonly at: number; readonly rest: string }>();

        const now = yield* Clock.currentTimeMillis;
        const rows = yield* run(
          sql<{ key: string; data: string }>`SELECT key, data FROM usage_limits`,
        );
        for (const row of rows) {
          const record = decode(row.data);
          if (record._tag === "Some" && limitCurrent(record.value, now)) {
            records.set(row.key, record.value);
            written.set(row.key, { at: record.value.at, rest: restOf(record.value) });
          } else {
            yield* run(sql`DELETE FROM usage_limits WHERE key = ${row.key}`);
          }
        }

        const record = (
          event: Pick<LimitRecord, "agent" | "profileId" | "window"> & LimitReport,
          snapshot = false,
        ) =>
          Effect.gen(function* () {
            if (!isSubscriptionLimitWindow(event.window)) return;
            const at = yield* Clock.currentTimeMillis;
            const key = keyOf(event);
            const before = records.get(key);
            const reading = nextLimitReading(before, event, at, { snapshot });
            if (reading === undefined || reading === before) return;
            const next: LimitRecord = {
              agent: event.agent,
              ...(event.profileId === undefined ? {} : { profileId: event.profileId }),
              window: event.window,
              ...reading,
            };
            records.set(key, next);
            const last = written.get(key);
            const rest = restOf(next);
            if (last !== undefined && last.rest === rest && at - last.at < LIMIT_WRITE_EVERY_MS) {
              return;
            }
            written.set(key, { at, rest });
            yield* run(
              sql`INSERT INTO usage_limits (key, data) VALUES (${key}, ${encode(next)})
                ON CONFLICT(key) DO UPDATE SET data = excluded.data`,
            );
          });

        const current: UsageLimitReadingsShape["current"] = Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis;
          const gone = [...records].filter(([, each]) => !limitCurrent(each, at));
          for (const [key] of gone) {
            records.delete(key);
            written.delete(key);
            yield* run(sql`DELETE FROM usage_limits WHERE key = ${key}`);
          }
          return [...records.values()];
        });

        yield* hub
          .internalEvents(
            (event): event is UsageLimitEvent => event.type === "usageLimit",
            "usage limits",
          )
          .pipe(
            Stream.runForEach((event) =>
              lock
                .withPermits(1)(record(event))
                .pipe(Effect.andThen(PubSub.publish(changed, undefined))),
            ),
            Effect.forkScoped,
          );

        const replaceSubscription: UsageLimitReadingsShape["replaceSubscription"] = (
          agent,
          reports,
          beforeQuery,
        ) =>
          lock
            .withPermits(1)(
              Effect.gen(function* () {
                const captured = new Map(beforeQuery.map((before) => [keyOf(before), before]));
                const windows = new Set(reports.map((report) => report.window));
                for (const [key, before] of records) {
                  if (
                    before.agent !== agent ||
                    before.profileId !== undefined ||
                    captured.get(key) !== before
                  )
                    continue;
                  if (!windows.has(before.window as SubscriptionLimitReport["window"])) {
                    records.delete(key);
                    written.delete(key);
                    yield* run(sql`DELETE FROM usage_limits WHERE key = ${key}`);
                  }
                }
                for (const report of reports) {
                  const before = records.get(keyOf({ agent, window: report.window }));
                  if (before !== captured.get(keyOf({ agent, window: report.window }))) continue;
                  yield* record({ agent, ...report }, true);
                }
              }),
            )
            .pipe(Effect.andThen(PubSub.publish(changed, undefined)), Effect.asVoid);
        return UsageLimitReadings.of({
          current: lock.withPermits(1)(current),
          record: (event) => lock.withPermits(1)(record(event)),
          replaceSubscription,
          changes: Stream.fromPubSub(changed),
          admitted: (login, since) =>
            lock
              .withPermits(1)(
                Effect.gen(function* () {
                  let any = false;
                  for (const [key, before] of records) {
                    if (
                      before.agent !== login.agent ||
                      before.profileId !== login.profileId ||
                      before.status !== "rejected" ||
                      before.at >= since
                    )
                      continue;
                    const next: LimitRecord = { ...before, status: "allowed" };
                    records.set(key, next);
                    written.set(key, { at: next.at, rest: restOf(next) });
                    yield* run(
                      sql`UPDATE usage_limits SET data = ${encode(next)} WHERE key = ${key}`,
                    );
                    any = true;
                  }
                  if (!any) return false;
                  yield* hub.publish({
                    type: "usageLimits.snapshot",
                    limits: [...records.values()],
                  });
                  return true;
                }),
              )
              .pipe(
                Effect.flatMap((any) => (any ? PubSub.publish(changed, undefined) : Effect.void)),
                Effect.asVoid,
              ),
        });
      }),
    );
}
