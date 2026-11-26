import {
  AppToolError,
  DOC_HISTORY_KEEP,
  DOC_LIST_MAX,
  DOC_MAX_BYTES,
  DOC_PR_REPO_PATTERN,
  DocPr,
  DOC_TITLE_MAX,
  DocId,
  type DocCardData,
  type DocMeta,
  type GramUIMessageChunk,
  type Thread,
  type ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Docs, type DocAuthor, type DocsShape, type PublishedDoc } from "../docs/docs.ts";
import { ThreadStore, type ThreadStoreShape } from "../persistence/thread-store.ts";
import { ThreadRuntimes, type ThreadRuntimesShape } from "../runtime/thread-runtimes.ts";
import { defineAppTool, failed } from "./definition.ts";
import { AppToolRegistry } from "./registry.ts";

const PUBLISH = "publish_doc";
const READ = "read_doc";
const ARCHIVE = "archive_doc";
const DELETE = "delete_doc";

const NOT_IN_WORKSPACE =
  "Docs belong to a workspace, and this thread isn't in one. Write the file in your checkout " +
  "instead, or show it with send_file.";

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

const authorOf = (thread: Thread): DocAuthor => ({
  threadId: thread.id,
  title: thread.title,
  orchestrator: thread.role === "orchestrator",
  worker: thread.role !== "orchestrator" && thread.spawnedBy !== undefined,
});

const prOfThread = (thread: Thread): DocPr | undefined =>
  thread.boundPr === undefined || !DOC_PR_REPO_PATTERN.test(thread.boundPr.repo)
    ? undefined
    : { repo: thread.boundPr.repo, number: thread.boundPr.number };

const prText = (pr: DocPr) => `${pr.repo}#${pr.number}`;

const cardOf = (
  published: PublishedDoc & { readonly action: "published" | "updated" },
  at: number,
): DocCardData => ({
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
  pr: Schema.optionalKey(Schema.NullOr(DocPr)),
});

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
        "Publish a document (a report, plan, analysis or write-up) as a doc card the user reads " +
        "and edits in Gram's doc pane. It is Markdown kept in Gram's own state for this " +
        "workspace: not written to any repo and not uploaded anywhere, unlike claude.ai's " +
        `Artifact. A new doc takes \`title\` (at most ${DOC_TITLE_MAX} characters) and \`content\` ` +
        `(at most ${DOC_MAX_BYTES / 1024} KB). To update one, pass its \`id\` and the \`revision\` ` +
        "this tool or read_doc last gave you, with the whole new `content`; if the revision " +
        "moved on, the user edited it: read_doc it and work their edit in. A later pass on one " +
        "subject (a re-review, a new version) updates that doc; a new doc is for a new subject. " +
        "You may update your own docs; an orchestrator its workers' too. A new doc is about your " +
        'bound PR, or the one `pr` ({repo: "owner/repo", number}) names when you review ' +
        "another's; `pr: null` binds none. A workspace keeps one active doc per PR: publishing " +
        "another for it writes nothing and returns that doc's id and revision. Any thread in the " +
        "workspace may update a PR's doc: read_doc it and add your round as a new section at the " +
        "top, newest first, keeping the rounds before it.",
    },
    input: publishInput,
    rejectExcessProperties: true,
    handle: (threadId, input) =>
      Effect.gen(function* () {
        const { thread, workspaceId } = yield* callerIn(store, PUBLISH, threadId);
        if (input.id !== undefined && input.pr !== undefined) {
          return yield* new AppToolError({
            tool: PUBLISH,
            message: "`pr` names the PR a new doc is about; an update keeps the doc's own.",
          });
        }
        const pr =
          input.id !== undefined || input.pr === null
            ? undefined
            : (input.pr ?? prOfThread(thread));
        const published = yield* docs
          .publish({
            workspaceId,
            author: authorOf(thread),
            id: input.id,
            title: input.title,
            content: input.content,
            revision: input.revision,
            pr,
          })
          .pipe(Effect.mapError(failed(PUBLISH)));
        if (published.action === "existing") {
          const doc = published.meta;
          return {
            id: doc.id,
            title: doc.title,
            revision: doc.revision,
            existing: true,
            published: false,
            pr: prText(pr!),
            note: `${prText(pr!)} already has a doc, ${doc.title}, so nothing was published.`,
            next:
              `Fold your round into it: read_doc id "${doc.id}", put your round at the top as a ` +
              `new section, newest first, and call ${PUBLISH} with id "${doc.id}", revision ` +
              `${doc.revision} and the whole content. If yours is about another subject, not ` +
              `a round on this PR, call ${PUBLISH} again with \`pr: null\`.`,
          };
        }
        const card = cardOf(published, published.meta.updatedAt);
        const relayed = yield* showCards(runtimes, thread, card);
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
          ...(published.meta.pr === undefined ? {} : { pr: prText(published.meta.pr) }),
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

const readInput = Schema.Struct({
  id: Schema.optionalKey(DocId),
  revision: Schema.optionalKey(Schema.Int),
  archived: Schema.optionalKey(Schema.Boolean),
  query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
});

const archivedOf = (doc: DocMeta) =>
  doc.archivedAt === undefined
    ? {}
    : {
        archivedAt: new Date(doc.archivedAt).toISOString(),
        archivedReason: doc.archivedReason ?? "manual",
      };

const matches = (doc: DocMeta, query: string) => {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");
  const title = doc.title.toLowerCase();
  return doc.id === query.trim() || words.every((word) => title.includes(word));
};

/**
 * `read_doc`: a listing of the workspace's active docs (or its archive), at most `DOC_LIST_MAX`
 * and the rest counted, or one doc's Markdown and revision, the user's edits included.
 */
export const readDocTool = (
  docs: Pick<DocsShape, "list" | "listArchived" | "counts" | "read" | "history">,
  store: Pick<ThreadStoreShape, "getThread">,
) =>
  defineAppTool({
    descriptor: {
      name: READ,
      class: "self",
      description:
        "Read this workspace's docs (published with publish_doc). Without `id`, lists the active " +
        `docs, newest first, at most ${DOC_LIST_MAX}, with counts of the rest: id, title, author, ` +
        "revision and when and by whom each was last saved. `query` keeps those whose title has " +
        "its words; `archived: true` lists the archive instead. With `id`, returns that doc's " +
        "Markdown and its current revision, the user's edits included, archived or not; pass " +
        `that revision to publish_doc to update it. The ${DOC_HISTORY_KEEP} versions before ` +
        "it are kept: `earlierRevisions` names them and `revision` reads one.",
    },
    input: readInput,
    rejectExcessProperties: true,
    handle: (threadId, { id, revision, archived, query }) =>
      Effect.gen(function* () {
        const { workspaceId } = yield* callerIn(store, READ, threadId);
        if (id === undefined) {
          if (revision !== undefined) {
            return yield* new AppToolError({
              tool: READ,
              message: "`revision` reads an earlier version of one doc: pass its `id` too.",
            });
          }
          const all = yield* (
            archived === true ? docs.listArchived(workspaceId) : docs.list(workspaceId)
          ).pipe(Effect.mapError(failed(READ)));
          const counts = yield* docs.counts(workspaceId).pipe(Effect.mapError(failed(READ)));
          const found =
            query === undefined || query.trim() === ""
              ? all
              : all.filter((doc) => matches(doc, query));
          const shown = found.slice(0, DOC_LIST_MAX);
          const more = found.length - shown.length;
          return {
            docs: shown.map((doc) => ({
              id: doc.id,
              title: doc.title,
              author: doc.authorTitle,
              yours: doc.authorThreadId === threadId,
              revision: doc.revision,
              updatedAt: new Date(doc.updatedAt).toISOString(),
              updatedBy: doc.updatedBy,
              ...(doc.pr === undefined ? {} : { pr: prText(doc.pr) }),
              ...archivedOf(doc),
            })),
            active: archived === true ? counts.active : all.length,
            archived: archived === true ? all.length : counts.archived,
            ...(query === undefined ? {} : { matched: found.length }),
            ...(more > 0
              ? {
                  more,
                  note: `${more} more not listed. Pass \`query\` with words from the title to find one.`,
                }
              : {}),
          };
        }
        const doc = yield* docs.read(workspaceId, id, revision).pipe(Effect.mapError(failed(READ)));
        const earlier = yield* docs.history(workspaceId, id).pipe(Effect.orElseSucceed(() => []));
        return {
          id: doc.id,
          title: doc.title,
          author: doc.authorTitle,
          revision: doc.revision,
          updatedAt: new Date(doc.updatedAt).toISOString(),
          updatedBy: doc.updatedBy,
          ...(doc.pr === undefined ? {} : { pr: prText(doc.pr) }),
          ...archivedOf(doc),
          ...(earlier.length === 0 ? {} : { earlierRevisions: earlier }),
          content: doc.content,
        };
      }),
  });

const archiveInput = Schema.Struct({ id: DocId, restore: Schema.optionalKey(Schema.Boolean) });

/** `archive_doc`: moves a doc to the workspace's archive, or with `restore` back out of it. */
export const archiveDocTool = (
  docs: Pick<DocsShape, "archive" | "restore">,
  store: Pick<ThreadStoreShape, "getThread">,
) =>
  defineAppTool({
    descriptor: {
      name: ARCHIVE,
      class: "self",
      description:
        "Archive a doc you're done with: it leaves the doc pane's list and read_doc's listing, " +
        "and stops counting toward the workspace's active docs, but read_doc still reads it by " +
        "`id` and lists it with `archived: true`. `restore: true` brings an archived doc back. " +
        "You may archive and restore your own docs; an orchestrator its workers' too.",
    },
    input: archiveInput,
    rejectExcessProperties: true,
    handle: (threadId, { id, restore }) =>
      Effect.gen(function* () {
        const { thread, workspaceId } = yield* callerIn(store, ARCHIVE, threadId);
        const by = authorOf(thread);
        if (restore === true) {
          const meta = yield* docs
            .restore(workspaceId, id, by)
            .pipe(Effect.mapError(failed(ARCHIVE)));
          return { id: meta.id, title: meta.title, revision: meta.revision, restored: true };
        }
        const meta = yield* docs
          .archive(workspaceId, id, by, "manual")
          .pipe(Effect.mapError(failed(ARCHIVE)));
        return {
          id: meta.id,
          title: meta.title,
          archived: true,
          next: `To bring it back, call ${ARCHIVE} with id "${meta.id}" and restore: true.`,
        };
      }),
  });

/** `delete_doc`: the orchestrator's permanent removal of a doc it, or a worker, archived. */
export const deleteDocTool = (
  docs: Pick<DocsShape, "remove">,
  store: Pick<ThreadStoreShape, "getThread">,
) =>
  defineAppTool({
    descriptor: {
      name: DELETE,
      class: "self",
      description:
        "Delete an archived doc for good, with its earlier versions. Only an archived doc can " +
        "be deleted: archive it with archive_doc first. Archiving is usually enough, since the " +
        "archive keeps the oldest docs only until it is full.",
    },
    audience: ["orchestrator"],
    input: Schema.Struct({ id: DocId }),
    rejectExcessProperties: true,
    handle: (threadId, { id }) =>
      Effect.gen(function* () {
        const { thread, workspaceId } = yield* callerIn(store, DELETE, threadId);
        yield* docs.remove(workspaceId, id, authorOf(thread)).pipe(Effect.mapError(failed(DELETE)));
        return { id, deleted: true };
      }),
  });

/** Registers the doc tools over the workspace docs. */
export const DocAppToolsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* AppToolRegistry;
    const docs = yield* Docs;
    const store = yield* ThreadStore;
    const runtimes = yield* ThreadRuntimes;
    yield* registry.register([
      publishDocTool(docs, store, runtimes),
      readDocTool(docs, store),
      archiveDocTool(docs, store),
      deleteDocTool(docs, store),
    ]);
  }),
);
