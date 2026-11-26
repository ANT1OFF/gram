import {
  type Doc,
  type DocArchiveReason,
  DOC_HISTORY_KEEP,
  DOC_ID_PATTERN,
  DOC_MAX_BYTES,
  DOC_META_MAX_BYTES,
  type DocEditor,
  docExcerpt,
  DocId,
  DocMeta,
  DOCS_ARCHIVE_MAX,
  DOCS_PER_WORKSPACE_MAX,
  docTitle,
  errnoCode,
  FsError,
  InvalidState,
  NotFound,
  redactText,
  type ThreadId,
  type WorkspaceId,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { ServerConfig } from "../config.ts";
import { EventHub } from "../events/event-hub.ts";
import { makeKeyedLock } from "../git/keyed-lock.ts";
import {
  DocRefusal,
  listPinned,
  openFolder,
  openSub,
  readPinned,
  removePinned,
  unlinkPinned,
  writePinned,
  type DocFileHooks,
  type DocFolder,
} from "./doc-files.ts";

const WORKSPACE_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

export type DocError = InvalidState | NotFound | FsError;

/** Who is publishing: the calling thread, as the app tool resolves it from the store. */
export interface DocAuthor {
  readonly threadId: ThreadId;
  readonly title: string;
  /** The workspace's orchestrator, which may update any of its workers' docs. */
  readonly orchestrator: boolean;
}

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
}

/**
 * Who archives, restores or deletes a doc: an agent, as the app tool resolves it, or the user from
 * the doc pane, who may do any of it.
 */
export type DocActor = DocAuthor | "user";

export interface PublishedDoc {
  readonly meta: DocMeta;
  readonly action: "published" | "updated";
}

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
}

/** Limits a test can lower. */
export interface DocLimits {
  readonly activeMax?: number;
  readonly archiveMax?: number;
  readonly historyKeep?: number;
}

const refuse = (message: string) => new InvalidState({ message });

const codeOf = (error: unknown): unknown => errnoCode(error);

const fsError = (shown: string, error: unknown) => {
  const code = codeOf(error);
  return new FsError({
    path: shown,
    message: `Can't access the doc ${shown} (${typeof code === "string" ? code : "unknown error"})`,
  });
};

const kb = (bytes: number) => `${Math.ceil(bytes / 1024)} KB`;

/** `gap-analysis-3f9a2c`: the title's words, then six random hex digits. */
export const newDocId = (title: string): DocId => {
  const words = title
    .slice(0, 200)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  const id = `${words === "" ? "doc" : words}-${randomBytes(3).toString("hex")}`;
  return DocId.make(id);
};

const decodeMeta = Schema.decodeUnknownOption(DocMeta);

const RECORD = ".doc";
const recordName = (id: DocId) => `${id}${RECORD}`;
const ARCHIVE_DIR = "archive";
const HISTORY_DIR = "history";
const HISTORY_RECORD = /^([1-9][0-9]{0,9})\.doc$/;
const idsIn = (names: ReadonlyArray<string>): DocId[] =>
  names.flatMap((name) => {
    if (!name.endsWith(RECORD)) return [];
    const id = name.slice(0, -RECORD.length);
    return DOC_ID_PATTERN.test(id) ? [DocId.make(id)] : [];
  });
const HEAD_MAX = DOC_META_MAX_BYTES + 1;
const RECORD_MAX = HEAD_MAX + DOC_MAX_BYTES;

const checkedId = (id: string) =>
  DOC_ID_PATTERN.test(id)
    ? Effect.succeed(DocId.make(id))
    : Effect.fail(refuse(`${id} isn't a doc id`));

const notFound = (id: string) =>
  new NotFound({ entity: "file", id, message: `No doc ${id} in this workspace` });

const unreadable = (id: string) =>
  refuse(`The doc ${id}'s details don't read, so it wasn't opened`);

const metaOf = (head: string, workspaceId: WorkspaceId, id: DocId): DocMeta | undefined => {
  const end = head.indexOf("\n");
  if (end < 0 || end > DOC_META_MAX_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(head.slice(0, end));
  } catch {
    return undefined;
  }
  const meta = decodeMeta(parsed);
  if (meta._tag === "None" || meta.value.id !== id || meta.value.workspaceId !== workspaceId) {
    return undefined;
  }
  return meta.value;
};

const recordOf = (meta: DocMeta, content: string) => {
  if (decodeMeta(meta)._tag === "None") {
    return Effect.fail(refuse("The doc's details are out of bounds, so it wasn't saved"));
  }
  const line = JSON.stringify(meta);
  if (Buffer.byteLength(line, "utf8") > DOC_META_MAX_BYTES) {
    return Effect.fail(refuse("The doc's details are too long, so it wasn't saved"));
  }
  return Effect.succeed(`${line}\n${content}`);
};

const checkContent = (content: string) => {
  const bytes = Buffer.byteLength(content, "utf8");
  return bytes > DOC_MAX_BYTES
    ? Effect.fail(refuse(`A doc holds at most ${kb(DOC_MAX_BYTES)}; this one is ${kb(bytes)}`))
    : Effect.succeed(bytes);
};

const run = <A>(shown: string, io: () => Promise<A>): Effect.Effect<A, InvalidState | FsError> =>
  Effect.tryPromise({ try: io, catch: (error) => error }).pipe(
    Effect.catch((error) =>
      Effect.fail(error instanceof DocRefusal ? refuse(error.message) : fsError(shown, error)),
    ),
  );

const archiveOf = (at: DocFolder, create: boolean) =>
  run("archive", () => openSub(at, ARCHIVE_DIR, create));

const historyOf = (at: DocFolder, id: DocId, create: boolean) =>
  Effect.gen(function* () {
    const all = yield* run("history", () => openSub(at, HISTORY_DIR, create));
    if (all === undefined) return undefined;
    return yield* run("history", () => openSub(all, id, create));
  });

const archivedAtOf = (meta: DocMeta) => meta.archivedAt ?? meta.updatedAt;

const historyIn = (at: DocFolder, id: DocId) =>
  Effect.gen(function* () {
    const kept = yield* historyOf(at, id, false);
    if (kept === undefined) return [];
    const names = yield* run("history", () => listPinned(kept));
    return names
      .flatMap((name) => {
        const match = HISTORY_RECORD.exec(name);
        return match === null ? [] : [Number(match[1])];
      })
      .toSorted((a, b) => b - a);
  });

const purge = (at: DocFolder, arch: DocFolder, id: DocId) =>
  Effect.gen(function* () {
    const kept = yield* historyOf(at, id, false);
    if (kept !== undefined) yield* run(id, () => removePinned(kept));
    yield* run(id, () => unlinkPinned(arch, recordName(id)));
  });

const activeOf = (meta: DocMeta): DocMeta => {
  const { archivedAt: _at, archivedReason: _reason, ...active } = meta;
  return active;
};

const isAuthor = (meta: DocMeta, by: DocActor) =>
  by === "user" || by.orchestrator || meta.authorThreadId === by.threadId;

const notYours = (meta: DocMeta, doing: string) =>
  refuse(
    `${meta.title} was published by ${meta.authorTitle}: only that thread, the workspace's ` +
      `orchestrator or the user may ${doing} it.`,
  );

const archivedRefusal = (meta: DocMeta) =>
  refuse(
    `${meta.title} is archived. Restore it with archive_doc (id "${meta.id}", restore: true) ` +
      "to change it, or publish a new doc.",
  );

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
  const archiveMax = limits.archiveMax ?? DOCS_ARCHIVE_MAX;
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
        if (current.authorThreadId !== input.author.threadId && !input.author.orchestrator) {
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
        };
        yield* commit(at, meta, content, previous);
        return meta;
      }),
    );

  const archive: DocsShape["archive"] = (workspaceId, rawId, by, reason) =>
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
        if (!isAuthor(archived, by)) return yield* notYours(archived, "restore");
        const active = yield* listIn(at, workspaceId);
        const stillActive = active.some((each) => each.id === id);
        if (!stillActive && active.length >= activeMax) {
          return yield* refuse(
            `This workspace already has ${active.length} active docs, the most it keeps, so ` +
              `${archived.title} wasn't restored. Archive one you're done with (archive_doc), ` +
              "then restore this one.",
          );
        }
        const meta = activeOf(archived);
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
        if (by !== "user" && !by.orchestrator) {
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

  return { list, listArchived, counts, read, history, publish, save, archive, restore, remove };
};

/** The workspaces' docs, under `<dataDir>/docs`. */
export class Docs extends Context.Service<Docs, DocsShape>()("@gram/server/Docs") {
  static readonly layer: Layer.Layer<Docs, never, ServerConfig | EventHub> = Layer.effect(
    Docs,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const hub = yield* EventHub;
      return makeDocs(join(config.dataDir, "docs"), (workspaceId) =>
        hub.publish({ type: "docs.changed", workspaceId }).pipe(Effect.asVoid),
      );
    }),
  );
}
