import * as fs from "node:fs";
import * as nodePath from "node:path";
import { request as httpRequest } from "node:http";
import { afterAll, describe, expect, layer } from "@effect/vitest";
import { GramRpcs, type TurnId } from "@gram/contracts";
import { ProcLive, snapshotCheckpoint } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../../config.ts";
import { gitPlatformTest } from "../../git/platform.ts";
import { hasGit, makeRepo, removeDir, run, tempDir, write } from "../../git/test-repo.ts";
import { LaunchToken, serverPort, ServerLayer } from "../../http/server.ts";
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
);

const makeClient = Effect.gen(function* () {
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
  const cookie = setCookie.split(";")[0] ?? "";
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

/** A file of `count` numbered lines. */
const numberedLines = (count: number, tag = "line") =>
  Array.from({ length: count }, (_, i) => `${tag} ${i + 1}`)
    .join("\n")
    .concat("\n");

/** `count` lines with every `every`th one changed, so each change is a hunk of its own. */
const sparseEdit = (count: number, every: number) =>
  Array.from({ length: count }, (_, i) => (i % every === 0 ? `edited ${i + 1}` : `line ${i + 1}`))
    .join("\n")
    .concat("\n");

describe.skipIf(!hasGit)("git.diffChunk", () => {
  const dirs: Array<string> = [];
  afterAll(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  layer(TestServer, { excludeTestServices: true })("over a real socket", (it) => {
    const setup = Effect.gen(function* () {
      const dir = tempDir();
      dirs.push(dir);
      const repo = makeRepo(dir);
      const client = yield* makeClient;
      const thread = yield* client["thread.create"]({
        projectRoot: repo,
        checkout: { kind: "current" },
      });
      yield* Effect.addFinalizer(() =>
        client["thread.close"]({ threadId: thread.id }).pipe(Effect.ignore),
      );
      return { repo, client, threadId: thread.id };
    });

    it.effect("pages through a file's hunks with a cursor, to an empty chunk past the end", () =>
      Effect.gen(function* () {
        const { repo, client, threadId } = yield* setup;
        write(nodePath.join(repo, "big.txt"), numberedLines(600));
        run(repo, "add", "-A");
        run(repo, "commit", "-qm", "base");
        // A change every 10 lines: 60 hunks, far apart enough not to merge.
        write(nodePath.join(repo, "big.txt"), sparseEdit(600, 10));
        const chunk = (cursor?: { hunk: number; line: number }, fingerprint?: string) =>
          client["git.diffChunk"]({
            threadId,
            scope: { kind: "uncommitted" },
            path: "big.txt",
            hunks: 25,
            ...(cursor === undefined ? {} : { cursor }),
            ...(fingerprint === undefined ? {} : { fingerprint }),
          });
        const first = yield* chunk();
        expect(first).toMatchObject({
          path: "big.txt",
          binary: false,
          changed: false,
          partial: false,
          totalHunks: 60,
          additions: 60,
          deletions: 60,
          next: { hunk: 25, line: 0 },
        });
        expect(first.patch.match(/^@@/gm)).toHaveLength(25);
        expect(first.patch.startsWith("@@ -1,4 +1,4 @@\n-line 1\n+edited 1\n")).toBe(true);
        const second = yield* chunk(first.next, first.fingerprint);
        expect(second.next).toEqual({ hunk: 50, line: 0 });
        expect(second.patch.split("\n")[0]).toMatch(/^@@ -248,7 \+248,7 @@/);
        const third = yield* chunk(second.next, first.fingerprint);
        expect(third.next).toBeUndefined();
        expect(third.patch.match(/^@@/gm)).toHaveLength(10);
        const past = yield* chunk({ hunk: 60, line: 0 }, first.fingerprint);
        expect(past).toMatchObject({ patch: "", changed: false, totalHunks: 60 });
        expect(past.next).toBeUndefined();

        // The file changed after the first chunk: the next one says so instead of mixing patches.
        write(nodePath.join(repo, "big.txt"), sparseEdit(600, 7));
        expect(yield* chunk(first.next, first.fingerprint)).toMatchObject({
          changed: true,
          patch: "",
        });
      }).pipe(Effect.scoped),
    );

    it.effect("splits one hunk past the line cap into numbered parts", () =>
      Effect.gen(function* () {
        const { repo, client, threadId } = yield* setup;
        write(nodePath.join(repo, "long.txt"), numberedLines(2500, "new"));
        const first = yield* client["git.diffChunk"]({
          threadId,
          scope: { kind: "uncommitted" },
          path: "long.txt",
        });
        // Untracked: one all-added hunk, served a thousand lines at a time.
        expect(first).toMatchObject({
          totalHunks: 1,
          additions: 2500,
          next: { hunk: 0, line: 1000 },
        });
        expect(first.patch.split("\n")[0]).toBe("@@ -0,0 +1,1000 @@");
        const second = yield* client["git.diffChunk"]({
          threadId,
          scope: { kind: "uncommitted" },
          path: "long.txt",
          cursor: first.next!,
        });
        expect(second.patch.split("\n").slice(0, 2)).toEqual([
          "@@ -0,0 +1001,1000 @@",
          "+new 1001",
        ]);
        expect(second.next).toEqual({ hunk: 0, line: 2000 });
      }).pipe(Effect.scoped),
    );

    it.effect("serves a binary file and a rename for what they are", () =>
      Effect.gen(function* () {
        const { repo, client, threadId } = yield* setup;
        fs.writeFileSync(nodePath.join(repo, "image.bin"), Buffer.from([0, 1, 2, 0, 3]));
        write(nodePath.join(repo, "before.txt"), numberedLines(40));
        run(repo, "add", "-A");
        run(repo, "commit", "-qm", "base");
        fs.writeFileSync(nodePath.join(repo, "image.bin"), Buffer.from([0, 7, 7, 0, 3]));
        run(repo, "mv", "before.txt", "after.txt");
        write(nodePath.join(repo, "after.txt"), `${numberedLines(40)}line 41\n`);
        run(repo, "add", "-A");
        const binary = yield* client["git.diffChunk"]({
          threadId,
          scope: { kind: "uncommitted" },
          path: "image.bin",
        });
        expect(binary).toMatchObject({ binary: true, patch: "", totalHunks: 0 });
        expect(binary.next).toBeUndefined();
        const renamed = yield* client["git.diffChunk"]({
          threadId,
          scope: { kind: "uncommitted" },
          path: "after.txt",
          oldPath: "before.txt",
        });
        expect(renamed).toMatchObject({ additions: 1, deletions: 0, totalHunks: 1 });
        expect(renamed.patch).toContain("+line 41");
        expect(
          yield* client["git.diffChunk"]({
            threadId,
            scope: { kind: "uncommitted" },
            path: "nowhere.txt",
          }).pipe(Effect.flip),
        ).toMatchObject({ _tag: "NotFound", entity: "file", id: "nowhere.txt" });
      }).pipe(Effect.scoped),
    );

    it.effect("reads a turn from its checkpoints and a branch against its base", () =>
      Effect.gen(function* () {
        const { repo, client, threadId } = yield* setup;
        run(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
        run(repo, "checkout", "-q", "-b", "feat");
        const snapshot = (id: string) =>
          snapshotCheckpoint(repo, threadId, id).pipe(Effect.provide(ProcLive));
        yield* snapshot("turn-1");
        write(
          nodePath.join(repo, "pnpm-lock.yaml"),
          "packages:\n\n  /zod@4.7.0:\n    resolution: {integrity: sha512-n}\n",
        );
        yield* snapshot("turn-1.end");
        const turn = yield* client["git.diffChunk"]({
          threadId,
          scope: { kind: "turn", turnId: "turn-1" as TurnId },
          path: "pnpm-lock.yaml",
          mode: "summary",
        });
        expect(turn).toMatchObject({
          generated: "lockfile",
          patch: "",
          summary: {
            hunks: 1,
            additions: 4,
            deletions: 0,
            sections: [
              { name: "Lines 1–4", additions: 2, deletions: 0 },
              { name: "zod", additions: 2, deletions: 0 },
            ],
            moreSections: 0,
          },
        });
        run(repo, "add", "-A");
        run(repo, "commit", "-qm", "lock");
        const branch = yield* client["git.diffChunk"]({
          threadId,
          scope: { kind: "branch" },
          path: "pnpm-lock.yaml",
        });
        expect(branch).toMatchObject({ generated: "lockfile", totalHunks: 1, additions: 4 });
        // A clean tree's uncommitted diff is the branch's, as `git.diff` falls back to.
        const fallback = yield* client["git.diffChunk"]({
          threadId,
          scope: { kind: "uncommitted" },
          path: "pnpm-lock.yaml",
        });
        expect(fallback.patch).toBe(branch.patch);
      }).pipe(Effect.scoped),
    );
  });
});
