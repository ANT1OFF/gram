import {
  type Doc,
  DOC_ID_PATTERN,
  DOC_MAX_BYTES,
  DOC_META_MAX_BYTES,
  type DocEditor,
  docExcerpt,
  DocId,
  DocMeta,
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
  readPinned,
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
        const meta = yield* readHead(at, workspaceId, DocId.make(id)).pipe(
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
