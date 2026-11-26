import {
  type Doc,
  type DocArchiveReason,
  type DocPr,
  DOC_HISTORY_KEEP,
  DOC_MAX_BYTES,
  type DocEditor,
  docExcerpt,
  type DocId,
  type DocMeta,
  DOCS_ARCHIVE_MAX,
  DOCS_PER_WORKSPACE_MAX,
  docTitle,
  docsArchiveOf,
  sameDocPr,
  type FsError,
  type InvalidState,
  NotFound,
  redactText,
  type WorkspaceId,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { join } from "node:path";

import { ServerConfig } from "../config.ts";
import { EventHub } from "../events/event-hub.ts";
import { makeKeyedLock } from "../git/keyed-lock.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import {
  listPinned,
  openFolder,
  readPinned,
  unlinkPinned,
  writePinned,
  type DocFileHooks,
  type DocFolder,
} from "./doc-files.ts";
import {
  activeOf,
  archivedAtOf,
  archivedRefusal,
  archiveOf,
  checkContent,
  checkedId,
  HEAD_MAX,
  historyIn,
  historyOf,
  idsIn,
  isAuthor,
  kb,
  metaOf,
  newDocId,
  notFound,
  notYours,
  purge,
  RECORD,
  RECORD_MAX,
  recordName,
  recordOf,
  refuse,
  run,
  unreadable,
  type DocActor,
  type DocAuthor,
} from "./doc-records.ts";

export { newDocId, type DocActor, type DocAuthor } from "./doc-records.ts";

const WORKSPACE_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

export type DocError = InvalidState | NotFound | FsError;

export interface PublishDocInput {
  readonly workspaceId: WorkspaceId;
  readonly author: DocAuthor;
  /** Absent to publish a new doc; an existing one's id to update it. */
  readonly id?: DocId | undefined;
  /** Required for a new doc; an update keeps its title unless given. */
  readonly title?: string | undefined;
  readonly content: string;
  /** For an update: the revision the agent last published or read, which must still be current. */
  readonly revision?: number | undefined;
  /**
   * For a new doc: the PR it is about. When the workspace already has an active doc for that PR,
   * nothing is written and that doc comes back (`existing`), for the round to be folded into it.
   */
  readonly pr?: DocPr | undefined;
}

export type PublishedDoc =
  | { readonly meta: DocMeta; readonly action: "published" | "updated" }
  | { readonly meta: DocMeta; readonly action: "existing" };

/** How many docs a workspace holds, from the folders' names alone. */
export interface DocCounts {
  readonly active: number;
  readonly archived: number;
}

export interface DocsShape {
  /** The workspace's active docs, newest first. A metadata file that doesn't decode is left out. */
  readonly list: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<DocMeta>, InvalidState | FsError>;
  /** Its archived docs, the latest archived first. */
  readonly listArchived: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<DocMeta>, InvalidState | FsError>;
  readonly counts: (workspaceId: WorkspaceId) => Effect.Effect<DocCounts, InvalidState | FsError>;
  /**
   * A doc, active or archived (`archivedAt` says which). With `revision`, that kept version of it:
   * the current one or one of its `history`.
   */
  readonly read: (
    workspaceId: WorkspaceId,
    id: DocId,
    revision?: number,
  ) => Effect.Effect<Doc, DocError>;
  /** The revisions kept of a doc's earlier versions, newest first. */
  readonly history: (
    workspaceId: WorkspaceId,
    id: DocId,
  ) => Effect.Effect<ReadonlyArray<number>, InvalidState | FsError>;
  /** An agent's publish or update; tells the workspace's clients. */
  readonly publish: (input: PublishDocInput) => Effect.Effect<PublishedDoc, DocError>;
  /** The user's edit from the doc pane, over the revision it opened; tells the clients. */
  readonly save: (
    workspaceId: WorkspaceId,
    id: DocId,
    content: string,
    revision: number,
  ) => Effect.Effect<DocMeta, DocError>;
  /**
   * Moves an active doc to the archive, for its author, the orchestrator or the user; past
   * `archiveMax` the oldest archived docs are purged. Tells the clients.
   */
  readonly archive: (
    workspaceId: WorkspaceId,
    id: DocId,
    by: DocActor,
    reason: DocArchiveReason,
  ) => Effect.Effect<DocMeta, DocError>;
  /** Moves an archived doc back, for the same people; refused while the active docs are full. */
  readonly restore: (
    workspaceId: WorkspaceId,
    id: DocId,
    by: DocActor,
  ) => Effect.Effect<DocMeta, DocError>;
  /** Deletes an archived doc and its history for good, for the orchestrator or the user only. */
  readonly remove: (
    workspaceId: WorkspaceId,
    id: DocId,
    by: DocActor,
  ) => Effect.Effect<void, DocError>;
  /**
   * The sweep's archive: the doc is read again under the lock and archived only while `due` still
   * holds of it, so a user's open or an agent's update since the sweep looked keeps it. `undefined`
   * when it no longer was due, or is gone.
   */
  readonly archiveIfDue: (
    workspaceId: WorkspaceId,
    id: DocId,
    reason: DocArchiveReason,
    due: (meta: DocMeta) => boolean,
  ) => Effect.Effect<DocMeta | undefined, DocError>;
  /**
   * Changes an active doc's metadata alone, under the lock: no revision, history or event, and
   * the text as it was. `change` returning `undefined` writes nothing.
   */
  readonly mark: (
    workspaceId: WorkspaceId,
    id: DocId,
    change: (meta: DocMeta) => DocMeta | undefined,
  ) => Effect.Effect<void, InvalidState | FsError>;
}

/** Limits a test can lower; `archiveKeep` is the user's "Keep archived docs", read per archive. */
export interface DocLimits {
  readonly activeMax?: number;
  readonly archiveMax?: number;
  readonly archiveKeep?: Effect.Effect<number>;
  readonly historyKeep?: number;
}

/**
 * The docs under `root`, one folder per workspace, its archive and its docs' histories inside.
 * `hooks` are tests' racing writer and full disk; `limits` lets a test lower the caps.
 */
export const makeDocs = (
  root: string,
  publishChanged: (workspaceId: WorkspaceId) => Effect.Effect<void>,
  hooks?: DocFileHooks,
  limits: DocLimits = {},
): DocsShape => {
  const locks = makeKeyedLock<string>();
  const activeMax = limits.activeMax ?? DOCS_PER_WORKSPACE_MAX;
  const archiveMaxNow =
    limits.archiveMax !== undefined
      ? Effect.succeed(limits.archiveMax)
      : (limits.archiveKeep ?? Effect.succeed(DOCS_ARCHIVE_MAX));
  const historyKeep = limits.historyKeep ?? DOC_HISTORY_KEEP;

  const folder = (workspaceId: WorkspaceId, create: boolean) =>
    WORKSPACE_SEGMENT.test(workspaceId)
      ? run("folder", () => openFolder(root, workspaceId, create))
      : Effect.fail(refuse("That isn't a workspace docs can be kept for"));

  const readHead = (at: DocFolder, workspaceId: WorkspaceId, id: DocId) =>
    Effect.gen(function* () {
      const head = yield* run(id, () =>
        readPinned(at, recordName(id), HEAD_MAX, { whole: false, hooks }),
      );
      if (head._tag === "Missing") return undefined;
      if (head._tag !== "Read") return yield* unreadable(id);
      return metaOf(head.text, workspaceId, id) ?? (yield* unreadable(id));
    });

  const listIn = (at: DocFolder, workspaceId: WorkspaceId) =>
    Effect.gen(function* () {
      const names = yield* run("folder", () => listPinned(at));
      const docs: DocMeta[] = [];
      for (const id of idsIn(names)) {
        const meta = yield* readHead(at, workspaceId, id).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        );
        if (meta !== undefined) docs.push(meta);
      }
      return docs.toSorted((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    });

  const listArchivedIn = (at: DocFolder, workspaceId: WorkspaceId) =>
    Effect.gen(function* () {
      const arch = yield* archiveOf(at, false);
      if (arch === undefined) return [];
      const active = new Set(idsIn(yield* run("folder", () => listPinned(at))));
      return (yield* listIn(arch, workspaceId))
        .filter((meta) => !active.has(meta.id))
        .toSorted(
          (a, b) =>
            archivedAtOf(b) - archivedAtOf(a) ||
            b.updatedAt - a.updatedAt ||
            a.id.localeCompare(b.id),
        );
    });

  const list: DocsShape["list"] = (workspaceId) =>
    Effect.gen(function* () {
      const at = yield* folder(workspaceId, false);
      return at === undefined ? [] : yield* listIn(at, workspaceId);
    });

  const listArchived: DocsShape["listArchived"] = (workspaceId) =>
    Effect.gen(function* () {
      const at = yield* folder(workspaceId, false);
      return at === undefined ? [] : yield* listArchivedIn(at, workspaceId);
    });

  const counts: DocsShape["counts"] = (workspaceId) =>
    Effect.gen(function* () {
      const at = yield* folder(workspaceId, false);
      if (at === undefined) return { active: 0, archived: 0 };
      const active = new Set(idsIn(yield* run("folder", () => listPinned(at))));
      const arch = yield* archiveOf(at, false);
      const archived =
        arch === undefined
          ? 0
          : idsIn(yield* run("archive", () => listPinned(arch))).filter((id) => !active.has(id))
              .length;
      return { active: active.size, archived };
    });

  const readDoc = (at: DocFolder, workspaceId: WorkspaceId, id: DocId, name = recordName(id)) =>
    Effect.gen(function* () {
      const record = yield* run(id, () => readPinned(at, name, RECORD_MAX, { whole: true, hooks }));
      switch (record._tag) {
        case "Missing":
          return undefined;
        case "NotPlain":
          return yield* refuse(`The doc ${id} isn't a plain file, so it wasn't read`);
        case "TooBig":
          return yield* refuse(`The doc ${id} is past ${kb(DOC_MAX_BYTES)}, so it wasn't read`);
        case "Read":
          break;
      }
      const meta = metaOf(record.text, workspaceId, id);
      if (meta === undefined) return yield* unreadable(id);
      const content = record.text.slice(record.text.indexOf("\n") + 1);
      if (Buffer.byteLength(content, "utf8") !== meta.bytes) return yield* unreadable(id);
      return { ...meta, content } satisfies Doc;
    });

  const findDoc = (at: DocFolder, workspaceId: WorkspaceId, id: DocId) =>
    Effect.gen(function* () {
      const active = yield* readDoc(at, workspaceId, id);
      if (active !== undefined) return active;
      const arch = yield* archiveOf(at, false);
      return arch === undefined ? undefined : yield* readDoc(arch, workspaceId, id);
    });

  const archivedHead = (at: DocFolder, workspaceId: WorkspaceId, id: DocId) =>
    Effect.gen(function* () {
      const arch = yield* archiveOf(at, false);
      return arch === undefined ? undefined : yield* readHead(arch, workspaceId, id);
    });

  const history: DocsShape["history"] = (workspaceId, rawId) =>
    Effect.gen(function* () {
      const id = yield* checkedId(rawId);
      const at = yield* folder(workspaceId, false);
      return at === undefined ? [] : yield* historyIn(at, id);
    });

  const read: DocsShape["read"] = (workspaceId, rawId, revision) =>
    Effect.gen(function* () {
      const id = yield* checkedId(rawId);
      const at = yield* folder(workspaceId, false);
      const doc = at === undefined ? undefined : yield* findDoc(at, workspaceId, id);
      if (doc === undefined || at === undefined) return yield* notFound(id);
      if (revision === undefined || revision === doc.revision) return doc;
      const kept =
        Number.isSafeInteger(revision) && revision > 0
          ? yield* historyOf(at, id, false)
          : undefined;
      const earlier =
        kept === undefined
          ? undefined
          : yield* readDoc(kept, workspaceId, id, `${revision}${RECORD}`);
      if (earlier === undefined || earlier.revision !== revision) {
        const versions = yield* historyIn(at, id);
        return yield* new NotFound({
          entity: "file",
          id,
          message:
            `Revision ${revision} of ${doc.title} isn't kept. It is at ${doc.revision}` +
            (versions.length === 0
              ? ", with no earlier versions kept."
              : `; kept: ${versions.join(", ")}.`),
        });
      }
      return earlier;
    });

  const commit = (at: DocFolder, meta: DocMeta, content: string, previous?: Doc) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const record = yield* recordOf(meta, content);
        if (previous !== undefined) {
          const { content: before, ...beforeMeta } = previous;
          const kept = yield* historyOf(at, meta.id, true);
          if (kept === undefined) return yield* refuse("The doc's history folder couldn't be made");
          const old = yield* recordOf(beforeMeta, before);
          yield* run(meta.id, () => writePinned(kept, `${previous.revision}${RECORD}`, old, hooks));
          yield* run(meta.id, () => writePinned(at, recordName(meta.id), record, hooks));
          const versions = yield* historyIn(at, meta.id);
          for (const extra of versions.slice(historyKeep)) {
            yield* run(meta.id, () => unlinkPinned(kept, `${extra}${RECORD}`));
          }
        } else {
          yield* run(meta.id, () => writePinned(at, recordName(meta.id), record, hooks));
        }
        yield* publishChanged(meta.workspaceId);
      }),
    );

  const move = (id: DocId, record: string, folders: { from: DocFolder; to: DocFolder }) =>
    Effect.gen(function* () {
      yield* run(id, () => writePinned(folders.to, recordName(id), record, hooks));
      yield* run(id, () => unlinkPinned(folders.from, recordName(id)));
    });

  const purgeOverCap = (
    at: DocFolder,
    arch: DocFolder,
    workspaceId: WorkspaceId,
    justArchived: DocId,
  ) =>
    Effect.gen(function* () {
      const archiveMax = Math.max(1, yield* archiveMaxNow);
      const names = idsIn(yield* run("archive", () => listPinned(arch)));
      if (names.length <= archiveMax) return;
      const others = (yield* listArchivedIn(at, workspaceId)).filter(
        (meta) => meta.id !== justArchived,
      );
      for (const old of others.slice(archiveMax - 1).toReversed()) {
        yield* purge(at, arch, old.id).pipe(Effect.ignore);
      }
    });

  const publish: DocsShape["publish"] = (input) =>
    locks.withLock(
      input.workspaceId,
      Effect.gen(function* () {
        const content = redactText(input.content);
        const bytes = yield* checkContent(content);
        const now = yield* Clock.currentTimeMillis;
        const at = yield* folder(input.workspaceId, true);
        if (at === undefined) return yield* refuse("The workspace's docs folder couldn't be made");
        if (input.id === undefined) {
          const title = docTitle(input.title ?? "");
          if (title === "") return yield* refuse("A new doc needs a title");
          const existing = yield* listIn(at, input.workspaceId);
          const pr = input.pr;
          const forPr =
            pr === undefined
              ? undefined
              : existing.find((doc) => doc.pr !== undefined && sameDocPr(doc.pr, pr));
          if (forPr !== undefined) return { meta: forPr, action: "existing" as const };
          if (existing.length >= activeMax) {
            return yield* refuse(
              `This workspace keeps at most ${activeMax} active docs. Archive one you're done ` +
                "with (archive_doc) or update one instead.",
            );
          }
          const arch = yield* archiveOf(at, false);
          const taken = new Set([
            ...existing.map((doc) => doc.id),
            ...(arch === undefined ? [] : idsIn(yield* run("archive", () => listPinned(arch)))),
          ]);
          let id = newDocId(title);
          while (taken.has(id)) id = newDocId(title);
          const meta: DocMeta = {
            id,
            workspaceId: input.workspaceId,
            title,
            authorThreadId: input.author.threadId,
            authorTitle: docTitle(input.author.title) || "Untitled thread",
            createdAt: now,
            updatedAt: now,
            updatedBy: "agent",
            revision: 1,
            bytes,
            excerpt: docExcerpt(content),
            ...(pr === undefined ? {} : { pr }),
            ...(input.author.orchestrator
              ? { authorRole: "orchestrator" as const }
              : input.author.worker === true
                ? { authorRole: "worker" as const }
                : {}),
          };
          yield* commit(at, meta, content);
          return { meta, action: "published" as const };
        }
        const id = yield* checkedId(input.id);
        const previous = yield* readDoc(at, input.workspaceId, id);
        if (previous === undefined) {
          const archived = yield* archivedHead(at, input.workspaceId, id);
          if (archived !== undefined) return yield* archivedRefusal(archived);
          return yield* refuse(
            `No doc ${id} in this workspace. Leave out \`id\` to publish a new one.`,
          );
        }
        const { content: _previousContent, ...current } = previous;
        if (
          current.pr === undefined &&
          current.authorThreadId !== input.author.threadId &&
          !input.author.orchestrator
        ) {
          return yield* refuse(
            `${current.title} was published by ${current.authorTitle}: only that thread or the ` +
              "workspace's orchestrator may update it. Publish a doc of your own instead.",
          );
        }
        if (input.revision === undefined) {
          return yield* refuse(
            `Updating ${current.title} needs \`revision\`: the one publish_doc or read_doc last ` +
              `gave you (it is at ${current.revision}). Read it first if you haven't.`,
          );
        }
        if (input.revision !== current.revision) {
          return yield* refuse(
            `${current.title} moved on to revision ${current.revision}` +
              (current.updatedBy === "user" ? ", which the user saved" : "") +
              `, past the ${input.revision} you sent. Read it with read_doc and publish your ` +
              "update over that, keeping the changes made since.",
          );
        }
        const meta: DocMeta = {
          ...current,
          title: input.title === undefined ? current.title : docTitle(input.title) || current.title,
          updatedAt: Math.max(now, current.updatedAt),
          updatedBy: "agent",
          revision: current.revision + 1,
          bytes,
          excerpt: docExcerpt(content),
        };
        yield* commit(at, meta, content, previous);
        return { meta, action: "updated" as const };
      }),
    );

  const save: DocsShape["save"] = (workspaceId, rawId, content, revision) =>
    locks.withLock(
      workspaceId,
      Effect.gen(function* () {
        const id = yield* checkedId(rawId);
        const bytes = yield* checkContent(content);
        const at = yield* folder(workspaceId, false);
        if (at === undefined) return yield* notFound(id);
        const previous = yield* readDoc(at, workspaceId, id);
        if (previous === undefined) {
          const archived = yield* archivedHead(at, workspaceId, id);
          return yield* archived === undefined ? notFound(id) : archivedRefusal(archived);
        }
        const { content: _previousContent, ...current } = previous;
        if (revision !== current.revision) {
          return yield* refuse(
            `${current.title} changed since you opened it (now revision ${current.revision}). ` +
              "Copy your edit, reload the doc and apply it again.",
          );
        }
        const now = yield* Clock.currentTimeMillis;
        const editor: DocEditor = "user";
        const meta: DocMeta = {
          ...current,
          updatedAt: Math.max(now, current.updatedAt),
          updatedBy: editor,
          revision: current.revision + 1,
          bytes,
          excerpt: docExcerpt(content),
          userSeenAt: now,
        };
        yield* commit(at, meta, content, previous);
        return meta;
      }),
    );

  const archiveWith = (
    workspaceId: WorkspaceId,
    rawId: DocId,
    by: DocActor,
    reason: DocArchiveReason,
    due?: (meta: DocMeta) => boolean,
  ) =>
    locks.withLock(
      workspaceId,
      Effect.gen(function* () {
        const id = yield* checkedId(rawId);
        const at = yield* folder(workspaceId, false);
        if (at === undefined) return yield* notFound(id);
        const doc = yield* readDoc(at, workspaceId, id);
        if (doc === undefined) {
          const archived = yield* archivedHead(at, workspaceId, id);
          if (archived !== undefined) return yield* refuse(`${archived.title} is archived already`);
          return yield* notFound(id);
        }
        const { content, ...current } = doc;
        if (!isAuthor(current, by)) return yield* notYours(current, "archive");
        if (due !== undefined && !due(current)) return undefined;
        const now = yield* Clock.currentTimeMillis;
        const meta: DocMeta = { ...current, archivedAt: now, archivedReason: reason };
        const record = yield* recordOf(meta, content);
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const arch = yield* archiveOf(at, true);
            if (arch === undefined) return yield* refuse("The docs archive couldn't be made");
            yield* move(id, record, { from: at, to: arch });
            yield* purgeOverCap(at, arch, workspaceId, id);
            yield* publishChanged(workspaceId);
          }),
        );
        return meta;
      }),
    );

  const archive: DocsShape["archive"] = (workspaceId, id, by, reason) =>
    archiveWith(workspaceId, id, by, reason).pipe(
      Effect.flatMap((meta) =>
        meta === undefined ? Effect.fail(notFound(id)) : Effect.succeed(meta),
      ),
    );

  const archiveIfDue: DocsShape["archiveIfDue"] = (workspaceId, id, reason, due) =>
    archiveWith(workspaceId, id, "sweep", reason, due).pipe(
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );

  const mark: DocsShape["mark"] = (workspaceId, rawId, change) =>
    locks.withLock(
      workspaceId,
      Effect.gen(function* () {
        const id = yield* checkedId(rawId);
        const at = yield* folder(workspaceId, false);
        if (at === undefined) return;
        const doc = yield* readDoc(at, workspaceId, id);
        if (doc === undefined) return;
        const { content, ...current } = doc;
        const next = change(current);
        if (next === undefined) return;
        const meta: DocMeta = {
          ...next,
          id: current.id,
          workspaceId: current.workspaceId,
          revision: current.revision,
          bytes: current.bytes,
        };
        const record = yield* recordOf(meta, content);
        yield* Effect.uninterruptible(
          run(id, () => writePinned(at, recordName(id), record, hooks)),
        );
      }),
    );

  const restore: DocsShape["restore"] = (workspaceId, rawId, by) =>
    locks.withLock(
      workspaceId,
      Effect.gen(function* () {
        const id = yield* checkedId(rawId);
        const at = yield* folder(workspaceId, false);
        if (at === undefined) return yield* notFound(id);
        const arch = yield* archiveOf(at, false);
        const doc = arch === undefined ? undefined : yield* readDoc(arch, workspaceId, id);
        if (doc === undefined || arch === undefined) {
          const active = yield* readHead(at, workspaceId, id);
          if (active !== undefined) return yield* refuse(`${active.title} isn't archived`);
          return yield* notFound(id);
        }
        const { content, ...archived } = doc;
        if (by === "sweep" || !isAuthor(archived, by)) return yield* notYours(archived, "restore");
        const active = yield* listIn(at, workspaceId);
        const stillActive = active.some((each) => each.id === id);
        const pr = archived.pr;
        const samePr =
          pr === undefined || stillActive
            ? undefined
            : active.find((each) => each.pr !== undefined && sameDocPr(each.pr, pr));
        if (samePr !== undefined) {
          return yield* refuse(
            `${samePr.title} is already the active doc for ${pr!.repo}#${pr!.number}, which keeps ` +
              `one, so ${archived.title} wasn't restored. Archive that one first (archive_doc ` +
              `id "${samePr.id}"), or read this one and fold what it holds into that.`,
          );
        }
        if (!stillActive && active.length >= activeMax) {
          return yield* refuse(
            `This workspace already has ${active.length} active docs, the most it keeps, so ` +
              `${archived.title} wasn't restored. Archive one you're done with (archive_doc), ` +
              "then restore this one.",
          );
        }
        const meta = activeOf(archived, yield* Clock.currentTimeMillis);
        const record = yield* recordOf(meta, content);
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            if (stillActive) yield* run(id, () => unlinkPinned(arch, recordName(id)));
            else yield* move(id, record, { from: arch, to: at });
            yield* publishChanged(workspaceId);
          }),
        );
        return meta;
      }),
    );

  const remove: DocsShape["remove"] = (workspaceId, rawId, by) =>
    locks.withLock(
      workspaceId,
      Effect.gen(function* () {
        const id = yield* checkedId(rawId);
        if (by === "sweep" || (by !== "user" && !by.orchestrator)) {
          return yield* refuse(
            "Only the workspace's orchestrator or the user may delete a doc. Archive it with " +
              "archive_doc instead.",
          );
        }
        const at = yield* folder(workspaceId, false);
        if (at === undefined) return yield* notFound(id);
        const active = yield* readHead(at, workspaceId, id);
        if (active !== undefined) {
          return yield* refuse(
            `${active.title} is active. Only an archived doc can be deleted: archive it first.`,
          );
        }
        const arch = yield* archiveOf(at, false);
        const archived = arch === undefined ? undefined : yield* readHead(arch, workspaceId, id);
        if (archived === undefined || arch === undefined) return yield* notFound(id);
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* purge(at, arch, id);
            yield* publishChanged(workspaceId);
          }),
        );
      }),
    );

  return {
    list,
    listArchived,
    counts,
    read,
    history,
    publish,
    save,
    archive,
    restore,
    remove,
    archiveIfDue,
    mark,
  };
};

/** The workspaces' docs, under `<dataDir>/docs`. */
export class Docs extends Context.Service<Docs, DocsShape>()("@gram/server/Docs") {
  static readonly layer: Layer.Layer<Docs, never, ServerConfig | EventHub | ThreadStore> =
    Layer.effect(
      Docs,
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const hub = yield* EventHub;
        const store = yield* ThreadStore;
        return makeDocs(
          join(config.dataDir, "docs"),
          (workspaceId) => hub.publish({ type: "docs.changed", workspaceId }).pipe(Effect.asVoid),
          undefined,
          {
            archiveKeep: store.getSettings.pipe(
              Effect.map((settings) => docsArchiveOf(settings).keep),
            ),
          },
        );
      }),
    );
}
