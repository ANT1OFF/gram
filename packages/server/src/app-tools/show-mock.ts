import { AppToolError, checkoutRoots, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { randomUUID } from "node:crypto";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import { mockCard } from "../preview/mocks.ts";
import type { ThreadRuntimesShape } from "../runtime/thread-runtimes.ts";
import { defineAppTool } from "./definition.ts";

const fail = (message: string) => new AppToolError({ tool: "show_mock", message });

/**
 * `show_mock`: puts a mock in front of the user as a card in the reply rather than a path: its
 * title and version, a thumbnail per direction from its `shots/` (dark and light when both were
 * taken) and Open in Preview. The card is built here, from the mock kit's `mock.json`, with every
 * path confined to the thread's folders (`mockCard`), and carried as a `mock` data part.
 */
export const showMockTool = (
  runtimes: Pick<ThreadRuntimesShape, "emitChunk">,
  store: Pick<ThreadStoreShape, "getThread">,
) =>
  defineAppTool({
    descriptor: {
      name: "show_mock",
      class: "self",
      description:
        "Show the user a UI mock as a card in your reply, instead of its path: its title and version, a thumbnail per direction (dark and light when both screenshots exist) and Open in Preview. `path` is the mock's mock.json, its folder under docs/design/mocks, or one of its version pages; relative to your folder or absolute, inside your worktree or repo. Directions come from mock.json's `directions` ({name, board, shots: {dark, light}}) or else from the files in its shots/. `version` picks a version other than the current one. An orchestrator can show a worker's mock from that worker's worktree to relay it.",
    },
    input: Schema.Struct({
      path: Schema.NonEmptyString,
      version: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
    }),
    handle: (threadId: ThreadId, { path, version }) =>
      Effect.gen(function* () {
        const thread = yield* store
          .getThread(threadId)
          .pipe(Effect.mapError(() => fail(`unknown thread ${threadId}`)));
        const card = yield* mockCard(path, checkoutRoots(thread), version).pipe(
          Effect.mapError((refused) => fail(refused.message)),
        );
        yield* runtimes
          .emitChunk(threadId, { type: "data-mock", id: randomUUID(), data: card })
          .pipe(Effect.mapError(() => fail(`unknown thread ${threadId}`)));
        return {
          shown: card.title,
          ...(card.version === undefined ? {} : { version: card.version }),
          directions: card.directions.map((direction) => ({
            name: direction.name,
            themes: Object.keys(direction.shots),
          })),
        };
      }),
  });
