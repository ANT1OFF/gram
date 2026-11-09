import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  HOST_PROTOCOL_VERSION,
  HostCapability,
  HostHello,
  HostId,
  LOCAL_HOST_ID,
} from "@gram/contracts";
import { type GitStateChange, Proc, ProcLive, Worktrees, WorktreesLive } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { filesOn } from "./files.ts";
import { reposOn } from "./repos.ts";
import { gitOn } from "./git.ts";
import { terminalsOnHost } from "./terminals.ts";
import {
  connectHost,
  helloMismatch,
  HOST_CAPABILITIES,
  scanFromWire,
  scanToWire,
  serveHost,
  type HostService,
} from "./protocol.ts";
import type { PortScan } from "../ports/scan.ts";
import { makeRepo, removeDir, tempDir, write } from "../git/test-repo.ts";
import { noAgents, sessionsOnHost } from "./sessions.ts";
import { streamPair } from "./test-stream.ts";

/** Never cloned into here: the wire test asks only for a URL the host refuses. */
const REPOS = "/nonexistent/gram-host-repos";

const SCAN: PortScan = {
  listening: new Map([[41, [5173, 5174]]]),
  children: new Map([[1, [41]]]),
  processes: new Map([
    [1, { pid: 1, ppid: 0, command: "zsh" }],
    [41, { pid: 41, ppid: 1, pgid: 41, tpgid: 41, command: "vite" }],
  ]),
};

const hello = (overrides: Partial<HostHello> = {}): HostHello => ({
  protocol: HOST_PROTOCOL_VERSION,
  hostId: LOCAL_HOST_ID,
  capabilities: HOST_CAPABILITIES,
  platform: process.platform,
  pid: 4242,
  ...overrides,
});

/** A host served on one end of a fresh stream, and the control plane's connection to it. */
const connected = (overrides: Partial<HostHello> = {}) =>
  Effect.gen(function* () {
    const { host, control } = yield* streamPair;
    const service: HostService = {
      hello: hello(overrides),
      files: filesOn(yield* Proc),
      repos: reposOn(yield* Proc, REPOS),
      worktrees: yield* Worktrees,
      git: gitOn(yield* Proc),
      terminals: yield* terminalsOnHost,
      sessions: yield* sessionsOnHost(noAgents),
      scan: Effect.succeed(SCAN),
    };
    yield* Effect.forkScoped(
      serveHost(yield* NodeSocket.fromDuplex(Effect.succeed(host)), service),
    );
    return yield* connectHost(yield* NodeSocket.fromDuplex(Effect.succeed(control)));
  });

describe("host protocol", () => {
  it("carries a port scan across the wire unchanged", () => {
    const back = scanFromWire(scanToWire(SCAN));
    expect([...back.listening]).toEqual([...SCAN.listening]);
    expect([...back.children]).toEqual([...SCAN.children]);
    expect([...back.processes!]).toEqual([...SCAN.processes!]);
  });

  it.effect("says hello, then lists a folder and scans ports through the host", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gram-host-files-"));
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
      writeFileSync(join(dir, "notes.md"), "# hello host\n");
      const host = yield* connected();
      expect(host.hello).toMatchObject({ protocol: HOST_PROTOCOL_VERSION, pid: 4242 });
      const listing = yield* host.files.list(dir, { showHidden: false, limit: 10 });
      expect(listing.entries.map((entry) => entry.name)).toEqual(["notes.md"]);
      const scan = yield* host.scan;
      expect(scan.listening.get(41)).toEqual([5173, 5174]);
      expect(scan.processes?.get(41)?.command).toBe("vite");
    }).pipe(Effect.scoped, Effect.provide(WorktreesLive.pipe(Layer.provideMerge(ProcLive)))),
  );

  it.effect("keeps a host's refusal as the Files panel's own error, with its message", () =>
    Effect.gen(function* () {
      const host = yield* connected();
      const missing = yield* host.files
        .list("/nonexistent/gram-host-test", { showHidden: false, limit: 10 })
        .pipe(Effect.flip);
      expect(missing._tag).toBe("NotFound");
      const empty = yield* host.files
        .search(tmpdir(), "  ", { offset: 0, limit: 10 })
        .pipe(Effect.flip);
      expect(empty).toMatchObject({
        _tag: "InvalidState",
        message: "Enter something to search for",
      });
    }).pipe(Effect.scoped, Effect.provide(WorktreesLive.pipe(Layer.provideMerge(ProcLive)))),
  );

  it.effect("connects a host that sends its release and one built before it did", () =>
    Effect.gen(function* () {
      expect((yield* connected({ release: "1.15.2" })).hello.release).toBe("1.15.2");
      expect((yield* connected()).hello).not.toHaveProperty("release");
    }).pipe(Effect.scoped, Effect.provide(WorktreesLive.pipe(Layer.provideMerge(ProcLive)))),
  );

  it("keeps a hello with a release readable by a build from before it was sent", () => {
    // `HostHello` as 1.14.0 to 1.15.1 had it, which read every hello since.
    const Before = Schema.Struct({
      protocol: Schema.Int,
      hostId: HostId,
      capabilities: Schema.Array(HostCapability),
      platform: Schema.String,
      pid: Schema.Int,
    });
    const now = Schema.encodeSync(HostHello)(hello({ release: "1.15.2" }));
    expect(Schema.decodeUnknownSync(Before)(now)).toEqual(hello());
    expect(Schema.decodeUnknownSync(HostHello)(Schema.encodeSync(Before)(hello()))).toEqual(
      hello(),
    );
    // Same protocol and everything this build needs: compatible, whatever the release.
    expect(helloMismatch(hello({ release: "1.14.0" }))).toBeUndefined();
    expect(helloMismatch(hello({ protocol: HOST_PROTOCOL_VERSION - 1 }))).toEqual({
      kind: "protocol",
    });
    expect(helloMismatch(hello({ capabilities: ["files"] }))).toMatchObject({
      kind: "capabilities",
      missing: expect.arrayContaining(["sessions"]),
    });
  });

  it.effect("refuses a host on another protocol version", () =>
    Effect.gen(function* () {
      const error = yield* connected({ protocol: HOST_PROTOCOL_VERSION + 1 }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "HostUnavailable" });
      expect(error.message).toContain(`protocol ${HOST_PROTOCOL_VERSION + 1}`);
    }).pipe(Effect.scoped, Effect.provide(WorktreesLive.pipe(Layer.provideMerge(ProcLive)))),
  );

  it.effect("refuses a host that doesn't serve what this build needs", () =>
    Effect.gen(function* () {
      const error = yield* connected({ capabilities: ["files"] }).pipe(Effect.flip);
      expect(error.message).toContain("doesn't serve ports");
    }).pipe(Effect.scoped, Effect.provide(WorktreesLive.pipe(Layer.provideMerge(ProcLive)))),
  );

  it.effect("refuses a host that answers as another machine", () =>
    Effect.gen(function* () {
      const error = yield* connected({ hostId: HostId.make("tower") }).pipe(Effect.flip);
      expect(error.message).toContain('answered as "tower"');
    }).pipe(Effect.scoped, Effect.provide(WorktreesLive.pipe(Layer.provideMerge(ProcLive)))),
  );

  it.effect("creates, lists and removes a worktree through the host", () =>
    Effect.gen(function* () {
      const tmp = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(tmp)));
      const repo = makeRepo(tmp);
      const host = yield* connected();
      const created = yield* host.worktrees.create({
        repoPath: repo,
        branch: "feature/host",
        openCheckouts: [],
      });
      expect(created).toMatchObject({ reused: false, checkout: { branch: "feature/host" } });
      const listed = yield* host.worktrees.list(repo, { openCheckouts: [created.checkout.path] });
      const entry = listed.worktrees.find((w) => w.branch === "feature/host");
      expect(entry).toMatchObject({ isMain: false, isOpen: true });
      // No `origin` here, so nothing to base on but the current HEAD.
      expect(yield* host.worktrees.baseBranches(repo)).toMatchObject({ branches: [] });
      const inUse = yield* host.worktrees
        .remove({
          repoPath: repo,
          worktreeDir: created.checkout.path,
          openCheckouts: [created.checkout.path],
        })
        .pipe(Effect.flip);
      expect(inUse).toMatchObject({ _tag: "WorktreeError", reason: "conflict", dirty: false });
      write(join(created.checkout.path, "wip.txt"), "uncommitted\n");
      const dirty = yield* host.worktrees
        .remove({ repoPath: repo, worktreeDir: created.checkout.path, openCheckouts: [] })
        .pipe(Effect.flip);
      expect(dirty).toMatchObject({ _tag: "WorktreeError", dirty: true });
      expect(yield* host.worktrees.pendingPermissions(repo, created.checkout.path)).toEqual([]);
      yield* host.worktrees.remove({
        repoPath: repo,
        worktreeDir: created.checkout.path,
        force: true,
        openCheckouts: [],
      });
      const restored = yield* host.worktrees.restore({
        repoPath: repo,
        worktreeDir: created.checkout.path,
        branch: "feature/host",
        openCheckouts: [],
      });
      expect(restored).toEqual({ kind: "restored", source: "local" });
      yield* host.worktrees.remove({
        repoPath: repo,
        worktreeDir: created.checkout.path,
        force: true,
        openCheckouts: [],
      });
      const after = yield* host.worktrees.list(repo, { openCheckouts: [] });
      expect(after.worktrees.map((w) => w.branch)).not.toContain("feature/host");
    }).pipe(Effect.scoped, Effect.provide(WorktreesLive.pipe(Layer.provideMerge(ProcLive)))),
  );

  it.effect("keeps a refused worktree request as the worktree layer's own error", () =>
    Effect.gen(function* () {
      const tmp = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(tmp)));
      const repo = makeRepo(tmp);
      const host = yield* connected();
      const error = yield* host.worktrees
        .create({ repoPath: repo, branch: "  ", openCheckouts: [] })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "WorktreeError",
        reason: "invalidRequest",
        message: "branch must be a valid git branch name",
      });
    }).pipe(Effect.scoped, Effect.provide(WorktreesLive.pipe(Layer.provideMerge(ProcLive)))),
  );

  it.effect("keeps a refused clone as the worktree layer's own error", () =>
    Effect.gen(function* () {
      const host = yield* connected();
      const error = yield* host.repos.ensure("file:///etc").pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "WorktreeError", reason: "invalidRequest" });
    }).pipe(Effect.scoped, Effect.provide(WorktreesLive.pipe(Layer.provideMerge(ProcLive)))),
  );

  it.live("reads and watches a checkout's git state through the host", () =>
    Effect.gen(function* () {
      const tmp = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(tmp)));
      const repo = makeRepo(tmp);
      const host = yield* connected();
      const state = yield* host.git.local(repo);
      expect(state).toMatchObject({ repo: true, branch: "main", changedFiles: 0 });
      expect(yield* host.git.present(repo)).toBe(true);
      expect(yield* host.git.present(join(tmp, "gone"))).toBe(false);
      const changes = yield* Queue.unbounded<GitStateChange>();
      yield* host.git.watch([repo], { debounceMs: 100, cooldownMs: 300 }).pipe(
        Stream.runForEach((change) => Queue.offer(changes, change)),
        Effect.forkScoped,
      );
      const initial = yield* Queue.take(changes).pipe(Effect.timeout("15 seconds"));
      expect(initial).toMatchObject({ path: repo, state: { changedFiles: 0 } });
      write(join(repo, "tracked.txt"), "changed\n");
      const edited = yield* Queue.take(changes).pipe(Effect.timeout("20 seconds"));
      expect(edited).toMatchObject({ path: repo, state: { changedFiles: 1, branch: "main" } });
    }).pipe(Effect.scoped, Effect.provide(WorktreesLive.pipe(Layer.provideMerge(ProcLive)))),
  );
});
