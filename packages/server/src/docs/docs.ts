// A workspace's docs (`@gram/contracts` `docs.ts`): Markdown its threads publish with `publish_doc`
// and the user edits in the doc pane, kept in Gram's state at `<dataDir>/docs/<workspaceId>/`, one
// `<id>.doc` record each: a line of its metadata, then its Markdown. Never in a repo, never uploaded.
//
// Every path is built here from two checked segments: the workspace id (`WORKSPACE_SEGMENT`) and the
// doc id (`DOC_ID_PATTERN`: lowercase letters, digits and inner hyphens), so no input can name `..`,
// a separator or another folder. The file layer (`doc-files.ts`) pins the docs root and the
// workspace folder for each operation and refuses a link in either. A save is one record renamed
// into place, so a failed write leaves the last saved doc whole, and a read is one file, so its text
// and its revision always belong together. Every metadata field is bounded, and a record whose
// metadata line would pass its read cap is refused at the save, so whatever was saved can be read.

import {
  DOC_ID_PATTERN,
  DOC_MAX_BYTES,
  DOC_META_MAX_BYTES,
  DOCS_PER_WORKSPACE_MAX,
  DocMeta,
  docExcerpt,
  docTitle,
  FsError,
  InvalidState,
  NotFound,
  redactText,
  type Doc,
  type DocEditor,
  type DocId,
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
  readPinned,
  writePinned,
  type DocFileHooks,
  type DocFolder,
} from "./doc-files.ts";

/** A workspace id as a folder name; ids are UUIDs, tests use short names. */
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

export interface PublishedDoc {
  readonly meta: DocMeta;
  readonly action: "published" | "updated";
}

export interface DocsShape {
  /** The workspace's docs, newest first. A metadata file that doesn't decode is left out. */
  readonly list: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<DocMeta>, InvalidState | FsError>;
  readonly read: (workspaceId: WorkspaceId, id: DocId) => Effect.Effect<Doc, DocError>;
  /** An agent's publish or update; tells the workspace's clients. */
  readonly publish: (input: PublishDocInput) => Effect.Effect<PublishedDoc, DocError>;
  /** The user's edit from the doc pane, over the revision it opened; tells the clients. */
  readonly save: (
    workspaceId: WorkspaceId,
    id: DocId,
    content: string,
    revision: number,
  ) => Effect.Effect<DocMeta, DocError>;
}

const refuse = (message: string) => new InvalidState({ message });

const codeOf = (error: unknown): unknown => (error as { code?: unknown } | undefined)?.code;

/** Never the raw error, whose message carries absolute paths: only the doc and the code. */
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
  // Bounded first, so the trims below never scan a long run of separators.
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
  return id as DocId;
};

const decodeMeta = Schema.decodeUnknownOption(DocMeta);

/** A doc's record: one line of its metadata, then its Markdown, committed by one rename. */
const RECORD = ".doc";
const recordName = (id: DocId) => `${id}${RECORD}`;
const HEAD_MAX = DOC_META_MAX_BYTES + 1;
const RECORD_MAX = HEAD_MAX + DOC_MAX_BYTES;

const checkedId = (id: string) =>
  DOC_ID_PATTERN.test(id)
    ? Effect.succeed(id as DocId)
    : Effect.fail(refuse(`${id} isn't a doc id`));

const notFound = (id: string) =>
  new NotFound({ entity: "file", id, message: `No doc ${id} in this workspace` });

const unreadable = (id: string) =>
  refuse(`The doc ${id}'s details don't read, so it wasn't opened`);

/**
 * The metadata a record's first line holds, when it decodes, is in bounds and names this doc of
 * this workspace; `undefined` otherwise.
 */
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
  // A record that says it is another doc, or another workspace's, is not this one.
  if (meta._tag === "None" || meta.value.id !== id || meta.value.workspaceId !== workspaceId) {
    return undefined;
  }
  return meta.value;
};

/** The record for `meta` and `content`, refused if its metadata is out of bounds. */
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

/** A refusal as `InvalidState`, any other failure as an `FsError` naming only `shown`. */
const run = <A>(shown: string, io: () => Promise<A>): Effect.Effect<A, InvalidState | FsError> =>
  Effect.tryPromise({ try: io, catch: (error) => error }).pipe(
    Effect.catch((error) =>
      Effect.fail(error instanceof DocRefusal ? refuse(error.message) : fsError(shown, error)),
    ),
  );

/** The docs under `root`, one folder per workspace. `hooks` are tests' racing writer and full disk. */
export const makeDocs = (
  root: string,
  publishChanged: (workspaceId: WorkspaceId) => Effect.Effect<void>,
  hooks?: DocFileHooks,
): DocsShape => {
  const locks = makeKeyedLock<string>();

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
      for (const name of names) {
        if (!name.endsWith(RECORD)) continue;
        const id = name.slice(0, -RECORD.length);
        if (!DOC_ID_PATTERN.test(id)) continue;
        // One that doesn't read is left out of the list rather than failing it.
        const meta = yield* readHead(at, workspaceId, id as DocId).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        );
        if (meta !== undefined) docs.push(meta);
      }
      return docs.toSorted((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    });

  const list: DocsShape["list"] = (workspaceId) =>
    Effect.gen(function* () {
      const at = yield* folder(workspaceId, false);
      return at === undefined ? [] : yield* listIn(at, workspaceId);
    });

  /** The whole record, read once: its metadata and text always belong together. */
  const readDoc = (at: DocFolder, workspaceId: WorkspaceId, id: DocId) =>
    Effect.gen(function* () {
      const record = yield* run(id, () =>
        readPinned(at, recordName(id), RECORD_MAX, { whole: true, hooks }),
      );
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

  const read: DocsShape["read"] = (workspaceId, rawId) =>
    Effect.gen(function* () {
      const id = yield* checkedId(rawId);
      const at = yield* folder(workspaceId, false);
      const doc = at === undefined ? undefined : yield* readDoc(at, workspaceId, id);
      return doc ?? (yield* notFound(id));
    });

  /**
   * Writes the record and tells the clients, uninterruptibly: a promise outlives its fiber's
   * interruption, so a save cancelled mid-write must not give up the workspace's lock until the
   * write has settled, or a later save could land first and be overwritten by it.
   */
  const commit = (at: DocFolder, meta: DocMeta, content: string) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const record = yield* recordOf(meta, content);
        yield* run(meta.id, () => writePinned(at, recordName(meta.id), record, hooks));
        yield* publishChanged(meta.workspaceId);
      }),
    );

  const publish: DocsShape["publish"] = (input) =>
    locks.withLock(
      input.workspaceId,
      Effect.gen(function* () {
        // What an agent publishes may quote a token it saw; it is kept with the secret censored.
        const content = redactText(input.content);
        const bytes = yield* checkContent(content);
        const now = yield* Clock.currentTimeMillis;
        const at = yield* folder(input.workspaceId, true);
        if (at === undefined) return yield* refuse("The workspace's docs folder couldn't be made");
        if (input.id === undefined) {
          const title = docTitle(input.title ?? "");
          if (title === "") return yield* refuse("A new doc needs a title");
          const existing = yield* listIn(at, input.workspaceId);
          if (existing.length >= DOCS_PER_WORKSPACE_MAX) {
            return yield* refuse(
              `This workspace keeps at most ${DOCS_PER_WORKSPACE_MAX} docs; update one instead`,
            );
          }
          let id = newDocId(title);
          while (existing.some((doc) => doc.id === id)) id = newDocId(title);
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
        const current = yield* readHead(at, input.workspaceId, id);
        if (current === undefined) {
          return yield* refuse(
            `No doc ${id} in this workspace. Leave out \`id\` to publish a new one.`,
          );
        }
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
        yield* commit(at, meta, content);
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
        const current = yield* readHead(at, workspaceId, id);
        if (current === undefined) return yield* notFound(id);
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
        yield* commit(at, meta, content);
        return meta;
      }),
    );

  return { list, read, publish, save };
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
