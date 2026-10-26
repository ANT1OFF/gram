import {
  InvalidState,
  isCredentialPath,
  languageFor,
  NotFound,
  writtenFileRefs,
  type FsEntry,
  type FsFile,
  type FsListing,
} from "@gram/contracts";
import { git, isInside, physicalPathAsync, realPath, tryRealPath, type Proc } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import { constants, type Dirent } from "node:fs";
import { lstat, open, readdir, readlink, stat, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { expandHome, missingThreadFolder } from "./folders.ts";
import { listFileNames } from "./names.ts";

export const LIST_LIMIT = 1000;
export const FILE_MAX_BYTES = 512 * 1024;
/** The most `fs.file` reads whatever `maxBytes` asks for. */
export const FILE_MAX_BYTES_CEILING = 2 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8 * 1024;

/** A filesystem failure as a contract error with a message fit for the user, never the raw error. */
const fileError = (
  error: unknown,
  path: string,
  platform: NodeJS.Platform = process.platform,
): NotFound | InvalidState => {
  const code = (error as { code?: unknown } | undefined)?.code;
  switch (code) {
    case "ENOENT":
      return new NotFound({ entity: "file", id: path, message: `Not found: ${path}` });
    case "ENOTDIR":
      return new InvalidState({ message: `Not a folder: ${path}` });
    case "EISDIR":
      return new InvalidState({ message: `Is a folder: ${path}` });
    case "EACCES":
    case "EPERM":
      return new InvalidState({
        message:
          platform === "darwin"
            ? `Gram can't read ${path}. Allow it in System Settings → Privacy & Security → Files & Folders.`
            : `Permission denied: ${path}`,
        access: { path, code: code === "EACCES" ? "EACCES" : "EPERM" },
      });
    default:
      return new InvalidState({ message: `Can't open ${path}` });
  }
};

const attempt = <A>(f: () => Promise<A>, path: string) =>
  Effect.tryPromise({ try: f, catch: (error) => fileError(error, path) });

/**
 * Resolves a request path. With a thread checkout as `root`, relative paths resolve against it and
 * anything that leaves it, lexically or through a symlink, is refused. An absolute path counts as
 * inside by where it really is, so the real path of a file in a checkout opened through a link is
 * inside it, and a link out of the checkout is not. Without a root the path must be absolute (after
 * `~` expansion).
 */
export const resolveScoped = (
  input: string,
  root: string | undefined,
): Effect.Effect<string, NotFound | InvalidState> =>
  Effect.gen(function* () {
    const expanded = expandHome(input.trim());
    if (root === undefined) {
      if (!isAbsolute(expanded)) {
        return yield* new InvalidState({ message: `Use an absolute path: ${input}` });
      }
      return resolve(expanded);
    }
    const outside = new InvalidState({ message: `${input} is outside this thread's folder` });
    const target = resolve(root, expanded);
    if (!isAbsolute(expanded) && !isInside(resolve(root), target)) return yield* outside;
    const realRoot = yield* attempt(() => realPath(root), root).pipe(
      Effect.mapError(() => new InvalidState({ message: missingThreadFolder(root) })),
    );
    if (!isInside(realRoot, yield* Effect.promise(() => physicalPathAsync(target))))
      return yield* outside;
    const realTarget = yield* attempt(() => realPath(target), target);
    if (!isInside(realRoot, realTarget)) return yield* outside;
    return target;
  });

/**
 * The first of `roots` that holds `path`, an absolute path: by where both really are, then, for a
 * root that no longer resolves, as written. `undefined` when none does. Where a path really is
 * (`physicalPathAsync`) doesn't depend on whether it exists, so `/var/x` and `/private/var/x`, or a
 * link to a checkout and the checkout, are one place, and a refusal says nothing about what is
 * outside a root.
 */
const rootHolding = (
  path: string,
  roots: ReadonlyArray<string>,
): Effect.Effect<string | undefined> =>
  Effect.promise(async () => {
    const target = resolve(path);
    const at = await physicalPathAsync(target);
    for (const root of roots) {
      const realRoot = await tryRealPath(root);
      if (realRoot !== undefined && isInside(realRoot, at)) return root;
    }
    return roots.find((root) => isInside(resolve(root), target));
  });

/**
 * `resolveScoped` over several roots: a relative path against the first, an absolute one against
 * the root that holds it. With no roots at all it refuses, rather than falling back to unscoped.
 */
export const resolveScopedIn = (
  input: string,
  roots: ReadonlyArray<string>,
): Effect.Effect<string, NotFound | InvalidState> =>
  Effect.gen(function* () {
    const expanded = expandHome(input.trim());
    const root = isAbsolute(expanded)
      ? ((yield* rootHolding(expanded, roots)) ?? roots[0])
      : roots[0];
    return root === undefined
      ? yield* new InvalidState({ message: `${input} is outside this thread's folder` })
      : yield* resolveScoped(input, root);
  });

/** `input` as a regular file inside `root`; a folder, a missing path and an escape are all none. */
const fileIn = (input: string, root: string): Effect.Effect<Option.Option<string>> =>
  resolveScoped(input, root).pipe(
    Effect.flatMap((target) =>
      attempt(() => stat(target), target).pipe(
        Effect.map((info) => (info.isFile() ? Option.some(target) : Option.none())),
      ),
    ),
    Effect.orElseSucceed(() => Option.none()),
  );

/** Whether `path` is absolute (after `~` expansion) and inside none of `roots`, as `rootHolding` places it. */
export const outsideRoots = (
  path: string,
  roots: ReadonlyArray<string>,
): Effect.Effect<boolean> => {
  const expanded = expandHome(path.trim());
  return isAbsolute(expanded)
    ? rootHolding(expanded, roots).pipe(Effect.map((root) => root === undefined))
    : Effect.succeed(false);
};

/**
 * The ways a message could have written `path` literally: as given, absolute, under `~` when it's
 * in the home folder, and with either separator. A link target that percent-encodes it is read
 * decoded, by `writesPath`.
 */
export const mentionForms = (path: string, home: string = homedir()): string[] => {
  const given = path.trim();
  const absolute = resolve(expandHome(given, home));
  const forms = [given, absolute];
  // oxlint-disable-next-line gram/no-raw-path -- how a message could spell it, not where it is
  if (absolute.startsWith(`${home}${sep}`)) forms.push(`~${absolute.slice(home.length)}`);
  return [
    ...new Set(
      forms.flatMap((form) => [form, form.replaceAll("\\", "/"), form.replaceAll("/", "\\")]),
    ),
  ].filter((form) => form !== "");
};

/**
 * What a message writing one of `forms` holds in its stored text when it doesn't hold the form
 * itself: a `%` from a percent-encoded link target, a `\` from a backslash escape, the only
 * rewrites `writtenFileRefs` undoes, and the file's name, which writing it with `./` or `//`
 * segments leaves as it is. With `forms` they find every message it could read the path in, so a
 * row is never dropped before the comparison decides. For finding the messages to decode, never
 * for deciding.
 */
export const mentionHints = (forms: ReadonlyArray<string>): string[] =>
  forms.length === 0
    ? []
    : [
        "%",
        "\\",
        ...new Set(forms.map((form) => basename(form.replaceAll("\\", "/"))).filter(Boolean)),
      ];

/**
 * `path` as `fileAnywhere` resolves it, lexically: `~` expanded and `.` segments and repeated
 * separators collapsed. A relative path is left as written.
 */
const lexical = (path: string): string => {
  const expanded = expandHome(path.trim());
  return isAbsolute(expanded) ? resolve(expanded) : path;
};

/**
 * Whether `text`, a message's markdown, writes `path` in one of its `mentionForms`: as one of the
 * file references the renderer reads out of it (`writtenFileRefs`), position dropped, either as
 * written or as `fileAnywhere` resolves it (`./` and `//` collapsed). So a path is
 * written only whole, never as the head of `/etc/passwd.bak` or a link to `a.md%23backup`, and a
 * percent-encoded link counts as the path it decodes to.
 */
export const writesPath = (text: string, forms: ReadonlyArray<string>): boolean => {
  const wanted = new Set(forms.flatMap((form) => [form, lexical(form)]));
  // Compared lexically too: `fs.resolve` answers `/tmp/r/./a.md` with `/tmp/r/a.md`, which the
  // preview then asks for.
  return writtenFileRefs(text).some((ref) => wanted.has(ref.path) || wanted.has(lexical(ref.path)));
};

/** `expanded`, an absolute path, when it names a regular file; for paths outside every root. */
const fileAnywhere = (expanded: string): Effect.Effect<Option.Option<string>> => {
  const target = resolve(expanded);
  return attempt(() => stat(target), target).pipe(
    Effect.map((info) => (info.isFile() ? Option.some(target) : Option.none())),
    Effect.orElseSucceed(() => Option.none()),
  );
};

/**
 * The paths an agent wrote that name exactly one file, for linking them. A relative path is tried
 * in every root and an absolute one in the root holding it, through `resolveScoped`, so a path
 * into a root never leads out of it, `..` and symlinks included. A bare file name is also looked
 * up in each root's listing, and links only when no other file anywhere has that name. An absolute
 * path in no root is only checked to be a file, and only when `mentioned` says the thread's
 * messages wrote it: the transcript asks about those one at a time, as they are pointed at.
 */
export const resolveFileRefs = (
  paths: ReadonlyArray<string>,
  roots: ReadonlyArray<string>,
  mentioned: (path: string) => Effect.Effect<boolean> = () => Effect.succeed(false),
): Effect.Effect<Array<{ path: string; resolved: string }>, never, Proc> =>
  Effect.gen(function* () {
    const listings = yield* Effect.forEach(roots, (root) =>
      Effect.cached(
        listFileNames(root).pipe(
          Effect.map((result) =>
            result.entries.filter((entry) => entry.kind === "file").map((entry) => entry.path),
          ),
          Effect.orElseSucceed((): string[] => []),
        ),
      ),
    );
    const byName = (name: string) =>
      Effect.gen(function* () {
        const found: Array<{ root: string; path: string }> = [];
        for (const [index, root] of roots.entries()) {
          for (const path of yield* listings[index]!) {
            if (basename(path) === name) found.push({ root, path: join(root, path) });
          }
        }
        return found;
      });
    const one = (path: string) =>
      Effect.gen(function* () {
        const expanded = expandHome(path.trim());
        const absolute = isAbsolute(expanded);
        const holding = absolute ? yield* rootHolding(expanded, roots) : undefined;
        const candidates = absolute ? (holding === undefined ? [] : [holding]) : roots;
        if (absolute && candidates.length === 0) {
          if (!(yield* mentioned(path))) return [];
          const file = yield* fileAnywhere(expanded);
          return Option.isSome(file) ? [{ path, resolved: file.value }] : [];
        }
        const found = (yield* Effect.forEach(candidates, (root) => fileIn(path, root))).flatMap(
          Option.toArray,
        );
        if (absolute || /[\\/]/.test(path)) {
          return found.length === 1 ? [{ path, resolved: found[0]! }] : [];
        }
        // A bare name is one file only if no root has another of that name at any depth. The
        // listing leaves out ignored files, so what was found at a root counts beside it.
        const named = yield* byName(path);
        const matches = new Set(found);
        for (const { root, path: file } of named) {
          if (matches.has(file)) continue;
          const checked = yield* fileIn(file, root);
          if (Option.isSome(checked)) matches.add(checked.value);
        }
        return matches.size === 1 ? [{ path, resolved: [...matches][0]! }] : [];
      });
    return (yield* Effect.forEach(new Set(paths), one, { concurrency: 8 })).flat();
  });

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Folders first, then natural name order (`file2` before `file10`), case-insensitive. */
const compareEntries = (
  a: { readonly name: string; readonly kind: FsEntry["kind"] },
  b: { readonly name: string; readonly kind: FsEntry["kind"] },
): number =>
  (a.kind === "dir" ? 0 : 1) - (b.kind === "dir" ? 0 : 1) || collator.compare(a.name, b.name);

const kindOf = (dirent: Dirent): FsEntry["kind"] =>
  dirent.isSymbolicLink() ? "symlink" : dirent.isDirectory() ? "dir" : "file";

/**
 * Names in `dir` that git ignores, in one `git check-ignore` call. Folders get a trailing `/` so
 * folder patterns like `dist/` match. Outside a repo, or when git fails, nothing is ignored.
 */
const ignoredNames = (
  dir: string,
  entries: ReadonlyArray<{ readonly name: string; readonly kind: FsEntry["kind"] }>,
): Effect.Effect<ReadonlySet<string>, never, Proc> =>
  Effect.gen(function* () {
    const candidates = entries.filter((e) => e.name !== ".git");
    if (candidates.length === 0) return new Set<string>();
    const stdin = candidates.map((e) => (e.kind === "dir" ? `${e.name}/` : e.name)).join("\0");
    const out = yield* git(dir, ["check-ignore", "-z", "--stdin"], {
      stdin,
      maxOutputBytes: 64 * 1024 * 1024,
    }).pipe(Effect.option);
    // Exit 1 means "nothing ignored"; anything else (128: not a repo) means no answer.
    if (Option.isNone(out) || (out.value.status !== 0 && out.value.status !== 1)) {
      return new Set<string>();
    }
    return new Set(
      out.value.stdout
        .split("\0")
        .filter((p) => p !== "")
        .map((p) => p.replace(/\/$/, "")),
    );
  });

export interface ListOptions {
  readonly showHidden: boolean;
  readonly limit: number;
}

/**
 * A folder's entries for the Files panel. Dotfiles and git-ignored entries are hidden, both revealed
 * by `showHidden`; the contract has no "ignored" marker, so hiding is the only honest option.
 */
export const listFolder = (
  path: string,
  options: ListOptions,
): Effect.Effect<FsListing, NotFound | InvalidState, Proc> =>
  Effect.gen(function* () {
    const dirents = yield* attempt(() => readdir(path, { withFileTypes: true }), path);
    const named = dirents.map((d) => ({ name: d.name, kind: kindOf(d) }));
    const visible = options.showHidden ? named : named.filter((e) => !e.name.startsWith("."));
    const ignored = options.showHidden ? new Set<string>() : yield* ignoredNames(path, visible);
    const kept = visible.filter((e) => !ignored.has(e.name)).toSorted(compareEntries);
    const entries = yield* Effect.forEach(
      kept.slice(0, options.limit),
      (e) =>
        Effect.promise(async (): Promise<FsEntry> => {
          const entryPath = join(path, e.name);
          const info = await lstat(entryPath).catch(() => undefined);
          return {
            name: e.name,
            path: entryPath,
            kind: e.kind,
            ...(info === undefined ? {} : { modifiedAt: Math.floor(info.mtimeMs) }),
            ...(info !== undefined && e.kind === "file" ? { size: info.size } : {}),
          };
        }),
      { concurrency: 16 },
    );
    const parent = dirname(path);
    return {
      path,
      ...(parent === path ? {} : { parent }),
      entries,
      truncated: kept.length > options.limit,
    };
  });

export { languageFor };

/** `path` opened read-only for as long as the scope lasts. */
const openForRead = (
  path: string,
  flags: number = constants.O_RDONLY,
): Effect.Effect<FileHandle, NotFound | InvalidState, Scope.Scope> =>
  Effect.acquireRelease(
    attempt(() => open(path, flags), path),
    (handle) => Effect.promise(() => handle.close()),
  );

const sameFile = (a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }) =>
  a.dev === b.dev && a.ino === b.ino;

/** How much `readUpTo` reads at a time, so what it allocates follows the file, not the limit. */
const READ_CHUNK = 64 * 1024;

/**
 * Up to `limit` bytes from the start of `handle`'s file, however much it holds or grows to, read
 * in chunks: a large `limit` on a small file allocates only what the file holds.
 */
export const readUpTo = async (handle: FileHandle, limit: number): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let filled = 0;
  while (filled < limit) {
    const chunk = Buffer.alloc(Math.min(READ_CHUNK, limit - filled));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, filled);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    filled += bytesRead;
  }
  return Buffer.concat(chunks, filled);
};

/** Test seams: run in the gaps between `openOutside`'s steps, where a racing swap would land. */
export interface OpenRace {
  readonly checked?: (() => Promise<void>) | undefined;
  readonly opened?: (() => Promise<void>) | undefined;
}

/**
 * `target`, a path outside a thread's checkouts that a message named, opened for a preview. It is
 * resolved once to its real path, refused when that or `target` looks like a credential store
 * (`isCredentialPath`), and the identity (device and inode) of the file at the real path is taken
 * then, beside the check. The real path is opened without following a final link, and the handle
 * must be that same file, still at the real path, which still resolves to itself. A folder on the
 * way swapped for a link after the check makes the open reach another file, whose identity isn't
 * the one checked. On Linux the kernel's own name for the open file is checked too, which no swap
 * can change. `allowed` is the caller's own rule for the real path, held to the same file.
 * `regularFile` also rejects special files before and after open, using nonblocking open where
 * supported so a raced FIFO can't park an image-event consumer waiting for a writer.
 */
export const openOutside = (
  target: string,
  race: OpenRace = {},
  allowed: (real: string) => boolean = () => true,
  options: { readonly regularFile?: boolean } = {},
): Effect.Effect<FileHandle, NotFound | InvalidState, Scope.Scope> =>
  Effect.gen(function* () {
    const real = yield* attempt(() => realPath(target), target);
    if (isCredentialPath(target) || isCredentialPath(real)) {
      return yield* new InvalidState({
        message: `Gram doesn't preview files that may hold credentials: ${target}`,
      });
    }
    if (!allowed(real)) {
      return yield* new InvalidState({ message: `${target} isn't where it may be read from` });
    }
    const checked = yield* attempt(() => stat(real, { bigint: true }), real);
    if (options.regularFile && !checked.isFile()) {
      return yield* new InvalidState({ message: `Not a regular file: ${target}` });
    }
    if (race.checked) yield* Effect.promise(race.checked);
    // Windows has no O_NOFOLLOW; the identity checks below cover it there.
    const handle = yield* openForRead(
      real,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (options.regularFile ? (constants.O_NONBLOCK ?? 0) : 0),
    );
    if (race.opened) yield* Effect.promise(race.opened);
    const changed = new InvalidState({ message: `${target} changed while it was opened` });
    const opened = yield* attempt(() => handle.stat({ bigint: true }), real);
    if (options.regularFile && !opened.isFile()) return yield* changed;
    if (!sameFile(opened, checked)) return yield* changed;
    if (process.platform === "linux") {
      const named = yield* attempt(() => readlink(`/proc/self/fd/${handle.fd}`), real);
      if (named !== real || isCredentialPath(named)) return yield* changed;
    }
    const again = yield* attempt(() => realPath(real), real);
    const atPath = yield* attempt(() => stat(real, { bigint: true }), real);
    if (again !== real || !sameFile(opened, atPath)) return yield* changed;
    return handle;
  });

/**
 * A file preview, read through one handle: `opened` when the caller checked and opened the file,
 * else `path` opened here. Binary (a NUL byte in the first 8 KB) and over-`maxBytes` files come
 * back without `content`; text is decoded as UTF-8.
 */
export const readFilePreview = (
  path: string,
  maxBytes: number,
  opened?: FileHandle,
): Effect.Effect<FsFile, NotFound | InvalidState> =>
  Effect.gen(function* () {
    const handle = opened ?? (yield* openForRead(path));
    const info = yield* attempt(() => handle.stat(), path);
    if (info.isDirectory()) return yield* new InvalidState({ message: `Is a folder: ${path}` });
    // At most one byte past the limit, so a file that grew since `stat` is still cut off there.
    const bytes = yield* attempt(
      () => readUpTo(handle, info.size > maxBytes ? BINARY_SNIFF_BYTES : maxBytes + 1),
      path,
    );
    const size = Math.max(info.size, bytes.length);
    const tooLarge = size > maxBytes;
    if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      return { path, size, binary: true, tooLarge };
    }
    const language = languageFor(path);
    const base = { path, size, binary: false, ...(language === undefined ? {} : { language }) };
    if (tooLarge) return { ...base, tooLarge: true };
    return { ...base, tooLarge: false, content: bytes.toString("utf8") };
  }).pipe(Effect.scoped);
