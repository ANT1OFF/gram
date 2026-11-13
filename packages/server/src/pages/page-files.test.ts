import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PageFiles } from "./page-files.ts";

/** One request to the listener: its status, headers and body. */
const fetchRaw = (url: string, init: { method?: string; host?: string; origin?: string } = {}) =>
  new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
    (resolve, reject) => {
      const target = new URL(url);
      const req = request(
        {
          host: target.hostname,
          port: target.port,
          path: target.pathname,
          method: init.method ?? "GET",
          headers: {
            ...(init.host === undefined ? {} : { host: init.host }),
            ...(init.origin === undefined ? {} : { origin: init.origin }),
          },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        },
      );
      req.on("error", reject);
      req.end();
    },
  );

describe("the page listener", () => {
  it.effect("serves a pinned version's files under its token, sandboxed, and nothing else", () =>
    Effect.gen(function* () {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "gram-page-files-")));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
      );
      const version = join(dir, "v1");
      const other = join(dir, "v2");
      mkdirSync(version);
      mkdirSync(other);
      writeFileSync(join(version, "index.html"), "<title>Board</title>");
      writeFileSync(join(version, ".env"), "TOKEN=synthetic");
      writeFileSync(join(other, "index.html"), "<title>Other</title>");
      const files = yield* PageFiles;
      const url = yield* files.urlFor(version, "index.html");
      expect(url).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/gram-pages\/[A-Za-z0-9_-]{24}\/index\.html$/,
      );
      expect(url.startsWith(files.origin)).toBe(true);
      const ok = yield* Effect.promise(() => fetchRaw(url));
      expect(ok.status).toBe(200);
      expect(ok.body).toBe("<title>Board</title>");
      const csp = String(ok.headers["content-security-policy"]);
      expect(csp).toContain("sandbox allow-scripts");
      expect(csp).toContain("connect-src 'none'");
      expect(ok.headers["access-control-allow-origin"]).toBeUndefined();
      // The page's own opaque origin may load its module scripts and fonts; no other origin.
      const fromPage = yield* Effect.promise(() => fetchRaw(url, { origin: "null" }));
      expect(fromPage.headers["access-control-allow-origin"]).toBe("null");
      const fromSite = yield* Effect.promise(() =>
        fetchRaw(url, { origin: "https://example.com" }),
      );
      expect(fromSite.headers["access-control-allow-origin"]).toBeUndefined();
      // Another version is another token: one URL never reaches the other's files.
      const otherUrl = yield* files.urlFor(other, "index.html");
      expect(otherUrl.split("/")[4]).not.toBe(url.split("/")[4]);
      const base = url.slice(0, url.lastIndexOf("/"));
      for (const [label, target, init] of [
        ["a dotfile", `${base}/.env`, {}],
        ["an escape", `${base}/..%2Fv2%2Findex.html`, {}],
        [
          "an unknown token",
          url.replace(/gram-pages\/[^/]+/, "gram-pages/AAAAAAAAAAAAAAAAAAAAAAAA"),
          {},
        ],
        ["the preview files' segment", url.replace("gram-pages", "gram-preview-files"), {}],
        ["a write", url, { method: "POST" }],
        ["a rebound name", url, { host: "evil.example" }],
      ] as const) {
        const answer = yield* Effect.promise(() => fetchRaw(target, init));
        expect(answer.status, label).not.toBe(200);
        expect(answer.body, label).not.toContain("Board");
      }
      // A folder reached through a link, not as Gram resolved it, is refused.
      symlinkSync(version, join(dir, "linked"));
      const refused = yield* Effect.exit(files.urlFor(join(dir, "linked"), "index.html"));
      expect(refused._tag).toBe("Failure");
    }).pipe(Effect.provide(PageFiles.layer), Effect.scoped),
  );
});
