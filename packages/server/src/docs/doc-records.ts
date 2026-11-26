import {
  DOC_ID_PATTERN,
  DOC_MAX_BYTES,
  DOC_META_MAX_BYTES,
  DocId,
  DocMeta,
  errnoCode,
  FsError,
  InvalidState,
  NotFound,
  type ThreadId,
  type WorkspaceId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { randomBytes } from "node:crypto";

import {
  DocRefusal,
  listPinned,
  openSub,
  removePinned,
  unlinkPinned,
  type DocFolder,
} from "./doc-files.ts";

/** Who is publishing: the calling thread, as the app tool resolves it from the store. */
export interface DocAuthor {
  readonly threadId: ThreadId;
  readonly title: string;
  /** The workspace's orchestrator, which may update any of its workers' docs. */
  readonly orchestrator: boolean;
  /** A worker an orchestrator started: its docs archive some days after it is archived. */
  readonly worker?: boolean | undefined;
}

/**
 * Who archives, restores or deletes a doc: an agent, as the app tool resolves it, the user from
 * the doc pane, who may do any of it, or Gram's own sweep, which may only archive.
 */
export type DocActor = DocAuthor | "user" | "sweep";

export const refuse = (message: string) => new InvalidState({ message });

export const codeOf = (error: unknown): unknown => errnoCode(error);

export const fsError = (shown: string, error: unknown) => {
  const code = codeOf(error);
  return new FsError({
    path: shown,
    message: `Can't access the doc ${shown} (${typeof code === "string" ? code : "unknown error"})`,
  });
};

export const kb = (bytes: number) => `${Math.ceil(bytes / 1024)} KB`;

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

export const decodeMeta = Schema.decodeUnknownOption(DocMeta);

export const RECORD = ".doc";
export const recordName = (id: DocId) => `${id}${RECORD}`;
export const ARCHIVE_DIR = "archive";
export const HISTORY_DIR = "history";
export const HISTORY_RECORD = /^([1-9][0-9]{0,9})\.doc$/;
export const idsIn = (names: ReadonlyArray<string>): DocId[] =>
  names.flatMap((name) => {
    if (!name.endsWith(RECORD)) return [];
    const id = name.slice(0, -RECORD.length);
    return DOC_ID_PATTERN.test(id) ? [DocId.make(id)] : [];
  });
export const HEAD_MAX = DOC_META_MAX_BYTES + 1;
export const RECORD_MAX = HEAD_MAX + DOC_MAX_BYTES;

export const checkedId = (id: string) =>
  DOC_ID_PATTERN.test(id)
    ? Effect.succeed(DocId.make(id))
    : Effect.fail(refuse(`${id} isn't a doc id`));

export const notFound = (id: string) =>
  new NotFound({ entity: "file", id, message: `No doc ${id} in this workspace` });

export const unreadable = (id: string) =>
  refuse(`The doc ${id}'s details don't read, so it wasn't opened`);

export const metaOf = (head: string, workspaceId: WorkspaceId, id: DocId): DocMeta | undefined => {
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

export const recordOf = (meta: DocMeta, content: string) => {
  if (decodeMeta(meta)._tag === "None") {
    return Effect.fail(refuse("The doc's details are out of bounds, so it wasn't saved"));
  }
  const line = JSON.stringify(meta);
  if (Buffer.byteLength(line, "utf8") > DOC_META_MAX_BYTES) {
    return Effect.fail(refuse("The doc's details are too long, so it wasn't saved"));
  }
  return Effect.succeed(`${line}\n${content}`);
};

export const checkContent = (content: string) => {
  const bytes = Buffer.byteLength(content, "utf8");
  return bytes > DOC_MAX_BYTES
    ? Effect.fail(refuse(`A doc holds at most ${kb(DOC_MAX_BYTES)}; this one is ${kb(bytes)}`))
    : Effect.succeed(bytes);
};

export const run = <A>(
  shown: string,
  io: () => Promise<A>,
): Effect.Effect<A, InvalidState | FsError> =>
  Effect.tryPromise({ try: io, catch: (error) => error }).pipe(
    Effect.catch((error) =>
      Effect.fail(error instanceof DocRefusal ? refuse(error.message) : fsError(shown, error)),
    ),
  );

export const archiveOf = (at: DocFolder, create: boolean) =>
  run("archive", () => openSub(at, ARCHIVE_DIR, create));

export const historyOf = (at: DocFolder, id: DocId, create: boolean) =>
  Effect.gen(function* () {
    const all = yield* run("history", () => openSub(at, HISTORY_DIR, create));
    if (all === undefined) return undefined;
    return yield* run("history", () => openSub(all, id, create));
  });

export const archivedAtOf = (meta: DocMeta) => meta.archivedAt ?? meta.updatedAt;

export const historyIn = (at: DocFolder, id: DocId) =>
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

export const purge = (at: DocFolder, arch: DocFolder, id: DocId) =>
  Effect.gen(function* () {
    const kept = yield* historyOf(at, id, false);
    if (kept !== undefined) yield* run(id, () => removePinned(kept));
    yield* run(id, () => unlinkPinned(arch, recordName(id)));
  });

/**
 * An archived doc made active again at `now`: its archive fields and its PR's settled mark go, so
 * the sweep counts afresh, and `restoredAt` keeps it from automatic archiving for a while.
 */
export const activeOf = (meta: DocMeta, now: number): DocMeta => {
  const { archivedAt: _at, archivedReason: _reason, prSettledAt: _settled, ...active } = meta;
  return { ...active, restoredAt: now };
};

export const isAuthor = (meta: DocMeta, by: DocActor) =>
  by === "user" || by === "sweep" || by.orchestrator || meta.authorThreadId === by.threadId;

export const notYours = (meta: DocMeta, doing: string) =>
  refuse(
    `${meta.title} was published by ${meta.authorTitle}: only that thread, the workspace's ` +
      `orchestrator or the user may ${doing} it.`,
  );

export const archivedRefusal = (meta: DocMeta) =>
  refuse(
    `${meta.title} is archived. Restore it with archive_doc (id "${meta.id}", restore: true) ` +
      "to change it, or publish a new doc.",
  );
