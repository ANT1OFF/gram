import { readFileSync } from "node:fs";
import * as nodePath from "node:path";
import { request as httpRequest } from "node:http";
import { afterAll, describe, expect, layer } from "@effect/vitest";
import { ORCHESTRATOR_HAS_NO_PR, GramRpcs } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { captureLogs } from "@gram/agents/testing/logs";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../../config.ts";
import { gitPlatformTest } from "../../git/platform.ts";
import {
  hasGit,
  makeRepo,
  removeDir,
  removeDirStrict,
  run,
  tempDir,
  write,
} from "../../git/test-repo.ts";
import { LaunchToken, serverPort, ServerLayer } from "../../http/server.ts";
import { HttpServer, RpcClient, RpcSerialization, Socket } from "../../platform/unstable.ts";
import { FakeAgentAdapter } from "../../runtime/fake-agent.ts";
import { TurnHooks } from "../../runtime/hooks.ts";
import { TEST_CONFIG } from "../../runtime/test-harness.ts";
import { ThreadRuntimes } from "../../runtime/thread-runtimes.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";

const localSettingsPath = (root: string) => nodePath.join(root, ".claude", "settings.local.json");

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

describe.skipIf(!hasGit)("git RPCs", () => {
  // Removed only after the server layer's teardown: its watchers and in-flight git refreshes (e.g. the
  // one `pr.bind` queues) hold the repo until then, and Windows won't delete a held directory.
  const dirs: Array<string> = [];
  afterAll(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  layer(TestServer, { excludeTestServices: true })("over a real socket", (it) => {
    it.effect(
      "serve diffs, branches, worktrees, PR binding and git.state against a temp repo",
      () =>
        Effect.gen(function* () {
          const dir = tempDir();
          dirs.push(dir);
          const repo = makeRepo(dir);
          const client = yield* makeClient;

          const thread = yield* client["thread.create"]({
            projectRoot: repo,
            checkout: { kind: "current" },
          });
          // The server outlives this test; an open thread keeps its git watcher on the repo, and
          // Windows won't delete a watched directory.
          yield* Effect.addFinalizer(() =>
            client["thread.close"]({ threadId: thread.id }).pipe(Effect.ignore),
          );
          const state = yield* client["events.subscribe"]().pipe(
            Stream.filter((event) => event.type === "git.state" && event.threadId === thread.id),
            Stream.take(1),
            Stream.runCollect,
            Effect.timeoutOrElse({
              duration: "20 seconds",
              orElse: () => Effect.die(new Error("no git.state event")),
            }),
          );
          expect(state[0]).toMatchObject({
            type: "git.state",
            state: { repo: true, branch: "main" },
          });
          // A client connecting now, as a reloaded window does, has it in the snapshot: nothing sends
          // it again until it changes.
          const [snapshot] = yield* client["events.subscribe"]().pipe(
            Stream.take(1),
            Stream.runCollect,
          );
          expect(
            snapshot?.type === "threads.snapshot" &&
              snapshot.threads.find((summary) => summary.thread.id === thread.id)?.git,
          ).toMatchObject({ repo: true, branch: "main" });

          write(nodePath.join(repo, "tracked.txt"), "changed\n");
          write(nodePath.join(repo, "notes", "new.txt"), "one\ntwo\n");
          const uncommitted = yield* client["git.diff"]({
            threadId: thread.id,
            scope: { kind: "uncommitted" },
          });
          expect(uncommitted).toMatchObject({ repo: true, branch: "main", worktree: repo });
          expect(
            uncommitted.files?.map((f) => [
              f.path,
              f.status,
              f.additions,
              f.deletions,
              f.binary,
              f.tooLarge,
            ]),
          ).toEqual([
            ["tracked.txt", "modified", 1, 1, false, false],
            ["notes/new.txt", "untracked", 2, 0, false, false],
          ]);
          expect(uncommitted.files?.[0]?.patch.startsWith("@@")).toBe(true);

          run(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
          run(repo, "checkout", "-q", "-b", "feat");
          run(repo, "add", "-A");
          run(repo, "commit", "-qm", "feat work");
          const branch = yield* client["git.diff"]({
            threadId: thread.id,
            scope: { kind: "branch" },
          });
          expect(branch).toMatchObject({ repo: true, branch: "feat", base: "origin/main" });
          expect(branch.files?.map((f) => [f.path, f.status])).toEqual([
            ["notes/new.txt", "added"],
            ["tracked.txt", "modified"],
          ]);
          // A clean tree ahead of its base shows the branch instead of nothing.
          const clean = yield* client["git.diff"]({
            threadId: thread.id,
            scope: { kind: "uncommitted" },
          });
          expect(clean).toMatchObject({ repo: true, branch: "feat", base: "origin/main" });
          expect(clean.files?.map((f) => [f.path, f.status])).toEqual([
            ["notes/new.txt", "added"],
            ["tracked.txt", "modified"],
          ]);
          yield* client["git.refresh"]({ threadId: thread.id });

          expect(yield* client["git.branches"]({ repoPath: repo })).toEqual({
            branches: ["origin/main"],
            default: "origin/main",
          });
          const worktrees = yield* client["worktree.list"]({ repoPath: repo });
          expect(worktrees.worktrees.map((w) => [w.isMain, w.isOpen, w.branch])).toEqual([
            [true, true, "feat"],
          ]);
          const mainRemoval = yield* client["worktree.remove"]({ path: repo, force: false }).pipe(
            Effect.flip,
          );
          expect(mainRemoval).toMatchObject({ _tag: "InvalidState" });

          expect(yield* client["git.prDetail"]({ threadId: thread.id })).toEqual({
            available: true,
          });
          const bound = yield* client["pr.bind"]({
            threadId: thread.id,
            repo: "acme/web",
            number: 12,
          });
          expect(bound).toEqual({ repo: "acme/web", number: 12, monitor: false });
          yield* client["pr.setMonitor"]({ threadId: thread.id, monitor: true });
          expect(yield* client["pr.status"]({ threadId: thread.id })).toEqual({
            bound: { repo: "acme/web", number: 12, monitor: true },
          });
          const store = yield* ThreadStore;
          const intent = { method: "squash", allowedBy: "user", setAt: 1 } as const;
          yield* store.updateThread(thread.id, (t) => ({
            ...t,
            boundPr: { ...t.boundPr!, mergeWhenReady: intent },
          }));
          yield* client["pr.bind"]({ threadId: thread.id, repo: "ACME/web", number: 12 });
          expect((yield* store.getThread(thread.id)).boundPr?.mergeWhenReady).toEqual(intent);
          const replacement = yield* client["pr.bind"]({
            threadId: thread.id,
            repo: "acme/web",
            number: 13,
          }).pipe(Effect.flip);
          expect(replacement).toMatchObject({ _tag: "InvalidState" });
          expect(replacement.message).toMatch(/armed on acme\/web#12/i);
          expect((yield* store.getThread(thread.id)).boundPr?.mergeWhenReady).toEqual(intent);
          yield* client["pr.unbind"]({ threadId: thread.id });
          expect(
            yield* client["pr.setMonitor"]({ threadId: thread.id, monitor: true }).pipe(
              Effect.flip,
            ),
          ).toMatchObject({
            _tag: "InvalidState",
          });
          expect(
            yield* client["pr.bind"]({ threadId: thread.id, repo: "not a repo", number: 1 }).pipe(
              Effect.flip,
            ),
          ).toMatchObject({
            _tag: "GitError",
          });

          // An orchestrator follows no PR of its own, whatever the UI asks.
          yield* (yield* ThreadRuntimes).updateThread(thread.id, (t) => ({
            ...t,
            role: "orchestrator",
          }));
          for (const refused of [
            client["pr.bind"]({ threadId: thread.id, repo: "acme/web", number: 12 }),
            client["pr.bindExtra"]({ threadId: thread.id, repo: "acme/web", number: 13 }),
            client["pr.setMonitor"]({ threadId: thread.id, monitor: true }),
            client["pr.create"]({
              threadId: thread.id,
              title: "t",
              body: "",
              base: "main",
              draft: false,
            }),
          ]) {
            expect(yield* refused.pipe(Effect.flip)).toMatchObject({
              _tag: "InvalidState",
              message: ORCHESTRATOR_HAS_NO_PR,
            });
          }
          expect(yield* client["pr.status"]({ threadId: thread.id })).toEqual({});
          expect(yield* client["git.prDetail"]({ threadId: thread.id })).toEqual({
            available: true,
          });
        }).pipe(Effect.scoped),
    );

    it.effect("inspect and remove a worktree no thread uses, carrying its permission rules", () =>
      Effect.gen(function* () {
        const dir = tempDir();
        dirs.push(dir);
        const repo = makeRepo(dir);
        const client = yield* makeClient;
        const tree = nodePath.join(dir, "wt-cache");
        run(repo, "worktree", "add", "-q", "-b", "experiment/cache", tree);
        write(localSettingsPath(repo), JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }));
        write(
          localSettingsPath(tree),
          JSON.stringify({ permissions: { allow: ["Bash(ls:*)", "Bash(pnpm test:*)"] } }),
        );
        write(nodePath.join(tree, "scratch.txt"), "x\n");

        const status = yield* client["worktree.status"]({ path: tree });
        expect(status).toMatchObject({ repo: true, branch: "experiment/cache" });
        expect(status.changedFiles).toBeGreaterThan(0);
        expect(yield* client["worktree.pendingPermissionsAt"]({ path: tree })).toEqual([
          "Bash(pnpm test:*)",
        ]);
        expect(yield* client["worktree.pendingPermissionsAt"]({ path: repo })).toEqual([]);

        write(nodePath.join(tree, "blob.bin"), "x".repeat(64 * 1024));
        const size = yield* client["worktree.size"]({ path: tree });
        expect(size.partial).toBe(false);
        expect(size.bytes).toBeGreaterThanOrEqual(64 * 1024);
        const main = yield* client["worktree.size"]({ path: repo }).pipe(Effect.flip);
        expect(main).toMatchObject({ _tag: "InvalidState" });

        const rules = { permissionRules: ["Bash(pnpm test:*)"] };
        const dirty = yield* client["worktree.remove"]({ path: tree, force: false, ...rules }).pipe(
          Effect.flip,
        );
        expect(dirty).toMatchObject({ _tag: "WorktreeDirty" });
        yield* client["worktree.remove"]({ path: tree, force: true, ...rules });
        const listed = yield* client["worktree.list"]({ repoPath: repo });
        expect(listed.worktrees.map((w) => w.isMain)).toEqual([true]);
        const merged = JSON.parse(readFileSync(localSettingsPath(repo), "utf8")) as {
          permissions: { allow: ReadonlyArray<string> };
        };
        expect(merged.permissions.allow).toEqual(
          expect.arrayContaining(["Bash(ls:*)", "Bash(pnpm test:*)"]),
        );
      }),
    );

    it.effect("report storage across known repos and clean up what loses nothing", () =>
      Effect.gen(function* () {
        const dir = tempDir();
        dirs.push(dir);
        const repo = makeRepo(dir);
        const client = yield* makeClient;
        yield* client["projects.add"]({ root: repo });
        const kept = nodePath.join(repo, ".worktrees", "wip");
        const idle = nodePath.join(repo, ".worktrees", "idle");
        run(repo, "worktree", "add", "-q", "-b", "feat/wip", kept);
        run(repo, "worktree", "add", "-q", "-b", "feat/idle", idle);
        write(nodePath.join(kept, "scratch.txt"), "x\n");
        write(nodePath.join(idle, "build.bin"), "x".repeat(64 * 1024));

        const report = yield* client["worktree.storage"]({});
        const mine = report.worktrees.filter((w) => w.repoTop === repo);
        // No remote: every commit is unpushed, so both are kept.
        expect(mine.map((w) => [w.path, w.group]).toSorted()).toEqual([
          [idle, "kept"],
          [kept, "kept"],
        ]);
        expect(mine.every((w) => w.madeByGram)).toBe(true);
        expect(report.disk?.totalBytes).toBeGreaterThan(0);
        expect((yield* client["worktree.cleanupPlan"]({ inactiveDays: 30 })).worktrees).toEqual([]);

        const refused = yield* client["worktree.cleanUp"]({ paths: [kept, idle] });
        expect(refused.removed).toEqual([]);
        expect(refused.kept.map((k) => k.path)).toEqual([kept, idle]);
        // Named by the user, the idle one goes; its branch stays.
        const shown = mine.find((w) => w.path === idle)!;
        const done = yield* client["worktree.cleanUp"]({
          paths: [idle],
          confirmed: [{ path: idle, changedFiles: shown.changedFiles, unpushed: shown.unpushed }],
        });
        expect(done.removed.map((r) => r.path)).toEqual([idle]);
        expect(done.bytes).toBeGreaterThanOrEqual(64 * 1024);
        expect(run(repo, "branch", "--list", "feat/idle")).toContain("feat/idle");
        expect((yield* client["worktree.storage"]({})).worktrees.map((w) => w.path)).not.toContain(
          idle,
        );
      }),
    );

    it.effect("fail with a friendly error once the thread's folder is deleted", () =>
      Effect.gen(function* () {
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

        // Parking keeps the thread but drops its git watcher, which Windows won't let us delete under.
        yield* client["thread.park"]({ threadId: thread.id, parked: true });
        removeDirStrict(repo);
        const message = `This thread's folder no longer exists: ${repo}`;
        for (const scope of [{ kind: "uncommitted" }, { kind: "branch" }] as const) {
          expect(
            yield* client["git.diff"]({ threadId: thread.id, scope }).pipe(Effect.flip),
          ).toMatchObject({ _tag: "GitError", message });
        }
        expect(yield* client["pr.status"]({ threadId: thread.id }).pipe(Effect.flip)).toMatchObject(
          { _tag: "GitError", message },
        );
      }).pipe(Effect.scoped),
    );

    it.effect("restore a deleted worktree on its branch, once, and refuse a send meanwhile", () =>
      Effect.gen(function* () {
        const dir = tempDir();
        dirs.push(dir);
        const repo = makeRepo(dir);
        const client = yield* makeClient;
        const thread = yield* client["thread.create"]({
          projectRoot: repo,
          checkout: { kind: "newWorktree", branch: "feat/restore" },
        });
        yield* Effect.addFinalizer(() =>
          client["thread.close"]({ threadId: thread.id }).pipe(Effect.ignore),
        );
        const path = thread.checkout.path;
        // Parking drops its git watcher, which Windows won't let us delete under.
        yield* client["thread.park"]({ threadId: thread.id, parked: true });
        removeDirStrict(path);
        const refused = yield* client["thread.send"]({
          threadId: thread.id,
          input: { text: "hi" },
        }).pipe(Effect.flip);
        expect(refused).toMatchObject({ _tag: "InvalidState", folderMissing: { path } });

        expect(yield* client["thread.restoreWorktree"]({ threadId: thread.id })).toEqual({
          _tag: "restored",
          path,
          branch: "feat/restore",
          source: "local",
        });
        expect(readFileSync(nodePath.join(path, ".git"), "utf8")).toContain("gitdir:");
        const again = yield* client["thread.restoreWorktree"]({ threadId: thread.id }).pipe(
          Effect.flip,
        );
        expect(again).toMatchObject({ _tag: "InvalidState" });
        expect(again.message).toContain("nothing to restore");
      }).pipe(Effect.scoped),
    );

    it.effect("browse folders and reject a missing project folder", () =>
      Effect.gen(function* () {
        const dir = tempDir();
        dirs.push(dir);
        const repo = makeRepo(dir);
        write(nodePath.join(dir, "plain", "file.txt"), "hi\n");
        write(nodePath.join(dir, ".hidden", "file.txt"), "hi\n");
        const client = yield* makeClient;

        expect(yield* client["fs.browse"]({ path: `${dir}/` })).toEqual({
          path: dir,
          parent: nodePath.dirname(dir),
          entries: [
            { name: "plain", path: nodePath.join(dir, "plain"), isGitRepo: false },
            { name: "repo", path: repo, isGitRepo: true },
          ],
          truncated: false,
        });
        const completed = yield* client["fs.browse"]({ path: nodePath.join(dir, "re"), limit: 1 });
        expect(completed.entries.map((e) => e.name)).toEqual(["repo"]);
        const hidden = yield* client["fs.browse"]({ path: `${dir}/.` });
        expect(hidden.entries.map((e) => e.name)).toEqual([".hidden"]);

        const missing = nodePath.join(dir, "repo.");
        const notFound = { _tag: "NotFound", id: missing, message: `Folder not found: ${missing}` };
        expect(yield* client["fs.browse"]({ path: `${missing}/` }).pipe(Effect.flip)).toMatchObject(
          notFound,
        );
        expect(
          yield* client["thread.create"]({
            projectRoot: missing,
            checkout: { kind: "current" },
          }).pipe(Effect.flip),
        ).toMatchObject(notFound);
        expect(yield* client["fs.tree"]({ root: missing }).pipe(Effect.flip)).toMatchObject({
          _tag: "FsError",
          message: `Folder not found: ${missing}`,
        });
      }).pipe(Effect.scoped),
    );
  });
});
