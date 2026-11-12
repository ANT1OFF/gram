import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { HttpServerRequest, HttpServerResponse } from "../platform/unstable.ts";
import { chooseEncoding, compressedStatic } from "./compressed-static.ts";

const SCRIPT = `export const words = ${JSON.stringify("retry clock timer ".repeat(400))};\n`;
const PAGE = `<!doctype html><title>Gram</title>${"<p>page</p>".repeat(200)}`;

const root = () => {
  const dir = mkdtempSync(join(tmpdir(), "gram-compressed-static-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "index-abc.js"), SCRIPT);
  writeFileSync(join(dir, "assets", "tiny.js"), "1;");
  writeFileSync(join(dir, "assets", "photo.png"), Buffer.alloc(4096, 7));
  writeFileSync(join(dir, "index.html"), PAGE);
  return dir;
};

/** Answers `path` through the wrapper, over a stand-in for the static server's own answer. */
const answer = (
  dir: string,
  path: string,
  headers: Record<string, string>,
  inner: HttpServerResponse.HttpServerResponse,
) =>
  compressedStatic(dir)(Effect.succeed(inner)).pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(new Request(`http://127.0.0.1${path}`, { headers })),
    ),
  );

const script = HttpServerResponse.text(SCRIPT, { contentType: "text/javascript" });
const bodyOf = (response: HttpServerResponse.HttpServerResponse) =>
  response.body._tag === "Uint8Array" ? Buffer.from(response.body.body) : undefined;

describe("chooseEncoding", () => {
  it("prefers brotli, takes gzip, and honours a refusal", () => {
    expect(chooseEncoding("gzip, deflate, br, zstd")).toBe("br");
    expect(chooseEncoding("gzip, deflate")).toBe("gzip");
    expect(chooseEncoding("br;q=0, gzip;q=0.5")).toBe("gzip");
    expect(chooseEncoding("identity")).toBeUndefined();
    expect(chooseEncoding(undefined)).toBeUndefined();
  });
});

describe("compressedStatic", () => {
  it.effect("compresses a script, names the encoding and lets a hashed asset be kept", () =>
    Effect.gen(function* () {
      const dir = root();
      const gz = yield* answer(dir, "/assets/index-abc.js", { "accept-encoding": "gzip" }, script);
      expect(gz.headers["content-encoding"]).toBe("gzip");
      expect(gz.headers["vary"]).toBe("Accept-Encoding");
      expect(gz.headers["cache-control"]).toContain("immutable");
      expect(gz.headers["content-type"]).toContain("text/javascript");
      expect(gunzipSync(bodyOf(gz)!).toString()).toBe(SCRIPT);
      expect(bodyOf(gz)!.byteLength).toBeLessThan(SCRIPT.length / 4);

      const br = yield* answer(
        dir,
        "/assets/index-abc.js?v=1",
        { "accept-encoding": "br" },
        script,
      );
      expect(br.headers["content-encoding"]).toBe("br");
      expect(brotliDecompressSync(bodyOf(br)!).toString()).toBe(SCRIPT);
      expect(br.headers["etag"]).not.toBe(gz.headers["etag"]);

      const again = yield* answer(
        dir,
        "/assets/index-abc.js",
        { "accept-encoding": "gzip", "if-none-match": gz.headers["etag"]! },
        script,
      );
      expect(again.status).toBe(304);
      rmSync(dir, { recursive: true, force: true });
    }),
  );

  it.effect("compresses the page an address with no file gets, without keeping it for good", () =>
    Effect.gen(function* () {
      const dir = root();
      const page = yield* answer(
        dir,
        "/t/some-thread",
        { "accept-encoding": "gzip" },
        HttpServerResponse.text(PAGE, { contentType: "text/html" }),
      );
      expect(page.headers["content-encoding"]).toBe("gzip");
      expect(page.headers["cache-control"]).toBeUndefined();
      expect(gunzipSync(bodyOf(page)!).toString()).toBe(PAGE);
      rmSync(dir, { recursive: true, force: true });
    }),
  );

  it.effect("passes through what it must not touch", () =>
    Effect.gen(function* () {
      const dir = root();
      const plain = yield* answer(dir, "/assets/index-abc.js", {}, script);
      expect(plain.headers["content-encoding"]).toBeUndefined();
      const range = yield* answer(
        dir,
        "/assets/index-abc.js",
        { "accept-encoding": "gzip", range: "bytes=0-9" },
        script,
      );
      expect(range.headers["content-encoding"]).toBeUndefined();
      const tiny = yield* answer(dir, "/assets/tiny.js", { "accept-encoding": "gzip" }, script);
      expect(tiny.headers["content-encoding"]).toBeUndefined();
      const image = yield* answer(
        dir,
        "/assets/photo.png",
        { "accept-encoding": "gzip" },
        HttpServerResponse.text("png", { contentType: "image/png" }),
      );
      expect(image.headers["content-encoding"]).toBeUndefined();
      const missing = yield* answer(
        dir,
        "/assets/gone.js",
        { "accept-encoding": "gzip" },
        HttpServerResponse.text("no", { status: 404 }),
      );
      expect(missing.status).toBe(404);
      expect(missing.headers["content-encoding"]).toBeUndefined();
      const outside = yield* answer(
        dir,
        "/assets/%2e%2e/%2e%2e/etc/passwd.txt",
        { "accept-encoding": "gzip" },
        HttpServerResponse.text("no", { contentType: "text/plain" }),
      );
      expect(outside.headers["content-encoding"]).toBeUndefined();
      rmSync(dir, { recursive: true, force: true });
    }),
  );
});
