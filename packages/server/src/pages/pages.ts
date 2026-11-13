// A workspace's pinned pages (`@gram/contracts` `pages.ts`), kept in Gram's state at
// `<dataDir>/pages/<workspaceId>/<id>/`: `page.json`, its metadata, and one folder per version kept,
// `v<n>/`, each a bundle with its `manifest.json`. Never in a repo, never uploaded.
//
// A version is a copy, made when the user pins or an agent offers: the HTML file's folder read file
// by file through `openOutside` (no link followed out of it, no dotfile, nothing `isCredentialPath`
// names), bounded in files, bytes and depth, and written into a fresh folder of Gram's that is
// renamed into place whole. Nothing written in the worktree afterwards reaches it, and nothing ever
// writes into a version once it is in place: an offer is a new version beside the shown one, and the
// page keeps showing its version until the user shows the offer.
//
// Only the user pins, shows an offer or unpins (`pages.*` RPCs); an agent's one call is `offer`.
//
// Every path is built from checked segments: the workspace id (`WORKSPACE_SEGMENT`), the page id
// (`PAGE_ID_PATTERN`) and a version number. The pages root and the workspace folder are refused when
// they are links or not folders.

import {
  FsError,
  InvalidState,
  isCredentialPath,
  NotFound,
  PAGE_BYTES_MAX,
  PAGE_DEPTH_MAX,
  PAGE_FILES_MAX,
  PAGE_ID_PATTERN,
  PAGE_MANIFEST,
  PAGE_PATH_PATTERN,
  PAGE_TITLE_MAX,
  PAGES_PER_WORKSPACE_MAX,
  PageManifest,
  PageMeta,
  type PageId,
  type ThreadId,
  type WorkspaceId,
} from "@gram/contracts";
import { realPath } from "@gram/git";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, sep } from "node:path";

import { ServerConfig } from "../config.ts";
import { EventHub } from "../events/event-hub.ts";
import { openOutside } from "../fs/files.ts";
import { makeKeyedLock } from "../git/keyed-lock.ts";
import { servedFrom } from "../preview/files.ts";

/** A workspace id as a folder name; ids are UUIDs, tests use short names. */
const WORKSPACE_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
/** The metadata file of a page. */
const META = "page.json";
const META_MAX_BYTES = 16 * 1024;
/** How much of the entry is read for its `<title>`. */
const TITLE_SCAN_BYTES = 64 * 1024;

export type PageError = InvalidState | NotFound | FsError;

/** The thread pinning or offering, as the caller resolved it. */
export interface PageBy {
  readonly threadId: ThreadId;
  readonly title: string;
}

export interface PinPageInput {
  readonly workspaceId: WorkspaceId;
  readonly by: PageBy;
  /** The real path of the HTML file shown, already held to the thread's folders. */
  readonly entry: string;
}

export interface OfferPageInput extends PinPageInput {
  readonly id: PageId;
}

/** A version's folder in Gram's state, resolved, and the entry its manifest names. */
export interface PageFolder {
  readonly folder: string;
  readonly entry: string;
  readonly version: number;
}

export interface PagesShape {
  /** The workspace's pages, newest pin first. A page whose metadata doesn't decode is left out. */
  readonly list: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<PageMeta>, InvalidState | FsError>;
  readonly read: (workspaceId: WorkspaceId, id: PageId) => Effect.Effect<PageMeta, PageError>;
  /** The user's pin: a copy of `entry`'s folder, as version 1 of a new page. */
  readonly pin: (input: PinPageInput) => Effect.Effect<PageMeta, PageError>;
  /** An agent's offer: a copy of `entry`'s folder kept beside the shown version, replacing any earlier offer. */
  readonly offer: (input: OfferPageInput) => Effect.Effect<PageMeta, PageError>;
  /** The shown version's folder, for the page listener. */
  readonly shown: (workspaceId: WorkspaceId, id: PageId) => Effect.Effect<PageFolder, PageError>;
  /** The user shows the offered `version`, which must still be the one on offer. */
  readonly showOffer: (
    workspaceId: WorkspaceId,
    id: PageId,
    version: number,
  ) => Effect.Effect<PageMeta, PageError>;
  readonly unpin: (workspaceId: WorkspaceId, id: PageId) => Effect.Effect<void, PageError>;
}

const refuse = (message: string) => new InvalidState({ message });
const notFound = (id: string) =>
  new NotFound({ entity: "file", id, message: `The page ${id} isn't pinned` });

const codeOf = (error: unknown): unknown => (error as { code?: unknown } | undefined)?.code;

/** Never the raw error, whose message carries absolute paths: only what failed and its code. */
const fsError = (shown: string, error: unknown) => {
  const code = codeOf(error);
  return new FsError({
    path: shown,
    message: `Can't access the page ${shown} (${typeof code === "string" ? code : "unknown error"})`,
  });
};

/** A refusal raised inside a copy, whose message is safe to show. */
class Refusal extends Error {}

const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/** `release-radar-3f9a2c`: the title's words, then six random hex digits. */
export const newPageId = (title: string): PageId => {
  const words = title
    .slice(0, 200)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return `${words === "" ? "page" : words}-${randomBytes(3).toString("hex")}` as PageId;
};

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** The entry's `<title>`, its entities decoded and its spaces folded, cut to `PAGE_TITLE_MAX`. */
export const pageTitle = (html: string, fileName: string): string => {
  const raw = /<title[^>]*>([\s\S]{0,2000}?)<\/title>/i.exec(html)?.[1] ?? "";
  const text = raw
    .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (whole, name: string) => {
      if (name.startsWith("#")) {
        const code =
          name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    })
    // No control or bidirectional override character survives into Gram's chrome.
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const title = text === "" ? basename(fileName, extname(fileName)) : text;
  return title.length <= PAGE_TITLE_MAX ? title : `${title.slice(0, PAGE_TITLE_MAX - 1)}…`;
};

const decodeManifest = Schema.decodeUnknownOption(PageManifest);
const decodeMeta = Schema.decodeUnknownOption(PageMeta);

interface Copied {
  readonly title: string;
  readonly entry: string;
}

/**
 * Copies `source`'s files (the entry's resolved folder) into `dest`, a fresh folder: each regular
 * file under it, read through `openOutside` while its real path is one `servedFrom` allows, so a
 * link out of the folder, a dotfile or a credential file is never read. Links are not followed,
 * other kinds of file are passed over, and a folder past `PAGE_FILES_MAX`, `PAGE_BYTES_MAX` or
 * `PAGE_DEPTH_MAX` is refused rather than cut. A `manifest.json` of the draft's own must name this
 * entry and declare no reads; the bundle's manifest is then written by Gram.
 */
const copyBundle = async (source: string, entryName: string, dest: string): Promise<Copied> => {
  let files = 0;
  let bytes = 0;
  let entryText: string | undefined;
  let draftManifest: Buffer | undefined;
  const readOne = (path: string): Promise<Buffer> =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* openOutside(path, {}, (real) => servedFrom(source, real), {
            regularFile: true,
          });
          const info = yield* Effect.promise(() => handle.stat());
          if (bytes + info.size > PAGE_BYTES_MAX) return undefined;
          // At most one byte past what is left, so a file that grew since `stat` is still caught.
          const buffer = Buffer.alloc(Math.min(info.size, PAGE_BYTES_MAX - bytes) + 1);
          const { bytesRead } = yield* Effect.promise(() =>
            handle.read(buffer, 0, buffer.length, 0),
          );
          return buffer.subarray(0, bytesRead);
        }),
      ),
    ).then(
      (read) => {
        if (read === undefined || bytes + read.length > PAGE_BYTES_MAX) {
          throw new Refusal(`The page's folder is past ${mb(PAGE_BYTES_MAX)}`);
        }
        return read;
      },
      (error: unknown) => {
        if (error instanceof Refusal) throw error;
        throw new Refusal(`${relative(source, path)} changed while it was copied`);
      },
    );
  const walk = async (rel: string, depth: number): Promise<void> => {
    const entries = await readdir(join(source, rel), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (isCredentialPath(path)) continue;
      if (entry.isDirectory()) {
        if (depth >= PAGE_DEPTH_MAX) {
          throw new Refusal(`The page's folder nests deeper than ${PAGE_DEPTH_MAX} folders`);
        }
        await mkdir(join(dest, path));
        await walk(path, depth + 1);
        continue;
      }
      // A link is never followed, inside the folder or out of it, nor a socket or a device read.
      if (!entry.isFile()) continue;
      if (!PAGE_PATH_PATTERN.test(path)) continue;
      files++;
      if (files > PAGE_FILES_MAX) {
        throw new Refusal(
          `The page's folder has more than ${PAGE_FILES_MAX} files. Keep a page in a folder of its own.`,
        );
      }
      const content = await readOne(join(source, ...path.split("/")));
      bytes += content.length;
      if (path === entryName) entryText = content.subarray(0, TITLE_SCAN_BYTES).toString("utf8");
      if (path === PAGE_MANIFEST) {
        draftManifest = content;
        continue;
      }
      await writeFile(join(dest, ...path.split("/")), content, { flag: "wx", mode: 0o600 });
    }
  };
  await walk("", 0);
  if (entryText === undefined) throw new Refusal(`${entryName} isn't a file the page can open`);
  if (draftManifest !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(draftManifest.toString("utf8"));
    } catch {
      throw new Refusal(`The page's ${PAGE_MANIFEST} isn't JSON`);
    }
    const reads: unknown =
      typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "reads") : undefined;
    if (Array.isArray(reads) && reads.length > 0) {
      throw new Refusal(`Pages can't read data yet, so its ${PAGE_MANIFEST} must declare no reads`);
    }
    const manifest = decodeManifest(parsed);
    if (manifest._tag === "None" || manifest.value.entry !== entryName) {
      throw new Refusal(
        `The page's ${PAGE_MANIFEST} must name ${entryName} as its entry and declare no reads`,
      );
    }
  }
  const manifest: PageManifest = { entry: entryName, reads: [] };
  await writeFile(join(dest, PAGE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "w",
    mode: 0o600,
  });
  return { title: pageTitle(entryText, entryName), entry: entryName };
};

/** A folder that must be a real folder of Gram's, never a link: made when `create`. */
const ownFolder = async (path: string, create: boolean): Promise<boolean> => {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Refusal("not a folder of Gram's");
    return true;
  } catch (error) {
    if (error instanceof Refusal || codeOf(error) !== "ENOENT") throw error;
    if (!create) return false;
    await mkdir(path, { mode: 0o700 });
    return ownFolder(path, false);
  }
};

/** `f`, its refusals as `InvalidState` and anything else as an `FsError` naming only `shown`. */
const run = <A>(shown: string, f: () => Promise<A>): Effect.Effect<A, InvalidState | FsError> =>
  Effect.tryPromise({
    try: f,
    catch: (error) => (error instanceof Refusal ? refuse(error.message) : fsError(shown, error)),
  });

const checkedWorkspace = (workspaceId: WorkspaceId) =>
  WORKSPACE_SEGMENT.test(workspaceId)
    ? Effect.succeed(workspaceId)
    : Effect.fail(refuse("That isn't a workspace's id"));
const checkedId = (id: string) =>
  PAGE_ID_PATTERN.test(id) ? Effect.succeed(id as PageId) : Effect.fail(notFound(id));

/** A version's folder, `v<n>` under the page's. */
const versionDir = (at: string, id: PageId, version: number) => join(at, id, `v${version}`);

const readMeta = (at: string, workspaceId: WorkspaceId, id: PageId) =>
  run(id, async () => {
    let text: string;
    try {
      const page = join(at, id);
      if (!(await ownFolder(page, false))) return undefined;
      const info = await lstat(join(page, META));
      if (!info.isFile() || info.size > META_MAX_BYTES) return undefined;
      text = await readFile(join(page, META), "utf8");
    } catch (error) {
      if (codeOf(error) === "ENOENT") return undefined;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return undefined;
    }
    const meta = decodeMeta(parsed);
    if (meta._tag === "None") return undefined;
    return meta.value.id === id && meta.value.workspaceId === workspaceId ? meta.value : undefined;
  });

/** Writes `meta` by one rename, so a failed write leaves the last one whole. */
const writeMeta = (at: string, meta: PageMeta) =>
  run(meta.id, async () => {
    const page = join(at, meta.id);
    const temp = join(page, `.${META}.${randomBytes(6).toString("hex")}`);
    await writeFile(temp, `${JSON.stringify(meta)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temp, join(page, META));
  });

/**
 * Copies `entry`'s folder into a fresh folder in `within` and hands it to `place`, which renames
 * it into place: whole, or not at all.
 */
const copyVersion = (
  within: string,
  entry: string,
  place: (temp: string, copied: Copied) => Promise<void>,
) =>
  run(basename(entry), async () => {
    const temp = join(within, `.copy-${randomBytes(6).toString("hex")}`);
    await mkdir(temp, { mode: 0o700 });
    try {
      const copied = await copyBundle(dirname(entry), basename(entry), temp);
      await place(temp, copied);
      return copied;
    } catch (error) {
      await rm(temp, { recursive: true, force: true });
      throw error;
    }
  });

/** The pages under `root`, one folder per workspace. */
export const makePages = (
  root: string,
  publishChanged: (workspaceId: WorkspaceId) => Effect.Effect<void>,
): PagesShape => {
  const locks = makeKeyedLock<WorkspaceId>();

  /** The workspace's folder, made (with the root) when `create`; `undefined` when there is none. */
  const workspaceFolder = (workspaceId: WorkspaceId, create: boolean) =>
    Effect.gen(function* () {
      yield* checkedWorkspace(workspaceId);
      return yield* run("folder", async () => {
        if (!(await ownFolder(root, create))) return undefined;
        const at = join(root, workspaceId);
        return (await ownFolder(at, create)) ? at : undefined;
      });
    });

  const list: PagesShape["list"] = (workspaceId) =>
    Effect.gen(function* () {
      const at = yield* workspaceFolder(workspaceId, false);
      if (at === undefined) return [];
      const names = yield* run("folder", () => readdir(at));
      const metas: PageMeta[] = [];
      for (const name of names) {
        if (!PAGE_ID_PATTERN.test(name)) continue;
        const meta = yield* readMeta(at, workspaceId, name as PageId);
        if (meta !== undefined) metas.push(meta);
      }
      return metas.toSorted((a, b) => b.pinnedAt - a.pinnedAt);
    });

  const existing = (workspaceId: WorkspaceId, rawId: string) =>
    Effect.gen(function* () {
      const id = yield* checkedId(rawId);
      const at = yield* workspaceFolder(workspaceId, false);
      const meta = at === undefined ? undefined : yield* readMeta(at, workspaceId, id);
      if (at === undefined || meta === undefined) return yield* notFound(id);
      return { at, meta };
    });

  const read: PagesShape["read"] = (workspaceId, id) =>
    Effect.map(existing(workspaceId, id), ({ meta }) => meta);

  const pin: PagesShape["pin"] = (input) =>
    locks.withLock(
      input.workspaceId,
      Effect.uninterruptible(
        Effect.gen(function* () {
          const at = yield* workspaceFolder(input.workspaceId, true);
          if (at === undefined)
            return yield* refuse("The workspace's pages folder couldn't be made");
          const count = (yield* list(input.workspaceId)).length;
          if (count >= PAGES_PER_WORKSPACE_MAX) {
            return yield* refuse(
              `This workspace has ${PAGES_PER_WORKSPACE_MAX} pinned pages. Unpin one to pin another.`,
            );
          }
          let id: PageId | undefined;
          const copied = yield* copyVersion(at, input.entry, async (temp, made) => {
            const fresh = newPageId(made.title);
            await mkdir(join(at, fresh), { mode: 0o700 });
            id = fresh;
            await rename(temp, versionDir(at, fresh, 1));
          }).pipe(
            Effect.tapError(() =>
              id === undefined
                ? Effect.void
                : Effect.promise(() => rm(join(at, id!), { recursive: true, force: true })),
            ),
          );
          if (id === undefined) return yield* refuse("The page couldn't be pinned");
          const now = yield* Clock.currentTimeMillis;
          const meta: PageMeta = {
            id,
            workspaceId: input.workspaceId,
            title: copied.title,
            version: 1,
            entry: copied.entry,
            authorThreadId: input.by.threadId,
            authorTitle: input.by.title.slice(0, PAGE_TITLE_MAX),
            pinnedAt: now,
            updatedAt: now,
          };
          yield* writeMeta(at, meta);
          yield* publishChanged(input.workspaceId);
          return meta;
        }),
      ),
    );

  const offer: PagesShape["offer"] = (input) =>
    locks.withLock(
      input.workspaceId,
      Effect.uninterruptible(
        Effect.gen(function* () {
          const { at, meta } = yield* existing(input.workspaceId, input.id);
          const version = Math.max(meta.version, meta.offer?.version ?? 0) + 1;
          const copied = yield* copyVersion(join(at, meta.id), input.entry, (temp) =>
            rename(temp, versionDir(at, meta.id, version)),
          );
          const now = yield* Clock.currentTimeMillis;
          const next: PageMeta = {
            ...meta,
            offer: {
              version,
              entry: copied.entry,
              title: copied.title,
              threadId: input.by.threadId,
              threadTitle: input.by.title.slice(0, PAGE_TITLE_MAX),
              at: now,
            },
          };
          yield* writeMeta(at, next);
          // The offer it replaces was never shown, so nothing still loads from it.
          if (meta.offer !== undefined) {
            const old = versionDir(at, meta.id, meta.offer.version);
            yield* run(meta.id, () => rm(old, { recursive: true, force: true }));
          }
          yield* publishChanged(input.workspaceId);
          return next;
        }),
      ),
    );

  const shown: PagesShape["shown"] = (workspaceId, id) =>
    Effect.gen(function* () {
      const { at, meta } = yield* existing(workspaceId, id);
      const folder = yield* run(meta.id, async () => {
        const dir = versionDir(at, meta.id, meta.version);
        const info = await lstat(dir);
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Refusal("not a page's folder");
        const real = await realPath(dir);
        // The version's folder, at its own path under the root, not one a link leads to.
        if (real.split(sep).at(-1) !== `v${meta.version}`) throw new Refusal("not a page's folder");
        return real;
      });
      return { folder, entry: meta.entry, version: meta.version };
    });

  const showOffer: PagesShape["showOffer"] = (workspaceId, id, version) =>
    locks.withLock(
      workspaceId,
      Effect.uninterruptible(
        Effect.gen(function* () {
          const { at, meta } = yield* existing(workspaceId, id);
          const offered = meta.offer;
          if (offered === undefined || offered.version !== version) {
            return yield* refuse("That version isn't on offer any more");
          }
          const now = yield* Clock.currentTimeMillis;
          const { offer: _shown, ...rest } = meta;
          const next: PageMeta = {
            ...rest,
            version: offered.version,
            entry: offered.entry,
            title: offered.title,
            updatedAt: now,
          };
          yield* writeMeta(at, next);
          const old = versionDir(at, meta.id, meta.version);
          yield* run(meta.id, () => rm(old, { recursive: true, force: true }));
          yield* publishChanged(workspaceId);
          return next;
        }),
      ),
    );

  const unpin: PagesShape["unpin"] = (workspaceId, id) =>
    locks.withLock(
      workspaceId,
      Effect.uninterruptible(
        Effect.gen(function* () {
          const { at, meta } = yield* existing(workspaceId, id);
          yield* run(meta.id, () => rm(join(at, meta.id), { recursive: true, force: true }));
          yield* publishChanged(workspaceId);
        }),
      ),
    );

  return { list, read, pin, offer, shown, showOffer, unpin };
};

/** The workspaces' pages, under `<dataDir>/pages`. */
export class Pages extends Context.Service<Pages, PagesShape>()("@gram/server/Pages") {
  static readonly layer: Layer.Layer<Pages, never, ServerConfig | EventHub> = Layer.effect(
    Pages,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const hub = yield* EventHub;
      return makePages(join(config.dataDir, "pages"), (workspaceId) =>
        hub.publish({ type: "pages.changed", workspaceId }).pipe(Effect.asVoid),
      );
    }),
  );
}
