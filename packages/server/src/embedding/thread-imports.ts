import type { ThreadId } from "@gram/contracts";
import {
  ExportThreadForPersonInput,
  ImportThreadForPersonInput,
  SettleThreadForPersonInput,
  ThreadBundle,
} from "@gram/contracts/thread-transfer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Actor } from "../http/fronted-identity.ts";
import { mayReachThread, ownersOf, RoutedFor } from "../host/ownership.ts";
import { RemoteHosts } from "../host/remote-hosts.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { actorEventsOf } from "../rpc/actor-guard.ts";
import { ThreadTransfer } from "../transfer/thread-transfer.ts";
import { answer, EmbedInbound, refusal } from "./inbound.ts";
import { ActingPerson } from "./person.ts";
import { readerMay } from "./readable-by.ts";
import { personOf } from "./thread-starts.ts";

/** The largest bundle the platform may bring in: a long conversation, its edits being at the remote. */
export const THREAD_IMPORT_MAX_BYTES = 32 * 1024 * 1024;

const from = Schema.decodeUnknownOption(
  ImportThreadForPersonInput.mapFields(({ person: _person, ...rest }) => rest),
);

const exportOf = Schema.decodeUnknownOption(
  ExportThreadForPersonInput.mapFields(({ person: _person, ...rest }) => rest),
);
const settleOf = Schema.decodeUnknownOption(
  SettleThreadForPersonInput.mapFields(({ person: _person, ...rest }) => rest),
);
const encodeBundle = Schema.encodeSync(ThreadBundle);

/** Serves the paths; provides nothing. */
export const ThreadImportsInboundLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const inbound = yield* EmbedInbound;
    const transfer = yield* ThreadTransfer;
    const store = yield* ThreadStore;
    const machines = Option.getOrUndefined(yield* Effect.serviceOption(RemoteHosts))?.machines;
    const ownerOf = ownersOf(machines);

    const reaches = (person: string, threadId: ThreadId) =>
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId).pipe(Effect.option);
        if (Option.isNone(thread)) return false;
        if (!readerMay({ subject: person }, thread.value.readableBy)) return false;
        const by = thread.value.transferredFrom?.by;
        if (by !== undefined && by !== person) return false;
        return yield* mayReachThread(store.getThread, ownerOf, threadId).pipe(
          Effect.provideService(RoutedFor, { person }),
        );
      });

    const asPerson = <A, E>(
      person: Actor,
      action: string,
      payload: Record<string, unknown>,
      effect: Effect.Effect<A, E>,
    ) =>
      effect.pipe(
        Effect.tap(() =>
          store.appendActorEvents(actorEventsOf(person, action, payload, Date.now())),
        ),
        Effect.provideService(ActingPerson, person.id),
        Effect.provideService(RoutedFor, { person: person.id }),
      );

    yield* inbound.route("POST", "thread-exports", (body) =>
      Effect.gen(function* () {
        const person = personOf(body?.["person"]);
        if (typeof person === "string") return refusal(400, person);
        const decoded = exportOf({ threadId: body?.["threadId"] });
        if (Option.isNone(decoded)) return refusal(400, "`threadId` is a thread's id");
        const { threadId } = decoded.value;
        if (!(yield* reaches(person.id, threadId))) return refusal(404, "there is no such thread");
        return yield* asPerson(
          person,
          "thread.export",
          { threadId },
          transfer.exportThread({ threadId }),
        ).pipe(
          Effect.map((bundle) => answer({ bundle: encodeBundle(bundle) })),
          Effect.catch((error: { readonly message?: string }) =>
            Effect.succeed(refusal(409, error.message ?? "the thread can't go now")),
          ),
        );
      }),
    );

    yield* inbound.route("POST", "thread-settles", (body) =>
      Effect.gen(function* () {
        const person = personOf(body?.["person"]);
        if (typeof person === "string") return refusal(400, person);
        const decoded = settleOf({
          threadId: body?.["threadId"],
          exportedAt: body?.["exportedAt"],
          to: body?.["to"],
        });
        if (Option.isNone(decoded))
          return refusal(400, "`threadId`, `exportedAt` and `to` say which export went where");
        const { threadId } = decoded.value;
        if (!(yield* reaches(person.id, threadId))) return refusal(404, "there is no such thread");
        if (decoded.value.exportedAt > Date.now())
          return refusal(400, "`exportedAt` is when the thread was exported, not later");
        return yield* asPerson(
          person,
          "thread.settle",
          { threadId, to: decoded.value.to },
          transfer.settleThread(decoded.value, person.id),
        ).pipe(
          Effect.map(() => answer({ settled: true })),
          Effect.catch((error: { readonly message?: string }) =>
            Effect.succeed(refusal(409, error.message ?? "the thread can't settle now")),
          ),
        );
      }),
    );

    yield* inbound.route(
      "POST",
      "thread-imports",
      (body) =>
        Effect.gen(function* () {
          const person = personOf(body?.["person"]);
          if (typeof person === "string") return refusal(400, person);
          const decoded = from({ bundle: body?.["bundle"], from: body?.["from"] });
          if (Option.isNone(decoded))
            return refusal(400, "`bundle` is a thread bundle and `from` names where it was");
          const { bundle } = decoded.value;
          const before = yield* store
            .movedThreadConflict(bundle.thread.id, [])
            .pipe(Effect.orElseSucceed(() => "unknown"));
          const imported = transfer
            .importThreadFor({ bundle, from: decoded.value.from, person: person.id })
            .pipe(
              Effect.tap(({ thread }) =>
                store.appendActorEvents(
                  actorEventsOf(
                    person,
                    "thread.import",
                    { threadId: thread.id, from: decoded.value.from },
                    Date.now(),
                  ),
                ),
              ),
              Effect.provideService(ActingPerson, person.id),
              Effect.provideService(RoutedFor, { person: person.id }),
            );
          return yield* imported.pipe(
            Effect.map(({ thread, notes }) => answer({ threadId: thread.id, notes })),
            Effect.catch((error: { readonly message?: string }) =>
              store.movedThreadConflict(bundle.thread.id, []).pipe(
                Effect.orElseSucceed(() => undefined),
                Effect.map((here) => ({
                  status: 409,
                  body: {
                    error: error.message ?? "the thread couldn't come in now",
                    ...(here === undefined || before !== undefined
                      ? {}
                      : { threadId: bundle.thread.id }),
                  },
                })),
              ),
            ),
          );
        }),
      { maxBytes: THREAD_IMPORT_MAX_BYTES },
    );
  }),
);
