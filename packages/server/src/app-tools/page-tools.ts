import { AppToolError, PageId, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { pageEntryOf } from "../pages/entry.ts";
import { Pages, type PagesShape } from "../pages/pages.ts";
import { ThreadStore, type ThreadStoreShape } from "../persistence/thread-store.ts";
import { defineAppTool, failed } from "./definition.ts";
import { AppToolRegistry } from "./registry.ts";

const OFFER = "offer_page_version";

const offerInput = Schema.Struct({ page: Schema.String, path: Schema.String });

/**
 * `offer_page_version`: an agent's one way to change a pinned page, and it changes nothing the user
 * sees until they choose to. The file's folder is copied beside the shown version, and the page
 * says "Newer version" with a Show it the user presses or not. No tool pins, shows or unpins.
 */
export const offerPageTool = (
  pages: Pick<PagesShape, "list" | "offer">,
  store: Pick<ThreadStoreShape, "getThread">,
) =>
  defineAppTool({
    descriptor: {
      name: OFFER,
      class: "self",
      description:
        "Offer a new version of a page the user pinned: `path` is an HTML file in your folders, " +
        "copied with the files beside it. The page keeps its version until the user shows yours. " +
        "An unknown `page` id lists the pinned pages. Pinned pages throw on document.write and " +
        "document.open: build them with DOM APIs.",
    },
    input: offerInput,
    rejectExcessProperties: true,
    audience: ["plain", "worker"],
    handle: (threadId: ThreadId, input) =>
      Effect.gen(function* () {
        const thread = yield* store
          .getThread(threadId)
          .pipe(
            Effect.mapError(
              () => new AppToolError({ tool: OFFER, message: `unknown thread ${threadId}` }),
            ),
          );
        const workspaceId = thread.workspaceId;
        if (workspaceId === undefined) {
          return yield* new AppToolError({
            tool: OFFER,
            message: "Pages belong to a workspace, and this thread isn't in one.",
          });
        }
        const pinned = yield* pages.list(workspaceId).pipe(Effect.mapError(failed(OFFER)));
        const page = pinned.find((meta) => meta.id === input.page);
        if (page === undefined || !Schema.is(PageId)(input.page)) {
          return yield* new AppToolError({
            tool: OFFER,
            message:
              pinned.length === 0
                ? "No page is pinned in this workspace. The user pins one from the Preview tab."
                : `No pinned page ${JSON.stringify(input.page)}. Pinned: ${pinned
                    .map((meta) => `${meta.id} (${JSON.stringify(meta.title)})`)
                    .join(", ")}`,
          });
        }
        const entry = yield* pageEntryOf(thread, input.path).pipe(Effect.mapError(failed(OFFER)));
        const offered = yield* pages
          .offer({ workspaceId, id: page.id, by: { threadId, title: thread.title }, entry })
          .pipe(Effect.mapError(failed(OFFER)));
        return {
          page: offered.id,
          offered: offered.offer?.version,
          shown: offered.version,
          note: "Copied. The user's page still shows its version, with a notice to show yours.",
        };
      }),
  });

/** Registers `offer_page_version`. */
export const PageAppToolsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* AppToolRegistry;
    yield* registry.register([offerPageTool(yield* Pages, yield* ThreadStore)]);
  }),
);
