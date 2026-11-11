import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { describe, expect, it } from "@effect/vitest";
import { type HostBusy, HOST_PROTOCOL_VERSION, LOCAL_HOST_ID, ThreadId } from "@gram/contracts";
import { Proc, ProcLive, wipRef, Worktrees, WorktreesLive } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { hasGit, makeRepo, removeDir, run, tempDir, write } from "../git/test-repo.ts";
import { makeAdmission } from "./admission.ts";
import { attachmentsOnHost, fileReadsOn } from "./file-reads.ts";
import { filesOn } from "./files.ts";
import { gitOn } from "./git.ts";
import { connectHost, HOST_SERVES, type HostService, serveHost } from "./protocol.ts";
import { reposOn } from "./repos.ts";
import { noAgents, sessionsOnHost } from "./sessions.ts";
import { STOPPING, stopOn } from "./stop.ts";
import { terminalsOnHost } from "./terminals.ts";
import { streamPair } from "./test-stream.ts";

const IDLE: HostBusy = { turns: 0, terminals: 0, clones: 0, checks: 0 };
const THREAD = ThreadId.make("thread-1");
/** The tests' remote is a bare repository on disk. */
const FILE = "file";
const live = Effect.provide(WorktreesLive.pipe(Layer.provideMerge(ProcLive)));

/** A repository with uncommitted work and a bare `origin` beside it, removed with the scope. */
const worktree = Effect.gen(function* () {
  const dir = tempDir();
  yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
  const repo = makeRepo(dir);
  const origin = join(dir, "origin.git");
  run(dir, "init", "--bare", "--quiet", origin);
  run(repo, "remote", "add", "origin", origin);
  write(join(repo, "tracked.txt"), "work in progress\n");
  write(join(repo, "new.txt"), "untracked\n");
  return { repo, origin };
});

describe.skipIf(!hasGit)("a host readied to stop", () => {
  it.live("keeps each folder's work in progress on the remote and says it is idle", () =>
    Effect.gen(function* () {
      const { repo, origin } = yield* worktree;
      const head = run(repo, "rev-parse", "HEAD").trim();
      const stop = stopOn({
        proc: yield* Proc,
        busy: Effect.succeed(IDLE),
        admission: makeAdmission(),
        protocols: FILE,
      });
      const prepared = yield* stop.prepare({
        // Named twice: kept once.
        checkouts: [
          { threadId: THREAD, cwd: repo },
          { threadId: THREAD, cwd: repo },
        ],
      });
      expect(prepared).toMatchObject({ idle: true, busy: IDLE });
      expect(prepared.kept).toEqual([
        {
          threadId: THREAD,
          cwd: repo,
          ref: wipRef(THREAD),
          commit: expect.stringMatching(/^[0-9a-f]{40}$/),
          pushed: true,
        },
      ]);
      expect(run(origin, "show", `${wipRef(THREAD)}:tracked.txt`)).toBe("work in progress\n");
      expect(run(origin, "show", `${wipRef(THREAD)}:new.txt`)).toBe("untracked\n");
      // The branch and the files are as they were.
      expect(run(repo, "rev-parse", "HEAD").trim()).toBe(head);
      expect(run(repo, "status", "--porcelain")).toContain("tracked.txt");
      expect(stop.stopping()).toBe(true);
      yield* stop.cancel;
      expect(stop.stopping()).toBe(false);
    }).pipe(Effect.scoped, live),
  );

  it.live("changes nothing while something runs, unless the stop is forced", () =>
    Effect.gen(function* () {
      const { repo, origin } = yield* worktree;
      const busy: HostBusy = { ...IDLE, turns: 1 };
      const stop = stopOn({
        proc: yield* Proc,
        busy: Effect.succeed(busy),
        admission: makeAdmission(),
        protocols: FILE,
      });
      const checkouts = [{ threadId: THREAD, cwd: repo }];
      expect(yield* stop.prepare({ checkouts })).toEqual({ idle: false, busy, kept: [] });
      expect(stop.stopping()).toBe(false);
      expect(run(repo, "for-each-ref", "refs/gram/")).toBe("");

      // A machine about to be taken away: kept anyway, and still not idle.
      const forced = yield* stop.prepare({ checkouts, force: true });
      expect(forced).toMatchObject({ idle: false, kept: [{ pushed: true }] });
      expect(run(origin, "show", `${wipRef(THREAD)}:new.txt`)).toBe("untracked\n");
      expect(stop.stopping()).toBe(true);
    }).pipe(Effect.scoped, live),
  );

  it.live("isn't idle with work let in and unanswered, or under an update", () =>
    Effect.gen(function* () {
      const admission = makeAdmission();
      const stop = stopOn({
        proc: yield* Proc,
        busy: Effect.succeed(IDLE),
        admission,
        protocols: FILE,
      });
      admission.close();
      expect(yield* stop.prepare({ checkouts: [] })).toMatchObject({
        idle: false,
        note: "It is updating Gram.",
      });
      admission.open();
      const held = yield* Effect.forkScoped(admission.admit(Effect.never, () => "refused"));
      yield* Effect.yieldNow;
      expect(yield* stop.prepare({ checkouts: [] })).toMatchObject({
        idle: false,
        note: "It is starting work.",
      });
      yield* Fiber.interrupt(held);
      expect(yield* stop.prepare({ checkouts: [] })).toMatchObject({ idle: true });
    }).pipe(Effect.scoped, live),
  );

  it.live("says why a folder wasn't kept, and keeps the others", () =>
    Effect.gen(function* () {
      const { repo } = yield* worktree;
      const plain = mkdtempSync(join(tmpdir(), "gram-stop-plain-"));
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(plain)));
      const stop = stopOn({
        proc: yield* Proc,
        busy: Effect.succeed(IDLE),
        admission: makeAdmission(),
        protocols: FILE,
        admit: (cwd) =>
          cwd === "/refused"
            ? Effect.fail({ message: "Not this folder." })
            : Effect.succeed({ path: cwd }),
      });
      const prepared = yield* stop.prepare({
        checkouts: [
          { threadId: THREAD, cwd: "/refused" },
          { threadId: ThreadId.make("thread-2"), cwd: plain },
          { threadId: ThreadId.make("thread-3"), cwd: repo },
        ],
        remote: "nowhere",
      });
      expect(prepared.idle).toBe(true);
      expect(prepared.kept[0]).toEqual({
        threadId: THREAD,
        cwd: "/refused",
        pushed: false,
        note: "Not this folder.",
      });
      expect(prepared.kept[1]).toMatchObject({ pushed: false });
      expect(prepared.kept[1]?.note).toContain("not a git repository");
      // Committed here though the remote couldn't be reached.
      expect(prepared.kept[2]).toMatchObject({ ref: wipRef("thread-3"), pushed: false });
      expect(prepared.kept[2]?.note).toBeTruthy();
      expect(
        (yield* Effect.flip(stop.prepare({ checkouts: [], remote: "--upload-pack=x" }))).message,
      ).toBe("That isn't a remote to push to.");
    }).pipe(Effect.scoped, live),
  );

  it.live(
    "keeps nothing of a repository rooted above the folder let through, or holding home",
    () =>
      Effect.gen(function* () {
        const { repo, origin } = yield* worktree;
        mkdirSync(join(repo, "inner"));
        const proc = yield* Proc;
        // A gate that lets everything through: what it never looked at is still not committed.
        const gated = (home: string) =>
          stopOn({
            proc,
            busy: Effect.succeed(IDLE),
            admission: makeAdmission(),
            protocols: FILE,
            home,
            admit: (cwd) => Effect.succeed({ path: cwd }),
          });
        const inner = yield* gated("/nonexistent/home").prepare({
          checkouts: [{ threadId: THREAD, cwd: join(repo, "inner") }],
        });
        expect(inner.kept[0]).toMatchObject({ pushed: false });
        expect(inner.kept[0]?.note).toContain("is inside a repository rooted at");
        const home = yield* gated(join(repo, "inner")).prepare({
          checkouts: [{ threadId: THREAD, cwd: repo }],
        });
        expect(home.kept[0]).toMatchObject({ pushed: false });
        expect(home.kept[0]?.note).toContain("holds this machine's home folder");
        expect(run(repo, "for-each-ref", "refs/gram/")).toBe("");
        expect(run(origin, "for-each-ref")).toBe("");
      }).pipe(Effect.scoped, live),
  );

  it.live("runs git where the gate says the folder is, and keeps one folder per repository", () =>
    Effect.gen(function* () {
      const { repo, origin } = yield* worktree;
      const second = join(repo, "..", "second");
      run(repo, "worktree", "add", "--quiet", "-b", "second", second);
      const stop = stopOn({
        proc: yield* Proc,
        busy: Effect.succeed(IDLE),
        admission: makeAdmission(),
        protocols: FILE,
        admit: (cwd) => Effect.succeed({ path: cwd === "~/work" ? repo : cwd }),
      });
      const prepared = yield* stop.prepare({
        checkouts: [
          { threadId: THREAD, cwd: "~/work" },
          { threadId: THREAD, cwd: realpathSync(second) },
        ],
      });
      expect(prepared.kept[0]).toMatchObject({ cwd: "~/work", pushed: true });
      expect(run(origin, "show", `${wipRef(THREAD)}:new.txt`)).toBe("untracked\n");
      expect(prepared.kept[1]).toMatchObject({ pushed: false });
      expect(prepared.kept[1]?.note).toContain("one is kept per repository");
    }).pipe(Effect.scoped, live),
  );

  it.live("says the stop was taken back when a cancel came while it kept the folders", () =>
    Effect.gen(function* () {
      const { repo } = yield* worktree;
      let stop: ReturnType<typeof stopOn> | undefined;
      stop = stopOn({
        proc: yield* Proc,
        busy: Effect.succeed(IDLE),
        admission: makeAdmission(),
        protocols: FILE,
        // The cancel lands as the folder is looked at.
        admit: (cwd) => Effect.as(stop!.cancel, { path: cwd }),
      });
      const prepared = yield* stop.prepare({ checkouts: [{ threadId: THREAD, cwd: repo }] });
      expect(prepared).toMatchObject({ idle: false, note: "The stop was taken back meanwhile." });
      expect(stop.stopping()).toBe(false);
    }).pipe(Effect.scoped, live),
  );

  it.live("holds from its answer, and doesn't put back a hold a cancel took away", () =>
    Effect.gen(function* () {
      let now = 1_000;
      let busy: HostBusy = IDLE;
      let onLook = Effect.void;
      const stop = stopOn({
        proc: yield* Proc,
        busy: Effect.suspend(() => Effect.as(onLook, busy)),
        admission: makeAdmission(),
        now: () => now,
        holdMs: 500,
      });
      // The look takes a while: the hold is counted from the answer.
      onLook = Effect.sync(() => void (now = 1_400));
      yield* stop.prepare({ checkouts: [] });
      now = 1_800;
      expect(stop.stopping()).toBe(true);
      // A hold that ran out before the answer: not idle, since work may have been let in.
      onLook = Effect.void;
      const slow = stopOn({
        proc: yield* Proc,
        busy: Effect.succeed(IDLE),
        admission: makeAdmission(),
        now: () => (now += 600),
        holdMs: 500,
      });
      expect(yield* slow.prepare({ checkouts: [] })).toMatchObject({
        idle: false,
        note: "Keeping its work took too long; ask again.",
      });
      // Held, then asked again while busy, with a cancel during the look: not held after it.
      busy = { ...IDLE, turns: 1 };
      onLook = stop.cancel;
      expect(yield* stop.prepare({ checkouts: [] })).toMatchObject({ idle: false });
      expect(stop.stopping()).toBe(false);
    }).pipe(Effect.scoped, live),
  );

  it.live("keeps its folders as work an update waits for", () =>
    Effect.gen(function* () {
      const { repo } = yield* worktree;
      const admission = makeAdmission();
      let during = -1;
      const stop = stopOn({
        proc: yield* Proc,
        busy: Effect.succeed(IDLE),
        admission,
        protocols: FILE,
        admit: (cwd) => Effect.sync(() => ((during = admission.inflight()), { path: cwd })),
      });
      yield* stop.prepare({ checkouts: [{ threadId: THREAD, cwd: repo }] });
      expect(during).toBe(1);
      expect(admission.inflight()).toBe(0);
    }).pipe(Effect.scoped, live),
  );

  it.live("takes work again once the hold has passed without a stop", () =>
    Effect.gen(function* () {
      let now = 1_000;
      const stop = stopOn({
        proc: yield* Proc,
        busy: Effect.succeed(IDLE),
        admission: makeAdmission(),
        protocols: FILE,
        now: () => now,
        holdMs: 500,
      });
      yield* stop.prepare({ checkouts: [] });
      now = 1_499;
      expect(stop.stopping()).toBe(true);
      now = 1_500;
      expect(stop.stopping()).toBe(false);
    }).pipe(Effect.scoped, live),
  );

  it.live("is asked over the host protocol, and refuses new work until it is cancelled", () =>
    Effect.gen(function* () {
      const { repo, origin } = yield* worktree;
      const proc = yield* Proc;
      const admission = makeAdmission();
      const { host, control } = yield* streamPair;
      const service: HostService = {
        hello: {
          protocol: HOST_PROTOCOL_VERSION,
          hostId: LOCAL_HOST_ID,
          capabilities: HOST_SERVES,
          platform: process.platform,
          pid: 4242,
        },
        files: filesOn(proc),
        reads: fileReadsOn(proc),
        attachments: yield* attachmentsOnHost(mkdtempSync(join(tmpdir(), "gram-stop-attached-"))),
        repos: reposOn(proc, "/nonexistent/gram-host-repos"),
        worktrees: yield* Worktrees,
        git: gitOn(proc),
        terminals: yield* terminalsOnHost,
        sessions: yield* sessionsOnHost(noAgents),
        scan: Effect.succeed({ listening: new Map(), children: new Map() }),
        admission,
        stop: stopOn({ proc, busy: Effect.succeed(IDLE), admission, protocols: FILE }),
      };
      yield* Effect.forkScoped(
        serveHost(yield* NodeSocket.fromDuplex(Effect.succeed(host)), service),
      );
      const connection = yield* connectHost(yield* NodeSocket.fromDuplex(Effect.succeed(control)));
      const open = connection.sessions
        .open({ handle: "h-1", agent: "claude", threadId: THREAD, cwd: repo })
        .pipe(Effect.flip);

      const prepared = yield* connection.stop.prepare({
        checkouts: [{ threadId: THREAD, cwd: repo }],
      });
      expect(prepared).toMatchObject({ idle: true, kept: [{ pushed: true }] });
      expect(run(origin, "rev-parse", wipRef(THREAD)).trim()).toBe(prepared.kept[0]?.commit);
      expect((yield* open).message).toBe(STOPPING);

      yield* connection.stop.cancel;
      // Past the gate again: what it fails with now is the host having no agents.
      expect((yield* open).message).not.toBe(STOPPING);
    }).pipe(Effect.scoped, live),
  );

  it.live("reads a host built before the call as one that can't be readied", () =>
    Effect.gen(function* () {
      const proc = yield* Proc;
      const { host, control } = yield* streamPair;
      const service: HostService = {
        hello: {
          protocol: HOST_PROTOCOL_VERSION,
          hostId: LOCAL_HOST_ID,
          capabilities: HOST_SERVES,
          platform: process.platform,
          pid: 4242,
        },
        files: filesOn(proc),
        reads: fileReadsOn(proc),
        attachments: yield* attachmentsOnHost(mkdtempSync(join(tmpdir(), "gram-stop-attached-"))),
        repos: reposOn(proc, "/nonexistent/gram-host-repos"),
        worktrees: yield* Worktrees,
        git: gitOn(proc),
        terminals: yield* terminalsOnHost,
        sessions: yield* sessionsOnHost(noAgents),
        scan: Effect.succeed({ listening: new Map(), children: new Map() }),
      };
      yield* Effect.forkScoped(
        serveHost(yield* NodeSocket.fromDuplex(Effect.succeed(host)), service),
      );
      const connection = yield* connectHost(yield* NodeSocket.fromDuplex(Effect.succeed(control)));
      const refused = yield* Effect.flip(connection.stop.prepare({ checkouts: [] }));
      expect(refused._tag).toBe("HostFailed");
      // The connection is still good.
      expect(connection.gone()).toBe(false);
      yield* connection.stop.cancel;
    }).pipe(Effect.scoped, live),
  );
});
