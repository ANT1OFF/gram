import { request as httpRequest } from "node:http";
import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, layer } from "@effect/vitest";
import { isPreviewFilesUrl, GramRpcs, type GramUIMessage } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { captureLogs } from "@gram/agents/testing/logs";
import { ServerConfig } from "../../config.ts";
import { gitPlatformTest } from "../../git/platform.ts";
import { hasGit, makeRepo, removeDir, tempDir } from "../../git/test-repo.ts";
import { LaunchToken, serverPort, ServerLayer } from "../../http/server.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { HttpServer, RpcClient, RpcSerialization, Socket } from "../../platform/unstable.ts";
import { FakeAgentAdapter } from "../../runtime/fake-agent.ts";
import { TurnHooks } from "../../runtime/hooks.ts";
import { TEST_CONFIG } from "../../runtime/test-harness.ts";

const TestServer = ServerLayer.pipe(
  Layer.provide(FakeAgentAdapter),
  Layer.provide(TurnHooks.layerNoop),
  Layer.provide(gitPlatformTest()),
  Layer.provide(ServerConfig.layer(TEST_CONFIG)),
  Layer.orDie,
  // Turns and restores log as they go; a warning would be news.
  Layer.provideMerge(captureLogs({ printWarnings: true }).layer),
);

/** Performs the boot navigation and returns the session cookie. */
const bootCookie = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer;
  const { token } = yield* LaunchToken;
  const port = serverPort(server);
  const setCookie = yield* Effect.promise(
    () =>
      new Promise<string>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port, path: `/?boot=${token}`, agent: false },
          (res) => {
            res.resume();
            resolve(res.headers["set-cookie"]?.[0] ?? "");
          },
        );
        req.on("error", reject);
        req.end();
      }),
  );
  return { port, cookie: setCookie.split(";")[0] ?? "" };
});

const makeClient = Effect.gen(function* () {
  const { port, cookie } = yield* bootCookie;
  const protocol = yield* Layer.build(
    RpcClient.layerProtocolSocket().pipe(
      Layer.provide(Socket.layerWebSocket(`ws://127.0.0.1:${port}/ws`)),
      Layer.provide(
        Layer.succeed(Socket.WebSocketConstructor)(
          (url) =>
            new (globalThis.WebSocket as unknown as new (
              url: string,
              init: { headers: Record<string, string> },
            ) => globalThis.WebSocket)(url, { headers: { cookie } }),
        ),
      ),
      Layer.provide(RpcSerialization.layerJson),
    ),
  );
  return yield* RpcClient.make(GramRpcs).pipe(Effect.provideContext(protocol));
});

/** A GET on the preview listener, with `host` as the Host header when given. */
const getPreview = (url: string, host?: string) =>
  Effect.promise(
    () =>
      new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
        (resolve, reject) => {
          const parsed = new URL(url);
          const req = httpRequest(
            {
              host: parsed.hostname,
              port: parsed.port,
              path: parsed.pathname,
              agent: false,
              ...(host === undefined ? {} : { headers: { host } }),
            },
            (res) => {
              let body = "";
              res.setEncoding("utf8");
              res.on("data", (chunk: string) => (body += chunk));
              res.on("end", () =>
                resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
              );
            },
          );
          req.on("error", reject);
          req.end();
        },
      ),
  );

describe.skipIf(!hasGit)("fs RPCs", () => {
  // Removed only after the server layer's teardown: its watchers and in-flight git refreshes hold the
  // repo until then, and Windows won't delete a held directory.
  const dirs: Array<string> = [];
  afterAll(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  layer(TestServer, { excludeTestServices: true })("over a real socket", (it) => {
    it.effect("list and preview files scoped to a thread's checkout", () =>
      Effect.gen(function* () {
        const dir = tempDir();
        dirs.push(dir);
        const repo = makeRepo(dir);
        mkdirSync(join(repo, "src"));
        writeFileSync(join(repo, "src", "app.ts"), "export const x = 1;\n");
        const client = yield* makeClient;
        const thread = yield* client["thread.create"]({
          projectRoot: repo,
          checkout: { kind: "current" },
        });
        yield* Effect.addFinalizer(() =>
          client["thread.close"]({ threadId: thread.id }).pipe(Effect.ignore),
        );

        const listing = yield* client["fs.list"]({ path: ".", threadId: thread.id });
        expect(listing).toMatchObject({ path: repo, truncated: false });
        expect(listing.entries.map((e) => [e.name, e.kind])).toEqual([
          ["src", "dir"],
          ["tracked.txt", "file"],
        ]);
        const hidden = yield* client["fs.list"]({
          path: ".",
          threadId: thread.id,
          showHidden: true,
        });
        expect(hidden.entries.map((e) => e.name)).toContain(".gitignore");

        expect(yield* client["fs.file"]({ path: "src/app.ts", threadId: thread.id })).toEqual({
          path: join(repo, "src", "app.ts"),
          size: 20,
          binary: false,
          tooLarge: false,
          language: "typescript",
          content: "export const x = 1;\n",
        });
        expect(
          yield* client["fs.file"]({ path: "src/app.ts", threadId: thread.id, maxBytes: 5 }),
        ).toMatchObject({ tooLarge: true });

        expect(
          yield* client["fs.list"]({ path: "..", threadId: thread.id }).pipe(Effect.flip),
        ).toMatchObject({ _tag: "InvalidState", message: ".. is outside this thread's folder" });
        expect(
          yield* client["fs.file"]({ path: "missing.ts", threadId: thread.id }).pipe(Effect.flip),
        ).toMatchObject({ _tag: "NotFound", entity: "file" });

        const unscoped = yield* client["fs.list"]({ path: join(repo, "src") });
        expect(unscoped.entries.map((e) => e.name)).toEqual(["app.ts"]);

        // Outside every checkout, the renderer may read only what the thread's messages wrote, and
        // never a credential file.
        const elsewhere = tempDir();
        dirs.push(elsewhere);
        const report = join(elsewhere, "REPORT.md");
        const unmentioned = join(elsewhere, "other.md");
        const env = join(elsewhere, ".env");
        writeFileSync(report, "x".repeat(3 * 1024 * 1024));
        writeFileSync(unmentioned, "# not in the thread\n");
        writeFileSync(env, "TOKEN=x\n");
        const ampersand = join(elsewhere, "a&b.md");
        writeFileSync(ampersand, "# a and b\n");
        const encoded = pathToFileURL(ampersand)
          .href.replaceAll("&", "%26")
          .replace(/\.md$/, "%2Emd");
        yield* client["thread.send"]({
          threadId: thread.id,
          input: { text: `Wrote \`${report}\`, [notes](${encoded}) and ${env}.` },
        });
        expect(yield* client["fs.file"]({ path: ampersand, threadId: thread.id })).toMatchObject({
          content: "# a and b\n",
        });
        expect(
          yield* client["fs.file"]({
            path: report,
            threadId: thread.id,
            maxBytes: 4 * 1024 * 1024,
          }),
        ).toMatchObject({ tooLarge: true, size: 3 * 1024 * 1024 });
        expect(
          yield* client["fs.file"]({ path: unmentioned, threadId: thread.id }).pipe(Effect.flip),
        ).toMatchObject({
          _tag: "InvalidState",
          message: `${unmentioned} is outside this thread's folder and not in its messages`,
        });
        expect(
          yield* client["fs.image"]({ path: join(elsewhere, "a.png"), threadId: thread.id }).pipe(
            Effect.flip,
          ),
        ).toMatchObject({ _tag: "InvalidState" });
        expect(
          yield* client["fs.file"]({ path: env, threadId: thread.id }).pipe(Effect.flip),
        ).toMatchObject({ _tag: "InvalidState", message: expect.stringContaining("credentials") });
        expect(yield* client["fs.file"]({ path: report }).pipe(Effect.flip)).toMatchObject({
          _tag: "InvalidState",
          message: "Open a file from a thread to preview it",
        });
        expect(
          yield* client["fs.resolve"]({ threadId: thread.id, paths: [report, unmentioned] }),
        ).toEqual({ files: [{ path: report, resolved: report }] });
      }).pipe(Effect.scoped),
    );

    it.effect(
      "previews Markdown and HTML a thread may see, and serves only what sits beside it",
      () =>
        Effect.gen(function* () {
          const dir = tempDir();
          dirs.push(dir);
          const repo = makeRepo(dir);
          writeFileSync(join(repo, "NOTES.md"), "# Notes\n");
          const report = join(dir, "report");
          mkdirSync(join(report, "assets"), { recursive: true });
          writeFileSync(join(report, "index.html"), "<h1>Dashboard</h1>");
          writeFileSync(join(report, "assets", "data.json"), "[1,2,3]");
          writeFileSync(join(report, ".env"), "TOKEN=secret");
          writeFileSync(join(report, "id_rsa"), "key");
          writeFileSync(join(dir, "outside.txt"), "not yours");
          symlinkSync(join(dir, "outside.txt"), join(report, "link.txt"));
          symlinkSync(join(report, ".env"), join(report, "env.txt"));
          writeFileSync(join(report, "summary.md"), "# Summary\n");
          const client = yield* makeClient;
          const store = yield* ThreadStore;
          const thread = yield* client["thread.create"]({
            projectRoot: repo,
            checkout: { kind: "current" },
          });
          yield* Effect.addFinalizer(() =>
            client["thread.close"]({ threadId: thread.id }).pipe(Effect.ignore),
          );

          expect(yield* client["fs.preview"]({ threadId: thread.id, path: "NOTES.md" })).toEqual({
            kind: "markdown",
            path: join(repo, "NOTES.md"),
            content: "# Notes\n",
          });
          const html = join(report, "index.html");
          // Outside its folders and not one it wrote: refused, as is a file that isn't a page.
          expect(
            yield* client["fs.preview"]({ threadId: thread.id, path: html }).pipe(Effect.flip),
          ).toMatchObject({ _tag: "InvalidState" });
          expect(
            yield* client["fs.preview"]({ threadId: thread.id, path: "tracked.txt" }).pipe(
              Effect.flip,
            ),
          ).toMatchObject({ _tag: "InvalidState" });

          // A Write the user refused names the file but wrote nothing: still refused.
          yield* store.upsertMessage(thread.id, {
            id: "m-denied",
            role: "assistant",
            parts: [
              {
                type: "tool-Write",
                toolCallId: "c-0",
                state: "output-denied",
                input: { file_path: html, content: "<h1>Dashboard</h1>" },
              },
            ],
          } as unknown as GramUIMessage);
          expect(
            yield* client["fs.preview"]({ threadId: thread.id, path: html }).pipe(Effect.flip),
          ).toMatchObject({ _tag: "InvalidState" });
          const wrote = {
            id: "m-write",
            role: "assistant",
            parts: [
              {
                type: "tool-Write",
                toolCallId: "c-1",
                state: "output-available",
                input: { file_path: html, content: "<h1>Dashboard</h1>" },
              },
            ],
          } as unknown as GramUIMessage;
          yield* store.upsertMessage(thread.id, wrote);
          // Named in a reply's text only: `fs.file` would show it, the Preview tab wants a Write.
          const summary = join(report, "summary.md");
          yield* store.upsertMessage(thread.id, {
            id: "m-said",
            role: "assistant",
            parts: [{ type: "text", text: `See ${summary}` }],
          } as unknown as GramUIMessage);
          expect(
            yield* client["fs.preview"]({ threadId: thread.id, path: summary }).pipe(Effect.flip),
          ).toMatchObject({ _tag: "InvalidState" });
          yield* store.upsertMessage(thread.id, {
            id: "m-edit",
            role: "assistant",
            parts: [
              {
                type: "tool-Edit",
                toolCallId: "c-2",
                state: "output-available",
                input: { changes: [{ path: summary }] },
              },
            ],
          } as unknown as GramUIMessage);
          expect(yield* client["fs.preview"]({ threadId: thread.id, path: summary })).toEqual({
            kind: "markdown",
            path: summary,
            content: "# Summary\n",
          });
          // The Files panel, where there is no Preview tab, reads what the thread wrote too.
          expect(yield* client["fs.file"]({ threadId: thread.id, path: summary })).toMatchObject({
            content: "# Summary\n",
          });
          const preview = yield* client["fs.preview"]({ threadId: thread.id, path: html });
          expect(preview).toMatchObject({ kind: "html", path: html });
          const url = preview.kind === "html" ? preview.url : "";
          expect(url).toMatch(
            /^http:\/\/127\.0\.0\.1:\d+\/gram-preview-files\/[\w-]+\/index\.html$/,
          );
          expect(isPreviewFilesUrl(url)).toBe(true);

          const page = yield* getPreview(url);
          expect(page).toMatchObject({ status: 200, body: "<h1>Dashboard</h1>" });
          expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
          expect(page.headers["content-security-policy"]).toContain("connect-src 'self'");
          const base = url.slice(0, url.lastIndexOf("/"));
          expect((yield* getPreview(`${base}/assets/data.json`)).body).toBe("[1,2,3]");
          for (const path of [
            ".env",
            "id_rsa",
            "link.txt",
            "env.txt",
            "..%2Foutside.txt",
            "../outside.txt",
          ]) {
            expect((yield* getPreview(`${base}/${path}`)).status).toBe(404);
          }
          expect((yield* getPreview(`${new URL(url).origin}/nope/index.html`)).status).toBe(404);
          // A name rebound to loopback is refused, whatever it resolves to.
          expect((yield* getPreview(url, "evil.example:80")).status).toBe(403);

          // The folder swapped for a link to another, or another directory under its name: the
          // prefix it was shown under no longer answers.
          const other = join(dir, "other");
          mkdirSync(join(other, "assets"), { recursive: true });
          writeFileSync(join(other, "assets", "data.json"), "client data");
          writeFileSync(join(other, "index.html"), "<h1>Other</h1>");
          renameSync(report, join(dir, "report-moved"));
          symlinkSync(other, report);
          expect((yield* getPreview(`${base}/assets/data.json`)).status).toBe(404);
          rmSync(report);
          renameSync(other, report);
          expect((yield* getPreview(`${base}/assets/data.json`)).status).toBe(404);
          // Shown again, the new directory gets a prefix of its own; the old one stays dead.
          const again = yield* client["fs.preview"]({ threadId: thread.id, path: html });
          const againUrl = again.kind === "html" ? again.url : "";
          expect(againUrl.slice(0, againUrl.lastIndexOf("/"))).not.toBe(base);
          expect((yield* getPreview(`${base}/assets/data.json`)).status).toBe(404);
          expect((yield* getPreview(againUrl)).body).toBe("<h1>Other</h1>");

          // A written path retargeted at another page afterwards vouches only for itself: the page it
          // now leads to, which no Write named, stays refused.
          const dashboard = join(dir, "unwritten", "dashboard.html");
          mkdirSync(join(dir, "unwritten"));
          writeFileSync(dashboard, "<h1>Not yours</h1>");
          const retargeted = join(dir, "retargeted.html");
          writeFileSync(retargeted, `<a href="${dashboard}">dashboard</a>`);
          yield* store.upsertMessage(thread.id, {
            id: "m-retargeted",
            role: "assistant",
            parts: [
              {
                type: "tool-Write",
                toolCallId: "c-4",
                state: "output-available",
                input: { file_path: retargeted, content: `<a href="${dashboard}">dashboard</a>` },
              },
            ],
          } as unknown as GramUIMessage);
          rmSync(retargeted);
          symlinkSync(dashboard, retargeted);
          expect(
            yield* client["fs.preview"]({ threadId: thread.id, path: dashboard }).pipe(Effect.flip),
          ).toMatchObject({ _tag: "InvalidState" });

          // A written page that is itself a link into another folder grants neither folder.
          symlinkSync(join(dir, "report-moved", "index.html"), join(dir, "elsewhere.html"));
          yield* store.upsertMessage(thread.id, {
            id: "m-linked",
            role: "assistant",
            parts: [
              {
                type: "tool-Write",
                toolCallId: "c-3",
                state: "output-available",
                input: { file_path: join(dir, "elsewhere.html"), content: "" },
              },
            ],
          } as unknown as GramUIMessage);
          expect(
            yield* client["fs.preview"]({
              threadId: thread.id,
              path: join(dir, "elsewhere.html"),
            }).pipe(Effect.flip),
          ).toMatchObject({ _tag: "InvalidState" });
        }).pipe(Effect.scoped),
    );
  });
});
