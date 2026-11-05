// A workspace's docs (`@gram/contracts` `docs.ts`): Markdown its threads publish with `publish_doc`
// and the user edits in the doc pane, kept in Gram's state at `<dataDir>/docs/<workspaceId>/`, one
// `<id>.md` beside one `<id>.json` of its metadata. Never in a repo, never uploaded.
//
// Every path is built here from two checked segments: the workspace id (`WORKSPACE_SEGMENT`) and the
// doc id (`DOC_ID_PATTERN`, lowercase letters, digits and inner hyphens), so no input can name
// `..`, a separator or another folder. On disk the workspace folder must be a real folder whose real
// path is the docs root's own child, a doc file must be a singly linked regular file opened without
// following a link, and a write goes to a fresh temp file renamed over the target, which replaces a
// planted link rather than writing through it. Folders are 0700 and files 0600.

import {
  DOC_ID_PATTERN,
  DOC_MAX_BYTES,
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
import { isInside, realPath } from "@gram/git";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ServerConfig } from "../config.ts";
import { EventHub } from "../events/event-hub.ts";
import { makeKeyedLock } from "../git/keyed-lock.ts";

/** A workspace id as a folder name; ids are UUIDs, tests use short names. */
const WORKSPACE_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
/** A metadata file is small; one past this is not one of ours. */
const META_MAX_BYTES = 16 * 1024;

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

const attempt = <A>(shown: string, run: () => Promise<A>): Effect.Effect<A, FsError> =>
  Effect.tryPromise({ try: run, catch: (error) => fsError(shown, error) });

/** `undefined` when the path isn't there; any other failure is an error. */
const attemptExisting = <A>(shown: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (error) => error }).pipe(
    Effect.catch((error) =>
      codeOf(error) === "ENOENT" ? Effect.succeed(undefined) : Effect.fail(fsError(shown, error)),
    ),
  );

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
const metaJson = (meta: DocMeta) => `${JSON.stringify(meta, null, 2)}\n`;

/** A file's bytes, read without following a link and refused past `max` or with a second link. */
const readFileBounded = (path: string, shown: string, max: number) =>
  attemptExisting(shown, async () => {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.nlink !== 1) return "not-plain" as const;
      if (stats.size > max) return "too-big" as const;
      const bytes = Buffer.alloc(max + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > max) return "too-big" as const;
      return bytes.subarray(0, length).toString("utf8");
    } finally {
      await handle.close();
    }
  }).pipe(
    // `O_NOFOLLOW` on a link fails with ELOOP (EMLINK on some BSDs): refused, not an access error.
    Effect.catch((error) =>
      /\((ELOOP|EMLINK)\)$/.test(error.message)
        ? Effect.succeed("not-plain" as const)
        : Effect.fail(error),
    ),
  );

const checkedId = (id: string) =>
  DOC_ID_PATTERN.test(id)
    ? Effect.succeed(id as DocId)
    : Effect.fail(refuse(`${id} isn't a doc id`));

const notFound = (id: string) =>
  new NotFound({ entity: "file", id, message: `No doc ${id} in this workspace` });

const readMeta = (dir: string, workspaceId: WorkspaceId, id: DocId) =>
  Effect.gen(function* () {
    const text = yield* readFileBounded(join(dir, `${id}.json`), id, META_MAX_BYTES);
    if (text === undefined) return undefined;
    if (text === "not-plain" || text === "too-big") {
      return yield* refuse(`The doc ${id} isn't a plain file, so it wasn't read`);
    }
    const parsed = yield* Effect.try({ try: () => JSON.parse(text) as unknown, catch: () => id });
    const meta = decodeMeta(parsed);
    // A file that says it is another doc, or another workspace's, is not this one.
    if (meta._tag === "None" || meta.value.id !== id || meta.value.workspaceId !== workspaceId) {
      return yield* refuse(`The doc ${id}'s details don't read, so it wasn't opened`);
    }
    return meta.value;
  }).pipe(
    Effect.catch((error) =>
      typeof error === "string"
        ? Effect.fail(refuse(`The doc ${id}'s details don't read, so it wasn't opened`))
        : Effect.fail(error),
    ),
  );

const readContent = (dir: string, id: DocId) =>
  Effect.gen(function* () {
    const text = yield* readFileBounded(join(dir, `${id}.md`), id, DOC_MAX_BYTES);
    if (text === undefined) return yield* notFound(id);
    if (text === "not-plain") return yield* refuse(`The doc ${id} isn't a plain file`);
    if (text === "too-big") return yield* refuse(`The doc ${id} is past ${kb(DOC_MAX_BYTES)}`);
    return text;
  });

/** A fresh temp file beside the target, renamed over it: the old file or the new, never half. */
const writeAtomic = (dir: string, name: string, shown: string, content: string) =>
  Effect.gen(function* () {
    const target = join(dir, name);
    const existing = yield* attemptExisting(shown, () => lstat(target));
    if (existing !== undefined && existing.isDirectory()) {
      return yield* refuse(`The doc ${shown} is a folder`);
    }
    const temp = join(dir, `.tmp-${randomUUID()}`);
    yield* attempt(shown, async () => {
      try {
        // `wx` refuses a name that exists, a link included, so the temp file is ours.
        await writeFile(temp, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await rename(temp, target);
      } catch (error) {
        await unlink(temp).catch(() => undefined);
        throw error;
      }
    });
  });

const checkContent = (content: string) => {
  const bytes = Buffer.byteLength(content, "utf8");
  return bytes > DOC_MAX_BYTES
    ? Effect.fail(refuse(`A doc holds at most ${kb(DOC_MAX_BYTES)}; this one is ${kb(bytes)}`))
    : Effect.succeed(bytes);
};

const listIn = (dir: string, workspaceId: WorkspaceId) =>
  Effect.gen(function* () {
    const entries = yield* attempt("folder", () => readdir(dir, { withFileTypes: true }));
    const docs: DocMeta[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(0, -".json".length);
      if (!DOC_ID_PATTERN.test(id)) continue;
      const meta = yield* readMeta(dir, workspaceId, id as DocId).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      );
      if (meta !== undefined) docs.push(meta);
    }
    return docs.toSorted((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  });

/** Writes `content` and then `meta`: the metadata is the commit, so a doc is listed once whole. */
const commit = (dir: string, meta: DocMeta, content: string) =>
  Effect.gen(function* () {
    yield* writeAtomic(dir, `${meta.id}.md`, meta.id, content);
    yield* writeAtomic(dir, `${meta.id}.json`, meta.id, metaJson(meta));
  });

/** The docs under `root`, one folder per workspace. */
export const makeDocs = (
  root: string,
  publishChanged: (workspaceId: WorkspaceId) => Effect.Effect<void>,
): DocsShape => {
  const locks = makeKeyedLock<string>();

  /**
   * The workspace's folder: refused for an id that isn't a plain segment, a folder that is a link
   * or not a folder, or one whose real path isn't the docs root's own child. `create` makes it (and
   * the root) when missing; otherwise a missing folder is `undefined`, a workspace with no docs.
   */
  const folder = (workspaceId: WorkspaceId, create: boolean) =>
    Effect.gen(function* () {
      if (!WORKSPACE_SEGMENT.test(workspaceId)) {
        return yield* refuse("That isn't a workspace docs can be kept for");
      }
      const abs = join(root, workspaceId);
      if (create) {
        yield* attempt("folder", () => mkdir(root, { recursive: true, mode: 0o700 }));
        yield* attemptExisting("folder", () => mkdir(abs, { mode: 0o700 })).pipe(
          Effect.catch((error) =>
            error.message.endsWith("(EEXIST)") ? Effect.void : Effect.fail(error),
          ),
        );
      }
      const stats = yield* attemptExisting("folder", () => lstat(abs));
      if (stats === undefined) return undefined;
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        return yield* refuse(
          "The workspace's docs folder is a link or not a folder, so nothing was read or written",
        );
      }
      // The data dir itself may sit behind a link (`/tmp` on macOS): only the step from the root to
      // the workspace folder is judged.
      const realRoot = yield* attempt("folder", () => realPath(root));
      const realAbs = yield* attempt("folder", () => realPath(abs));
      if (realAbs !== join(realRoot, workspaceId) || !isInside(realRoot, realAbs)) {
        return yield* refuse("The workspace's docs folder is outside Gram's docs");
      }
      return abs;
    });

  const list: DocsShape["list"] = (workspaceId) =>
    Effect.gen(function* () {
      const dir = yield* folder(workspaceId, false);
      return dir === undefined ? [] : yield* listIn(dir, workspaceId);
    });

  const read: DocsShape["read"] = (workspaceId, rawId) =>
    Effect.gen(function* () {
      const id = yield* checkedId(rawId);
      const dir = yield* folder(workspaceId, false);
      if (dir === undefined) return yield* notFound(id);
      const meta = yield* readMeta(dir, workspaceId, id);
      if (meta === undefined) return yield* notFound(id);
      const content = yield* readContent(dir, id);
      return { ...meta, content };
    });

  const publish: DocsShape["publish"] = (input) =>
    locks.withLock(
      input.workspaceId,
      Effect.gen(function* () {
        // What an agent publishes may quote a token it saw; it is kept with the secret censored.
        const content = redactText(input.content);
        const bytes = yield* checkContent(content);
        const now = yield* Clock.currentTimeMillis;
        const dir = yield* folder(input.workspaceId, true);
        if (dir === undefined) return yield* refuse("The workspace's docs folder couldn't be made");
        if (input.id === undefined) {
          const title = docTitle(input.title ?? "");
          if (title === "") return yield* refuse("A new doc needs a title");
          const existing = yield* listIn(dir, input.workspaceId);
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
            authorTitle: input.author.title,
            createdAt: now,
            updatedAt: now,
            updatedBy: "agent",
            revision: 1,
            bytes,
            excerpt: docExcerpt(content),
          };
          yield* commit(dir, meta, content);
          yield* publishChanged(input.workspaceId);
          return { meta, action: "published" as const };
        }
        const id = yield* checkedId(input.id);
        const current = yield* readMeta(dir, input.workspaceId, id);
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
        yield* commit(dir, meta, content);
        yield* publishChanged(input.workspaceId);
        return { meta, action: "updated" as const };
      }),
    );

  const save: DocsShape["save"] = (workspaceId, rawId, content, revision) =>
    locks.withLock(
      workspaceId,
      Effect.gen(function* () {
        const id = yield* checkedId(rawId);
        const bytes = yield* checkContent(content);
        const dir = yield* folder(workspaceId, false);
        if (dir === undefined) return yield* notFound(id);
        const current = yield* readMeta(dir, workspaceId, id);
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
        yield* commit(dir, meta, content);
        yield* publishChanged(workspaceId);
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
