import { describe, expect, it } from "@effect/vitest";
import type { AgentHost } from "@gram/agents";
import { AgentUnavailable, type SubscriptionLimitReport, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { EventHub } from "../events/event-hub.ts";
import { AppActivity } from "../git/activity.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { UsageLimitReadings } from "./limit-readings.ts";
import { LIMIT_POLL_MS, LIMIT_WAIT_POLL_MS, UsageLimitPoller } from "./limit-poller.ts";

const report = (
  window: "five_hour" | "seven_day",
  utilization: number,
): SubscriptionLimitReport => ({
  window,
  utilization,
  status: "allowed",
  resetsAt: 10 * 24 * 3600000,
});
const withPoller = <A, E>(
  hosts: ReadonlyArray<AgentHost>,
  body: Effect.Effect<A, E, UsageLimitPoller | UsageLimitReadings>,
) =>
  body.pipe(
    Effect.provide(
      UsageLimitPoller.layer.pipe(
        Layer.provideMerge(UsageLimitReadings.layer),
        Layer.provideMerge(EventHub.layer),
        Layer.provideMerge(ThreadStore.layerSqlite(":memory:")),
        Layer.provide(Layer.succeed(AgentHosts)(AgentHosts.fromHosts(hosts))),
      ),
    ),
    Effect.scoped,
  );

// Only the explicit metadata port is exercised. No native host or ambient auth can be reached.
const host = (
  kind: "claude" | "codex",
  readSubscriptionLimits: NonNullable<AgentHost["readSubscriptionLimits"]>,
): AgentHost => ({ kind, readSubscriptionLimits }) as AgentHost;

describe("subscription limit polling", () => {
  it.effect("starts no CLI while no window shows, and reads afresh as one comes back", () =>
    Effect.gen(function* () {
      let calls = 0;
      yield* Effect.gen(function* () {
        const activity = yield* AppActivity;
        yield* Effect.yieldNow;
        expect(calls).toBe(1);
        yield* activity.setWindows([{ visible: false, focused: false }]);
        // Ten minutes hidden: ten CLI starts at the minute cadence before, none now.
        yield* TestClock.adjust(10 * LIMIT_POLL_MS);
        expect(calls).toBe(1);
        yield* activity.setWindows([{ visible: true, focused: true }]);
        yield* Effect.yieldNow;
        expect(calls).toBe(2);
        yield* TestClock.adjust(LIMIT_POLL_MS);
        expect(calls).toBe(3);
      }).pipe(
        Effect.provide(
          UsageLimitPoller.layer.pipe(
            Layer.provideMerge(UsageLimitReadings.layer),
            Layer.provideMerge(EventHub.layer),
            Layer.provideMerge(ThreadStore.layerSqlite(":memory:")),
            Layer.provideMerge(AppActivity.layer),
            Layer.provide(
              Layer.succeed(AgentHosts)(
                AgentHosts.fromHosts([
                  host(
                    "claude",
                    Effect.sync(() => {
                      calls++;
                      return [report("five_hour", 0.44)];
                    }),
                  ),
                ]),
              ),
            ),
          ),
        ),
        Effect.scoped,
      );
    }),
  );

  it.effect("reads limits a thread waits on while no window shows", () =>
    Effect.gen(function* () {
      let calls = 0;
      yield* Effect.gen(function* () {
        const activity = yield* AppActivity;
        const store = yield* ThreadStore;
        yield* Effect.yieldNow;
        yield* activity.setWindows([{ visible: false, focused: false }]);
        yield* TestClock.adjust(LIMIT_WAIT_POLL_MS);
        // Nothing waits on a limit: no window, no CLI start.
        expect(calls).toBe(1);
        const { project } = yield* store.registerProject({ root: "/work/repo", name: "repo" });
        yield* store.insertThread({
          id: "waiting" as ThreadId,
          projectId: project.id,
          title: "waiting",
          userNamed: false,
          model: { agent: "claude", model: "opus" },
          mode: "default",
          checkout: { kind: "main", path: "/work/repo" },
          labels: [],
          pinned: false,
          parked: false,
          unread: false,
          createdAt: 1,
          lastActivityAt: 1,
          limitWait: {
            kind: "limit",
            account: "claude/",
            resetsAt: 4 * 3600000,
            resumeAt: 4 * 3600000 + 20_000,
            since: 0,
            attempt: 0,
          },
        });
        // Before: none until a window came back, so the wait held past the limit's lifting.
        yield* TestClock.adjust(LIMIT_WAIT_POLL_MS);
        expect(calls).toBe(2);
      }).pipe(
        Effect.provide(
          UsageLimitPoller.layer.pipe(
            Layer.provideMerge(UsageLimitReadings.layer),
            Layer.provideMerge(EventHub.layer),
            Layer.provideMerge(ThreadStore.layerSqlite(":memory:")),
            Layer.provideMerge(AppActivity.layer),
            Layer.provide(
              Layer.succeed(AgentHosts)(
                AgentHosts.fromHosts([
                  host(
                    "claude",
                    Effect.sync(() => {
                      calls++;
                      return [report("five_hour", 0)];
                    }),
                  ),
                ]),
              ),
            ),
          ),
        ),
        Effect.scoped,
      );
    }),
  );

  it.effect("populates both providers and windows at startup, then refreshes while idle", () =>
    Effect.gen(function* () {
      let calls = 0;
      yield* withPoller(
        [
          host(
            "claude",
            Effect.sync(() => {
              calls++;
              return [report("five_hour", 0.44), report("seven_day", 0.96)];
            }),
          ),
          host("codex", Effect.succeed([report("five_hour", 0), report("seven_day", 1)])),
        ],
        Effect.gen(function* () {
          const poller = yield* UsageLimitPoller,
            readings = yield* UsageLimitReadings;
          yield* poller.refresh;
          expect(
            (yield* readings.current).map((x) => [x.agent, x.window, x.utilization]).toSorted(),
          ).toEqual([
            ["claude", "five_hour", 0.44],
            ["claude", "seven_day", 0.96],
            ["codex", "five_hour", 0],
            ["codex", "seven_day", 1],
          ]);
          yield* poller.refresh;
          expect(calls).toBe(1);
          yield* TestClock.adjust(LIMIT_POLL_MS);
          yield* poller.refresh;
          expect(calls).toBe(2);
        }),
      );
    }),
  );
  it.effect(
    "clears signed-out or missing windows, preserves gateways and keeps transient failures aged",
    () =>
      Effect.gen(function* () {
        let signedOut = false,
          transient = false;
        yield* withPoller(
          [
            host(
              "claude",
              Effect.suspend(() =>
                signedOut
                  ? Effect.fail(
                      new AgentUnavailable({
                        agent: "claude",
                        reason: "not-logged-in",
                        message: "synthetic signed out",
                      }),
                    )
                  : Effect.succeed([report("five_hour", 0.44)]),
              ),
            ),
            host(
              "codex",
              Effect.suspend(() =>
                transient
                  ? Effect.fail(
                      new AgentUnavailable({
                        agent: "codex",
                        message: "synthetic network failure",
                      }),
                    )
                  : Effect.succeed([report("seven_day", 1)]),
              ),
            ),
          ],
          Effect.gen(function* () {
            const poller = yield* UsageLimitPoller,
              readings = yield* UsageLimitReadings;
            yield* poller.refresh;
            yield* readings.record({
              type: "usageLimit",
              agent: "claude",
              profileId: "gateway",
              gateway: true,
              threadId: "synthetic" as ThreadId,
              ...report("five_hour", 0.8),
            });
            const codexBefore = (yield* readings.current).find((x) => x.agent === "codex");
            signedOut = true;
            transient = true;
            yield* TestClock.adjust(LIMIT_POLL_MS);
            yield* poller.refresh;
            expect(yield* readings.current).toEqual(
              expect.arrayContaining([
                codexBefore,
                expect.objectContaining({
                  agent: "claude",
                  profileId: "gateway",
                  utilization: 0.8,
                }),
              ]),
            );
            expect(
              (yield* readings.current).some(
                (x) => x.agent === "claude" && x.profileId === undefined,
              ),
            ).toBe(false);
            transient = false;
            yield* readings.replaceSubscription("codex", [], yield* readings.current);
            expect((yield* readings.current).some((x) => x.agent === "codex")).toBe(false);
          }),
        );
      }),
  );
});
