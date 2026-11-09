import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  HOST_PROTOCOL_VERSION,
  type HostHello,
  HostId,
  LOCAL_HOST_ID,
  type ThreadId,
} from "@gram/contracts";
import { type GitStateChange, Proc, ProcLive, Worktrees, WorktreesLive } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { attachmentsOnHost, fileReadsOn } from "./file-reads.ts";
import { filesOn } from "./files.ts";
import { reposOn } from "./repos.ts";
import { gitOn } from "./git.ts";
import { terminalsOnHost } from "./terminals.ts";
import {
  connectHost,
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
const connected = (
  overrides: Partial<HostHello> = {},
  attached: string = mkdtempSync(join(tmpdir(), "gram-host-attached-")),
) =>
  Effect.gen(function* () {
    const { host, control } = yield* streamPair;
    const service: HostService = {
      hello: hello(overrides),
      files: filesOn(yield* Proc),
      reads: fileReadsOn(yield* Proc),
      attachments: yield* attachmentsOnHost(attached),
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

const onHost = Effect.provide(WorktreesLive.pipe(Layer.provideMerge(ProcLive)));
const NOT_VOUCHED = { allowed: false, refusal: "is outside this thread's folder" };

/** A checkout on the host, a file outside it, and a link from inside it to that file. */
const hostFolders = Effect.gen(function* () {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gram-host-reads-")));
  yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
  const checkout = join(dir, "checkout");
  mkdirSync(join(checkout, "src"), { recursive: true });
  writeFileSync(join(checkout, "src", "app.ts"), "export const onHost = 1;\n");
  writeFileSync(join(dir, "outside.txt"), "outside the checkout\n");
  writeFileSync(join(dir, ".git-credentials"), "synthetic-not-a-secret\n");
  symlinkSync(join(dir, "outside.txt"), join(checkout, "escape.txt"));
  return { dir, checkout };
});

describe("a joined machine's file reads", () => {
  it.effect("scope a path to the thread's folders on the host, links included", () =>
    Effect.gen(function* () {
      const { dir, checkout } = yield* hostFolders;
      const reads = (yield* connected()).reads!;
      expect(yield* reads.scope("src", [checkout])).toBe(join(checkout, "src"));
      const escape = yield* reads.scope("escape.txt", [checkout]).pipe(Effect.flip);
      expect(escape.message).toContain("outside this thread's folder");
      const up = yield* reads.scope("../outside.txt", [checkout]).pipe(Effect.flip);
      expect(up.message).toContain("outside this thread's folder");
      expect(yield* reads.scope(join(dir, "checkout", "src"), [checkout])).toBe(
        join(checkout, "src"),
      );
    }).pipe(Effect.scoped, onHost),
  );

  it.effect("read a file in the folders, and outside them only as the transcript allows", () =>
    Effect.gen(function* () {
      const { dir, checkout } = yield* hostFolders;
      const reads = (yield* connected()).reads!;
      const file = yield* reads.file("src/app.ts", [checkout], NOT_VOUCHED, 1024);
      expect(file.content).toBe("export const onHost = 1;\n");
      const linked = yield* reads
        .file("escape.txt", [checkout], NOT_VOUCHED, 1024)
        .pipe(Effect.flip);
      expect(linked.message).toContain("outside this thread's folder");
      const outside = join(dir, "outside.txt");
      const refused = yield* reads.file(outside, [checkout], NOT_VOUCHED, 1024).pipe(Effect.flip);
      expect(refused.message).toBe(`${outside} is outside this thread's folder`);
      const vouched = yield* reads.file(
        outside,
        [checkout],
        { ...NOT_VOUCHED, allowed: true },
        1024,
      );
      expect(vouched.content).toBe("outside the checkout\n");
      // A credential file stays refused, whatever the transcript says.
      const key = yield* reads
        .file(join(dir, ".git-credentials"), [checkout], { ...NOT_VOUCHED, allowed: true }, 1024)
        .pipe(Effect.flip);
      expect(key.message).toContain("may hold credentials");
    }).pipe(Effect.scoped, onHost),
  );

  it.effect("resolve file links there, handing back the outside ones unchecked", () =>
    Effect.gen(function* () {
      const { dir, checkout } = yield* hostFolders;
      const reads = (yield* connected()).reads!;
      const outside = join(dir, "outside.txt");
      const first = yield* reads.resolve(["src/app.ts", outside], [checkout], []);
      expect(first.files).toEqual([
        { path: "src/app.ts", resolved: join(checkout, "src", "app.ts") },
      ]);
      expect(first.unchecked).toEqual([outside]);
      const second = yield* reads.resolve([outside], [checkout], [outside]);
      expect(second.files).toEqual([{ path: outside, resolved: outside }]);
    }).pipe(Effect.scoped, onHost),
  );

  it.effect("fetch a regular file for send_file, within its size and never a credential", () =>
    Effect.gen(function* () {
      const { dir, checkout } = yield* hostFolders;
      const reads = (yield* connected()).reads!;
      const fetched = yield* reads.fetch("src/app.ts", checkout, 1024);
      expect(fetched.path).toBe(join(checkout, "src", "app.ts"));
      expect(Buffer.from(fetched.data, "base64").toString("utf8")).toBe(
        "export const onHost = 1;\n",
      );
      const large = yield* reads.fetch("src/app.ts", checkout, 4).pipe(Effect.flip);
      expect(large.message).toContain("is over the");
      const key = yield* reads
        .fetch(join(dir, ".git-credentials"), checkout, 1024)
        .pipe(Effect.flip);
      expect(key.message).toContain("may hold credentials");
      const folder = yield* reads.fetch("src", checkout, 1024).pipe(Effect.flip);
      expect(folder.message).toContain("Not a regular file");
    }).pipe(Effect.scoped, onHost),
  );

  it.effect("hold a session's attachments per thread, until the thread is gone", () =>
    Effect.gen(function* () {
      const attached = realpathSync(mkdtempSync(join(tmpdir(), "gram-host-attached-")));
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(attached, { recursive: true })));
      const store = (yield* connected({}, attached)).attachments!;
      const thread = "t-attached" as ThreadId;
      const data = Buffer.from("synthetic attachment").toString("base64");
      const { path } = yield* store.put(thread, "../../notes.txt", data);
      // Named only inside the thread's folder, whatever name it came with.
      expect(path.startsWith(join(attached, thread))).toBe(true);
      expect(readFileSync(path, "utf8")).toBe("synthetic attachment");
      expect(readdirSync(join(attached, thread))).toHaveLength(1);
      const escape = yield* store.put("../x" as ThreadId, "a.txt", data).pipe(Effect.flip);
      expect(escape.message).toContain("Not a thread id");
      const empty = yield* store.put(thread, "a.txt", "").pipe(Effect.flip);
      expect(empty.message).toContain("is empty");
      yield* store.remove(thread);
      expect(existsSync(join(attached, thread))).toBe(false);
    }).pipe(Effect.scoped, onHost),
  );

  it.effect("prune a thread's attachments nothing was added to for a week", () =>
    Effect.gen(function* () {
      const attached = realpathSync(mkdtempSync(join(tmpdir(), "gram-host-attached-")));
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(attached, { recursive: true })));
      mkdirSync(join(attached, "t-old"));
      mkdirSync(join(attached, "t-new"));
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      utimesSync(join(attached, "t-old"), old, old);
      yield* attachmentsOnHost(attached);
      expect(readdirSync(attached)).toEqual(["t-new"]);
    }).pipe(Effect.scoped),
  );

  it.effect("are absent for a host from a build without them, which still connects", () =>
    Effect.gen(function* () {
      const old = yield* connected({
        capabilities: HOST_CAPABILITIES.filter((c) => c !== "file-reads" && c !== "attachments"),
      });
      expect(old.reads).toBeUndefined();
      expect(old.attachments).toBeUndefined();
      expect(old.files).toBeDefined();
    }).pipe(Effect.scoped, onHost),
  );
});
