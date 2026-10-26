// The only door through which a file on disk reaches the Preview tab's page. The shell's preview
// loads loopback http and nothing else (`@gram/shell` `preview-rules.ts`), so an HTML file a
// thread wrote is served here, on a listener of its own, never the app's: the page is untrusted and
// must not share the app's origin. Each folder shown gets an unguessable path prefix, under
// contracts' `PREVIEW_FILES_SEGMENT`, and only files under that folder answer, read-only, with no
// dotfiles and nothing `isCredentialPath` names, each opened through `openOutside`.

import { InvalidState, isCredentialPath, PREVIEW_FILES_SEGMENT } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { openOutside } from "../fs/files.ts";
import { isInside, realPath } from "@gram/git";

/** How many folders keep a live prefix; showing another forgets the least recently shown. */
const PREVIEW_FOLDERS_KEPT = 64;

/** No file over this answers: a preview is a page and what it loads, not a file share. */
const PREVIEW_FILE_MAX_BYTES = 50 * 1024 * 1024;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

/** The extensions `PreviewFiles.urlFor` opens as a page. */
const isPreviewHtml = (path: string): boolean => /\.html?$/i.test(path);

/**
 * What every response carries. The page may run its own scripts, load what sits beside it and fetch
 * from its own folder; nothing reaches another host (the shell's rules hold that too), it can't be
 * framed, and forms post nowhere.
 */
const PREVIEW_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": [
    "default-src 'self' data: blob:",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
    "style-src 'self' 'unsafe-inline' data:",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
};

/** Folders by prefix, least recently shown first, and the prefix each folder has. */
export interface PreviewFolders {
  readonly byPrefix: Map<string, string>;
  readonly byFolder: Map<string, string>;
  /**
   * Which directory each folder was when it was shown (device and inode): a prefix answers only
   * while its path is still that directory, never one swapped in under the same name since.
   */
  readonly identity: Map<string, FolderIdentity>;
}

/** A directory's device and inode, as `stat` with `bigint` gives them. */
interface FolderIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

export const emptyPreviewFolders = (): PreviewFolders => ({
  byPrefix: new Map(),
  byFolder: new Map(),
  identity: new Map(),
});

/** `folder`'s prefix, a new one the first time; forgets the least recently shown past `kept`. */
export function prefixFor(
  folders: PreviewFolders,
  folder: string,
  kept: number = PREVIEW_FOLDERS_KEPT,
  mint: () => string = () => randomBytes(18).toString("base64url"),
): string {
  const known = folders.byFolder.get(folder);
  const prefix = known ?? mint();
  // Re-inserted, so iteration order is least recently shown first.
  folders.byFolder.delete(folder);
  folders.byFolder.set(folder, prefix);
  folders.byPrefix.delete(prefix);
  folders.byPrefix.set(prefix, folder);
  while (folders.byPrefix.size > kept) {
    const [oldest, oldFolder] = folders.byPrefix.entries().next().value!;
    folders.byPrefix.delete(oldest);
    folders.byFolder.delete(oldFolder);
    folders.identity.delete(oldFolder);
  }
  return prefix;
}

/** Drops `folder`'s prefix, so nothing loads under it again. */
function forgetFolder(folders: PreviewFolders, folder: string): void {
  const prefix = folders.byFolder.get(folder);
  if (prefix !== undefined) folders.byPrefix.delete(prefix);
  folders.byFolder.delete(folder);
  folders.identity.delete(folder);
}

/** What a request for `urlPath` under `folders` answers, before any file is read. */
export type PreviewLookup =
  | { readonly kind: "file"; readonly folder: string; readonly relative: string }
  | { readonly kind: "notFound" };

/**
 * The file a request path names: `/gram-preview-files/<prefix>/<path within the folder>`. A segment
 * that is empty, `.`, `..` or starts with a dot answers not found before the disk is asked, as does
 * a path `isCredentialPath` names: a dashboard written beside a repo's `.env`, an SSH key or a
 * `.git` folder can't read them.
 */
export function lookupPreview(folders: PreviewFolders, urlPath: string): PreviewLookup {
  const notFound = { kind: "notFound" } as const;
  const [, root, prefix, ...rest] = urlPath.split("?")[0]!.split("#")[0]!.split("/");
  const folder =
    root !== PREVIEW_FILES_SEGMENT || prefix === undefined
      ? undefined
      : folders.byPrefix.get(prefix);
  if (folder === undefined || rest.length === 0) return notFound;
  const segments: Array<string> = [];
  for (const raw of rest) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return notFound;
    }
    // An encoded separator would smuggle `..` past the split above.
    if (segment === "" || segment.startsWith(".") || /[/\\\0]/.test(segment)) return notFound;
    segments.push(segment);
  }
  const path = segments.join("/");
  if (isCredentialPath(path)) return notFound;
  return { kind: "file", folder, relative: path };
}

const answer = (res: ServerResponse, status: number, text: string) => {
  res.writeHead(status, { ...PREVIEW_HEADERS, "content-type": "text/plain; charset=utf-8" });
  res.end(text);
};

/**
 * Whether `real`, a resolved path, may be served from `folder`, also resolved: inside it, and
 * through no dotfile or dot folder, so a link inside the folder to its `.env` or into `.git` is as
 * hidden as they are.
 */
export const servedFrom = (folder: string, real: string): boolean =>
  isInside(folder, real) &&
  !relative(folder, real)
    .split(sep)
    .some((part) => part.startsWith("."));

/** Why a request answers 404: missing, unreadable, a link out of its folder, or refused. */
class PreviewMissing extends Data.TaggedError("PreviewMissing")<{}> {}

const missing = () => new PreviewMissing();

/**
 * Serves the file a lookup names, through `openOutside`, while its folder is still the directory
 * that was shown: its real path must be one `servedFrom` allows and no credential file, and the
 * handle is the file that was checked, so a swap after the check serves nothing. Over `PREVIEW_FILE_MAX_BYTES`, or not a regular file, it is missing.
 */
const serveFile = (
  folders: PreviewFolders,
  lookup: Extract<PreviewLookup, { kind: "file" }>,
  req: IncomingMessage,
  res: ServerResponse,
) =>
  Effect.gen(function* () {
    const { folder } = lookup;
    // The folder must still be the directory that was shown, at its real path, before the open
    // and after it: a link or another directory put in its place serves nothing.
    const unchanged = Effect.tryPromise({
      try: async () => {
        const shown = folders.identity.get(folder);
        if (shown === undefined || (await realPath(folder)) !== folder) return false;
        const now = await stat(folder, { bigint: true });
        return now.dev === shown.dev && now.ino === shown.ino;
      },
      catch: missing,
    }).pipe(Effect.flatMap((same) => (same ? Effect.void : Effect.fail(missing()))));
    yield* unchanged;
    // Held on the very path `openOutside` resolves and opens, so a link swapped in after a check
    // of our own can't take the open out of the folder.
    let path = "";
    const handle = yield* openOutside(resolve(folder, lookup.relative), {}, (real) => {
      path = real;
      return servedFrom(folder, real);
    }).pipe(Effect.mapError(missing));
    yield* unchanged;
    const info = yield* Effect.tryPromise({ try: () => handle.stat(), catch: missing });
    if (!info.isFile() || info.size > PREVIEW_FILE_MAX_BYTES) return yield* missing();
    res.writeHead(200, {
      ...PREVIEW_HEADERS,
      "content-type": CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
      "content-length": String(info.size),
    });
    if (req.method === "HEAD" || info.size === 0) return void res.end();
    // The handle stays open, in this scope, until the response is done with it.
    yield* Effect.callback<void>((resume) => {
      if (res.destroyed) return resume(Effect.void);
      // Ends at the size the headers promised, however the file grows meanwhile.
      const stream = handle.createReadStream({ start: 0, end: info.size - 1, autoClose: false });
      // A file deleted mid-read ends the response; the page sees a short body.
      stream.on("error", () => res.destroy());
      res.once("close", () => resume(Effect.void));
      stream.pipe(res);
    });
  }).pipe(
    Effect.scoped,
    Effect.catchTag("PreviewMissing", () => Effect.sync(() => answer(res, 404, "not found"))),
  );

/** The Host header's host, when it is loopback: anything else is a rebound name and is refused. */
const loopbackHost = (host: string | undefined): boolean => {
  if (host === undefined) return false;
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0]!;
  return LOOPBACK.has(name.toLowerCase());
};

/** One request to the preview listener: GET or HEAD, on a loopback Host, for a file it may serve. */
const handlePreviewRequest =
  (folders: PreviewFolders) =>
  (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== "GET" && req.method !== "HEAD") return answer(res, 405, "read only");
    if (!loopbackHost(req.headers.host)) return answer(res, 403, "not here");
    const lookup = lookupPreview(folders, req.url ?? "/");
    if (lookup.kind === "notFound") return answer(res, 404, "not found");
    void Effect.runPromise(serveFile(folders, lookup, req, res)).catch(() => {
      if (!res.headersSent) answer(res, 500, "unreadable");
      else res.destroy();
    });
  };

export interface PreviewFilesShape {
  /**
   * The listener's origin, `http://127.0.0.1:<port>`: one of Gram's own, which the agent
   * browser tools refuse (`PaneLimits.appOrigins`), beside contracts' `isPreviewFilesUrl`.
   */
  readonly origin: string;
  /**
   * A loopback URL the Preview tab's page can load `real` from, the files beside it included:
   * `real` is the resolved path of an HTML file the caller allowed as resolved, and is refused
   * unless it still resolves to itself, so the folder granted is the one the caller checked.
   * `InvalidState` for anything that isn't such a file.
   */
  urlFor(real: string): Effect.Effect<string, InvalidState>;
}

/** The preview file listener: on its own loopback port, started with the server, closed with it. */
export class PreviewFiles extends Context.Service<PreviewFiles, PreviewFilesShape>()(
  "@gram/server/PreviewFiles",
) {
  static readonly layer: Layer.Layer<PreviewFiles> = Layer.effect(
    PreviewFiles,
    Effect.gen(function* () {
      const folders = emptyPreviewFolders();
      const server = yield* Effect.acquireRelease(
        Effect.callback<ReturnType<typeof createServer>>((resume) => {
          const created = createServer(handlePreviewRequest(folders));
          created.once("error", (error) => resume(Effect.die(error)));
          created.listen(0, "127.0.0.1", () => resume(Effect.succeed(created)));
        }),
        (created) =>
          Effect.callback<void>((resume) => {
            created.closeAllConnections();
            created.close(() => resume(Effect.void));
          }),
      );
      const port = (server.address() as AddressInfo).port;
      return PreviewFiles.of({
        origin: `http://127.0.0.1:${port}`,
        urlFor: (real) =>
          Effect.tryPromise({
            try: async () => {
              if (!isAbsolute(real) || !isPreviewHtml(real)) throw new Error("not an HTML file");
              if ((await realPath(real)) !== real) throw new Error("changed since it was checked");
              if (isCredentialPath(real)) throw new Error("may hold credentials");
              if (!(await stat(real)).isFile()) throw new Error("not a file");
              const folder = dirname(real);
              const { dev, ino } = await stat(folder, { bigint: true });
              // Another directory under the folder's name gets a prefix of its own: one a page
              // loaded before never reaches it.
              const shown = folders.identity.get(folder);
              if (shown !== undefined && (shown.dev !== dev || shown.ino !== ino)) {
                forgetFolder(folders, folder);
              }
              const prefix = prefixFor(folders, folder);
              folders.identity.set(folder, { dev, ino });
              const name = encodeURIComponent(basename(real));
              return `http://127.0.0.1:${port}/${PREVIEW_FILES_SEGMENT}/${prefix}/${name}`;
            },
            catch: () => new InvalidState({ message: `${real} isn't an HTML file to preview` }),
          }),
      });
    }),
  );
}

/** The tool calls that change a file, by the name their part carries (`tool-<name>`). */
const FILE_WRITERS = new Set(["tool-Write", "tool-Edit", "tool-MultiEdit", "tool-NotebookEdit"]);

/**
 * The files a message's own finished Write and Edit calls name: Claude's `file_path`, and each path
 * of a Codex change set (`changes[].path`), as the agent wrote them.
 */
export function filesWrittenBy(message: { readonly parts: ReadonlyArray<unknown> }): string[] {
  const out: Array<string> = [];
  for (const part of message.parts) {
    if (typeof part !== "object" || part === null) continue;
    const type: unknown = Reflect.get(part, "type");
    if (typeof type !== "string" || !FILE_WRITERS.has(type)) continue;
    // A call still running, refused or failed wrote nothing the thread may show.
    if (Reflect.get(part, "state") !== "output-available") continue;
    const input: unknown = Reflect.get(part, "input");
    if (typeof input !== "object" || input === null) continue;
    const path: unknown = Reflect.get(input, "file_path") ?? Reflect.get(input, "notebook_path");
    if (typeof path === "string") out.push(path);
    const changes: unknown = Reflect.get(input, "changes");
    if (Array.isArray(changes)) {
      for (const change of changes) {
        const changed: unknown =
          typeof change === "object" && change !== null ? Reflect.get(change, "path") : undefined;
        if (typeof changed === "string") out.push(changed);
      }
    }
  }
  return out;
}
