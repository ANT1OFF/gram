// A joined machine's host runs a project's check the way the main Gram runs its own: the head
// merged onto its base in a repository of its own, nothing of the agent's checkout but its commits.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { describe, expect, it } from "@effect/vitest";
import { HOST_PROTOCOL_VERSION, HostId } from "@gram/contracts";
import { Proc, ProcLive, Worktrees, WorktreesLive } from "@gram/git";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { hasGit, makeRepo, removeDir, run, tempDir, write } from "../git/test-repo.ts";
import { checksOn, type HostCheckRunner } from "./checks.ts";
import { attachmentsOnHost, fileReadsOn } from "./file-reads.ts";
import { filesOn } from "./files.ts";
import { gitOn } from "./git.ts";
import { connectHost, HOST_CAPABILITIES, HOST_SERVES, serveHost } from "./protocol.ts";
import { reposOn } from "./repos.ts";
import { noAgents, sessionsOnHost } from "./sessions.ts";
import { terminalsOnHost } from "./terminals.ts";
import { streamPair } from "./test-stream.ts";

const MACHINE = HostId.make("m-0123456789abcdef01234567");

/** A clone with `main` one commit past where the worker's branch left it, and its worktree. */
const fixture = () => {
  const dir = tempDir();
  const clone = makeRepo(dir);
  const worktree = join(dir, "feat");
  run(clone, "worktree", "add", "-q", "-b", "feat", worktree);
  write(join(worktree, "feature.txt"), "feature\n");
  run(worktree, "add", "feature.txt");
  run(worktree, "commit", "-q", "-m", "feature");
  const head = run(worktree, "rev-parse", "HEAD").trim();
  // Nothing outside the commit may reach the check.
  write(join(worktree, "scratch.txt"), "uncommitted\n");
  write(join(clone, "base.txt"), "base\n");
  run(clone, "add", "base.txt");
  run(clone, "commit", "-q", "-m", "base");
  const base = run(clone, "rev-parse", "HEAD").trim();
  return { dir, clone, worktree, head, base };
};

/** The machine's host serving `runner`'s checks on one end of a stream, and the connection. */
const machine = (dir: string, runner: HostCheckRunner, serves = HOST_SERVES) =>
  Effect.gen(function* () {
    const { host, control } = yield* streamPair;
    const proc = yield* Proc;
    const serving = yield* Effect.forkScoped(
      Effect.gen(function* () {
        yield* serveHost(yield* NodeSocket.fromDuplex(Effect.succeed(host)), {
          hello: {
            protocol: HOST_PROTOCOL_VERSION,
            hostId: MACHINE,
            capabilities: serves,
            platform: "linux",
            pid: 7,
          },
          files: filesOn(proc),
          reads: fileReadsOn(proc),
          attachments: yield* attachmentsOnHost(join(dir, "attached")),
          repos: reposOn(proc, join(dir, "repos")),
          worktrees: yield* Worktrees,
          git: gitOn(proc),
          terminals: yield* terminalsOnHost,
          sessions: yield* sessionsOnHost(noAgents),
          scan: Effect.succeed({ listening: new Map(), children: new Map() }),
          checks: yield* checksOn(proc, join(dir, "checks"), runner),
        });
      }).pipe(Effect.scoped, Effect.ensuring(Effect.sync(() => host.destroy()))),
    );
    const connection = yield* connectHost(yield* NodeSocket.fromDuplex(Effect.succeed(control)), {
      hostId: MACHINE,
    });
    return { connection, stop: Fiber.interrupt(serving) };
  });

const Live = WorktreesLive.pipe(Layer.provideMerge(ProcLive));

describe.skipIf(!hasGit)("a joined machine's checks", () => {
  it.live("checks the head merged onto its base in a worktree of its own, once per id", () =>
    Effect.gen(function* () {
      const { dir, worktree, head, base } = fixture();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      const seen: Array<{ dir: string; files: Array<string>; parents: Array<string> }> = [];
      const release = yield* Deferred.make<void>();
      const runner: HostCheckRunner = (src, log, wanted) =>
        Effect.gen(function* () {
          seen.push({
            dir: src,
            files: ["feature.txt", "base.txt", "scratch.txt"].filter((file) =>
              existsSync(join(src, file)),
            ),
            parents: run(src, "rev-parse", "HEAD^1", "HEAD^2").trim().split("\n"),
          });
          write(log, `ran ${wanted.command}\n`);
          yield* Deferred.await(release);
          return { ok: true };
        });
      const { connection } = yield* machine(dir, runner);
      expect(connection.checks).toBeDefined();
      const request = {
        id: "check-1",
        path: worktree,
        head,
        base,
        command: "invented-check",
        timeoutMs: 60_000,
      };
      const first = yield* Effect.forkScoped(connection.checks!.run(request));
      // A second ask under the same id, as after a dropped connection, joins the same run.
      const again = yield* Effect.forkScoped(connection.checks!.run(request));
      while (seen.length === 0) yield* Effect.sleep("20 millis");
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(first);
      expect(yield* Fiber.join(again)).toEqual(result);
      expect(result).toMatchObject({ ok: true, log: "ran invented-check\n" });
      expect(result.tree).toMatch(/^[0-9a-f]{40}$/);
      expect(result.mergedCommit).toMatch(/^[0-9a-f]{40}$/);
      // The merge of the commits alone, base first, in a folder that is gone again.
      expect(seen).toEqual([
        { dir: seen[0]!.dir, files: ["feature.txt", "base.txt"], parents: [base, head] },
      ]);
      expect(seen[0]!.dir.startsWith(join(dir, "checks"))).toBe(true);
      expect(existsSync(seen[0]!.dir)).toBe(false);
      // Asked once more after it ended, it answers from what it kept.
      expect(yield* connection.checks!.run(request)).toEqual(result);
      expect(seen).toHaveLength(1);
      // The same id never stands for another check.
      const other = yield* connection
        .checks!.run({ ...request, command: "other-check" })
        .pipe(Effect.flip);
      expect(other).toMatchObject({ _tag: "HostFailed" });
      expect(seen).toHaveLength(1);
      expect(readFileSync(join(worktree, "scratch.txt"), "utf8")).toBe("uncommitted\n");
    }).pipe(Effect.scoped, Effect.provide(Live)),
  );

  it.live("a head that conflicts with its base is a conflict, never run", () =>
    Effect.gen(function* () {
      const { dir, clone, worktree } = fixture();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      write(join(worktree, "tracked.txt"), "theirs\n");
      run(worktree, "commit", "-q", "-am", "theirs");
      write(join(clone, "tracked.txt"), "ours\n");
      run(clone, "commit", "-q", "-am", "ours");
      let ran = 0;
      const { connection } = yield* machine(dir, () =>
        Effect.sync(() => {
          ran++;
          return { ok: true };
        }),
      );
      const result = yield* connection.checks!.run({
        id: "check-2",
        path: worktree,
        head: run(worktree, "rev-parse", "HEAD").trim(),
        base: run(clone, "rev-parse", "HEAD").trim(),
        command: "invented-check",
        timeoutMs: 60_000,
      });
      expect(result).toMatchObject({ ok: false, tree: null, failure: { kind: "conflict" } });
      expect(ran).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(Live)),
  );

  it.live("a host that doesn't advertise checks has none to the control plane", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      const { connection } = yield* machine(dir, () => Effect.die("never run"), HOST_CAPABILITIES);
      expect(connection.checks).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(Live)),
  );
});
