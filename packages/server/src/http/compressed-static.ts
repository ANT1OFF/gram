import * as Effect from "effect/Effect";
import { isInside } from "@gram/git";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import { HttpServerRequest, HttpServerResponse } from "../platform/unstable.ts";

// The web app's files are text that compresses to about a quarter, and a phone or a browser on
// another machine downloads all of it before the first paint. The static server sends files as they
// are on disk, so this compresses its answers: each file once per encoding, kept in memory, since
// the built files never change under a running server.

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

/** Extensions worth compressing: text, and the binaries that still shrink. Images and fonts in `woff2` already are. */
const COMPRESSIBLE = new Set([
  ".html",
  ".js",
  ".mjs",
  ".css",
  ".json",
  ".map",
  ".svg",
  ".txt",
  ".wasm",
  ".ttf",
  ".otf",
  ".webmanifest",
]);
/** Below this a file fits in a packet or two either way. */
const MIN_BYTES = 1024;
/** Hashed in their names by the build, so a name's content never changes. */
const IMMUTABLE = "public, max-age=31536000, immutable";

type Encoding = "br" | "gzip";

/** The best encoding this server makes that `acceptEncoding` allows, honouring `;q=0`. */
export const chooseEncoding = (acceptEncoding: string | undefined): Encoding | undefined => {
  if (acceptEncoding === undefined) return undefined;
  const allowed = new Set<string>();
  for (const part of acceptEncoding.split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    const q = params.map((p) => /^\s*q=([\d.]+)\s*$/.exec(p)?.[1]).find((v) => v !== undefined);
    if (name && (q === undefined || Number(q) > 0)) allowed.add(name);
  }
  return allowed.has("br") ? "br" : allowed.has("gzip") ? "gzip" : undefined;
};

/** The file under `root` that `url` names, or `undefined` for one outside it. */
const fileOf = (root: string, url: string): string | undefined => {
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.split(/[?#]/, 1)[0] ?? "");
  } catch {
    return undefined;
  }
  if (pathname.includes("\0")) return undefined;
  const file = resolve(join(root, pathname));
  return isInside(root, file) ? file : undefined;
};

/**
 * Wraps the static file handler over `webRoot`: a whole, successful answer for a compressible file
 * is sent brotli- or gzip-encoded when the request allows, and files under `/assets/` may be kept
 * for good. Ranges, conditional answers, errors and anything it can't place on disk pass through.
 */
export const compressedStatic = (webRoot: string) => {
  const root = resolve(webRoot);
  const cache = new Map<string, Promise<Uint8Array>>();
  const compressed = (file: string, version: string, encoding: Encoding) => {
    const key = `${file}\0${version}\0${encoding}`;
    let made = cache.get(key);
    if (made === undefined) {
      made = readFile(file).then((bytes) =>
        encoding === "br"
          ? brotliAsync(bytes, {
              params: {
                // Close to the best ratio at a few times gzip's cost, paid once per file.
                [constants.BROTLI_PARAM_QUALITY]: 9,
                [constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength,
              },
            })
          : gzipAsync(bytes, { level: 9 }),
      );
      cache.set(key, made);
      made.catch(() => cache.delete(key));
    }
    return made;
  };

  return <E, R>(
    handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E,
    R | HttpServerRequest.HttpServerRequest
  > =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const response = yield* handler;
      if (request.method !== "GET" || response.status !== 200) return response;
      const pathname = request.url.split(/[?#]/, 1)[0] ?? "";
      const cached = pathname.startsWith("/assets/")
        ? HttpServerResponse.setHeader(response, "Cache-Control", IMMUTABLE)
        : response;
      const encoding = chooseEncoding(request.headers["accept-encoding"]);
      if (
        encoding === undefined ||
        request.headers["range"] !== undefined ||
        response.headers["content-encoding"] !== undefined
      ) {
        return cached;
      }
      // An address with no file is the app's page, which the static server answered with.
      const named = fileOf(root, request.url);
      const isPage = (response.headers["content-type"] ?? "").startsWith("text/html");
      const candidates = [named, isPage ? join(root, "index.html") : undefined];
      const found = yield* Effect.promise(async () => {
        for (const file of candidates) {
          if (file === undefined || !COMPRESSIBLE.has(extname(file).toLowerCase())) continue;
          const info = await stat(file).catch(() => undefined);
          if (info?.isFile() && info.size >= MIN_BYTES) return { file, info };
        }
        return undefined;
      });
      if (found === undefined) return cached;
      const version = `${found.info.size.toString(16)}-${Math.floor(found.info.mtimeMs).toString(16)}`;
      const etag = `"${version}-${encoding}"`;
      const headers = {
        ...cached.headers,
        "content-encoding": encoding,
        vary: "Accept-Encoding",
        etag,
      };
      delete (headers as Record<string, string>)["content-length"];
      delete (headers as Record<string, string>)["accept-ranges"];
      if (request.headers["if-none-match"] === etag) {
        return HttpServerResponse.empty({ status: 304, headers });
      }
      const body = yield* Effect.promise(() =>
        compressed(found.file, version, encoding).catch(() => undefined),
      );
      if (body === undefined) return cached;
      return HttpServerResponse.uint8Array(body, {
        status: 200,
        headers,
        contentType: response.headers["content-type"] ?? "application/octet-stream",
      });
    });
};
