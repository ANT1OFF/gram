import {
  AppToolError,
  DOC_MAX_BYTES,
  DOC_TITLE_MAX,
  DocId,
  type DocCardData,
  type GramUIMessageChunk,
  type Thread,
  type ThreadId,
  type WorkspaceId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Docs, type DocsShape, type PublishedDoc } from "../docs/docs.ts";
import { ThreadStore, type ThreadStoreShape } from "../persistence/thread-store.ts";
import { ThreadRuntimes, type ThreadRuntimesShape } from "../runtime/thread-runtimes.ts";
import { defineAppTool, failed } from "./definition.ts";
import { AppToolRegistry } from "./registry.ts";

const PUBLISH = "publish_doc";
const READ = "read_doc";

const NOT_IN_WORKSPACE =
  "Docs belong to a workspace, and this thread isn't in one. Write the file in your checkout " +
  "instead, or show it with send_file.";

/** The calling thread and the workspace it is in, or the refusal for a thread in none. */
const callerIn = (store: Pick<ThreadStoreShape, "getThread">, tool: string, threadId: ThreadId) =>
  Effect.gen(function* () {
    const thread = yield* store
      .getThread(threadId)
      .pipe(
        Effect.mapError(() => new AppToolError({ tool, message: `unknown thread ${threadId}` })),
      );
    if (thread.workspaceId === undefined) {
      return yield* new AppToolError({ tool, message: NOT_IN_WORKSPACE });
    }
    return { thread, workspaceId: thread.workspaceId };
  });

const cardOf = (published: PublishedDoc, at: number): DocCardData => ({
  id: published.meta.id,
  workspaceId: published.meta.workspaceId,
  title: published.meta.title,
  authorThreadId: published.meta.authorThreadId,
  authorTitle: published.meta.authorTitle,
  action: published.action,
  revision: published.meta.revision,
  at,
  excerpt: published.meta.excerpt,
});

/**
 * The card in the caller's transcript, and in its orchestrator's chat when a worker published, so
 * the orchestrator's user sees the doc land without opening the worker. Each card is its own part
 * (`doc:<id>:<revision>`): an update leaves a card where it happened.
 */
const showCards = (
  runtimes: Pick<ThreadRuntimesShape, "emitChunk">,
  caller: Thread,
  card: DocCardData,
) =>
  Effect.gen(function* () {
    const chunk: GramUIMessageChunk = {
      type: "data-doc",
      id: `doc:${card.id}:${card.revision}`,
      data: card,
    };
    yield* runtimes.emitChunk(caller.id, chunk).pipe(Effect.mapError(failed(PUBLISH)));
    const orchestrator = caller.role === "orchestrator" ? undefined : caller.spawnedBy?.threadId;
    if (orchestrator === undefined) return false;
    // The orchestrator may be gone; the doc and the worker's card stand without its copy.
    return yield* runtimes.emitChunk(orchestrator, chunk).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  });

const publishInput = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  content: Schema.String,
  id: Schema.optionalKey(DocId),
  revision: Schema.optionalKey(Schema.Int),
});

/**
 * `publish_doc`: writes a report, plan or analysis as Markdown into the workspace's docs, in Gram's
 * own state (never the repo, never uploaded), and shows it as a card the user opens in the doc
 * pane. An update names the doc and the revision it last saw, so it can't overwrite the user's
 * edit made since. Only the doc's author or the workspace's orchestrator may update a doc.
 */
/** How many of the caller's earlier docs a new publish names back to it. */
const EARLIER_DOCS_MAX = 5;

export const publishDocTool = (
  docs: Pick<DocsShape, "publish" | "list">,
  store: Pick<ThreadStoreShape, "getThread">,
  runtimes: Pick<ThreadRuntimesShape, "emitChunk">,
) =>
  defineAppTool({
    descriptor: {
      name: PUBLISH,
      class: "self",
      description:
        "Publish a document (a report, plan, analysis or write-up) for the user to read as a doc " +
        "card, which opens in Gram's doc pane where they can read and edit it. It is Markdown " +
        "(headings, lists, tables, code) kept in Gram's own state for this workspace: not written " +
        "to any repo and not uploaded anywhere, unlike claude.ai's Artifact. A new doc takes " +
        `\`title\` (at most ${DOC_TITLE_MAX} characters) and \`content\` (at most ` +
        `${DOC_MAX_BYTES / 1024} KB). To update one, pass its \`id\` and the \`revision\` this ` +
        "tool or read_doc last gave you, with the whole new `content`; a revision that moved on " +
        "means the user edited it since, so read_doc it and work their edit in. You may update the " +
        "docs you published; an orchestrator may update its workers' docs too. A later pass on the " +
        "same subject (a re-review, a second version of a report) updates the doc you already " +
        "published, by its `id`, so the user has one doc per subject and not a pile of versions; " +
        "publish a new doc only for a new subject.",
    },
    input: publishInput,
    rejectExcessProperties: true,
    handle: (threadId, input) =>
      Effect.gen(function* () {
        const { thread, workspaceId } = yield* callerIn(store, PUBLISH, threadId);
        const published = yield* docs
          .publish({
            workspaceId,
            author: {
              threadId,
              title: thread.title,
              orchestrator: thread.role === "orchestrator",
            },
            id: input.id,
            title: input.title,
            content: input.content,
            revision: input.revision,
          })
          .pipe(Effect.mapError(failed(PUBLISH)));
        const card = cardOf(published, published.meta.updatedAt);
        const relayed = yield* showCards(runtimes, thread, card);
        // A new doc from a thread that has published before: its earlier ones, so the next pass
        // on the same subject updates one of them rather than adding a version beside it.
        const earlier =
          published.action === "published"
            ? (yield* docs.list(workspaceId).pipe(Effect.orElseSucceed(() => [])))
                .filter((doc) => doc.authorThreadId === threadId && doc.id !== published.meta.id)
                .slice(0, EARLIER_DOCS_MAX)
                .map((doc) => ({ id: doc.id, title: doc.title, revision: doc.revision }))
            : [];
        return {
          id: published.meta.id,
          title: published.meta.title,
          revision: published.meta.revision,
          [published.action]: true,
          shown: relayed
            ? "as a card in your transcript and your orchestrator's chat"
            : "as a card in your transcript",
          next: `To update it, call ${PUBLISH} with id "${published.meta.id}" and revision ${published.meta.revision}.`,
          ...(earlier.length === 0
            ? {}
            : {
                earlier,
                note: "You published these before. A later pass on the same subject updates that doc by its id; a new doc is for a new subject.",
              }),
        };
      }),
  });

const readInput = Schema.Struct({ id: Schema.optionalKey(DocId) });

/** `read_doc`: the workspace's docs, or one doc's Markdown and revision, the user's edits included. */
export const readDocTool = (
  docs: Pick<DocsShape, "list" | "read">,
  store: Pick<ThreadStoreShape, "getThread">,
) =>
  defineAppTool({
    descriptor: {
      name: READ,
      class: "self",
      description:
        "Read this workspace's docs (published with publish_doc). Without `id`, lists them: id, " +
        "title, author, revision and when and by whom each was last saved. With `id`, returns that " +
        "doc's Markdown and its current revision, the user's edits included; pass that revision " +
        "to publish_doc to update it.",
    },
    input: readInput,
    rejectExcessProperties: true,
    handle: (threadId, { id }) =>
      Effect.gen(function* () {
        const { workspaceId } = yield* callerIn(store, READ, threadId);
        if (id === undefined) {
          const list = yield* docs.list(workspaceId).pipe(Effect.mapError(failed(READ)));
          return {
            docs: list.map((doc) => ({
              id: doc.id,
              title: doc.title,
              author: doc.authorTitle,
              yours: doc.authorThreadId === threadId,
              revision: doc.revision,
              updatedAt: new Date(doc.updatedAt).toISOString(),
              updatedBy: doc.updatedBy,
            })),
          };
        }
        const doc = yield* docs
          .read(workspaceId as WorkspaceId, id)
          .pipe(Effect.mapError(failed(READ)));
        return {
          id: doc.id,
          title: doc.title,
          author: doc.authorTitle,
          revision: doc.revision,
          updatedAt: new Date(doc.updatedAt).toISOString(),
          updatedBy: doc.updatedBy,
          content: doc.content,
        };
      }),
  });

/** Registers `publish_doc` and `read_doc` over the workspace docs. */
export const DocAppToolsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* AppToolRegistry;
    const docs = yield* Docs;
    const store = yield* ThreadStore;
    const runtimes = yield* ThreadRuntimes;
    yield* registry.register([publishDocTool(docs, store, runtimes), readDocTool(docs, store)]);
  }),
);
