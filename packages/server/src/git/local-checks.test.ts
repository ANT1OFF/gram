import {
  localCheckConcurrencyOf,
  ProjectLocalCheck as ProjectLocalCheckSchema,
  type ProjectLocalCheck,
} from "@gram/contracts";
import { describe, expect, it } from "@effect/vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Proc, ProcLive, ProcNonBlockingLive } from "@gram/git";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import * as nodePath from "node:path";
import { ThreadStore } from "../persistence/thread-store.ts";
import { SqlClient } from "../platform/unstable.ts";
import {
  LocalChecks,
  type LocalCheck,
  type LocalCheckRunnerShape,
  localCheckRunFor,
  LOCAL_CHECK_ISOLATION,
  runIdOf,
  spawnCheck,
  readExitStatus as readExitStatusOf,
} from "./local-checks.ts";
import { checked, configured, fixture, layer } from "./local-checks-fixture.ts";
import { hasGit, makeRepo, removeDir, run, tempDir, write } from "./test-repo.ts";

/** Assemble the known disjoint synthetic merge without asking Git to merge omitted blobs. */
const fixtureTree = (dir: string, repo: string, base: string, head: string): string => {
  const env = {
    ...process.env,
    GIT_INDEX_FILE: nodePath.join(dir, "fixture-index"),
    GIT_NO_LAZY_FETCH: "1",
  };
  execFileSync("git", ["read-tree", base], { cwd: repo, env });
  const oid = run(repo, "rev-parse", `${head}:feature.txt`).trim();
  execFileSync("git", ["update-index", "--add", "--cacheinfo", `100644,${oid},feature.txt`], {
    cwd: repo,
    env,
  });
  return execFileSync("git", ["write-tree"], { cwd: repo, env, encoding: "utf8" }).trim();
};

/** What launchd gives an app opened from Finder or the Dock. */
const LAUNCHD_PATH = "/usr/bin:/bin";

/** Whether the process `pid` is still there. */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Passes only where `test.sh` says so, and keeps what it saw of `shared.txt`. */
const judge =
  (seen: Array<string>): LocalCheckRunnerShape["run"] =>
  (worktree) =>
    Effect.sync(() => {
      seen.push(readFileSync(nodePath.join(worktree, "shared.txt"), "utf8"));
      return {
        ok: readFileSync(nodePath.join(worktree, "test.sh"), "utf8").trim() === "exit 0",
      };
    });

/** `feature` changes `shared.txt` and adds a failing `test.sh`; `main` changes `shared.txt` too. */
const failing = () => {
  const dir = tempDir();
  const repo = makeRepo(dir);
  write(nodePath.join(repo, "shared.txt"), "a\nb\nc\nd\ne\nf\n");
  run(repo, "add", "shared.txt");
  run(repo, "commit", "-q", "-m", "shared");
  run(repo, "checkout", "-q", "-b", "feature");
  write(nodePath.join(repo, "shared.txt"), "A\nb\nc\nd\ne\nf\n");
  write(nodePath.join(repo, "test.sh"), "exit 1\n");
  run(repo, "add", "shared.txt", "test.sh");
  run(repo, "commit", "-q", "-m", "failing test");
  const head = run(repo, "rev-parse", "HEAD").trim();
  run(repo, "checkout", "-q", "main");
  write(nodePath.join(repo, "shared.txt"), "a\nb\nc\nd\ne\nF\n");
  run(repo, "commit", "-q", "-am", "base");
  const base = run(repo, "rev-parse", "HEAD").trim();
  const info = nodePath.join(repo, ".git", "info");
  mkdirSync(info, { recursive: true });
  return { dir, repo, head, base, info };
};

describe.skipIf(!hasGit)("Gram's own local checks", () => {
  it.live(
    "checks the head merged onto the base in a throwaway worktree, kept across a restart",
    () =>
      Effect.gen(function* () {
        const { dir, repo, head, base } = fixture();
        write(nodePath.join(repo, "scratch.txt"), "untracked\n");
        const seen: Array<{ dir: string; files: Array<string> }> = [];
        const runner: LocalCheckRunnerShape["run"] = (worktree) =>
          Effect.sync(() => {
            seen.push({
              dir: worktree,
              files: ["feature.txt", "base.txt", "scratch.txt"].filter((file) =>
                existsSync(nodePath.join(worktree, file)),
              ),
            });
            return { ok: true };
          });
        const database = nodePath.join(dir, "gram.db");
        const passed = yield* checked(repo, head, base).pipe(
          Effect.provide(layer(database, dir, runner)),
        );
        expect(passed).toMatchObject({ status: "passed", head, base });
        expect(seen).toEqual([{ dir: seen[0]!.dir, files: ["feature.txt", "base.txt"] }]);
        // The worktree is gone, and git no longer lists it.
        expect(existsSync(seen[0]!.dir)).toBe(false);
        expect(run(repo, "worktree", "list")).not.toContain(seen[0]!.dir);

        // A restart reads the pass back, and asking again doesn't run it again.
        yield* Effect.gen(function* () {
          const checks = yield* LocalChecks;
          expect(yield* checks.lookup(repo, head, base)).toMatchObject({ status: "passed" });
          expect(yield* checked(repo, head, base)).toMatchObject({ status: "passed" });
          // Another base is another check.
          run(repo, "checkout", "-q", "main");
          write(nodePath.join(repo, "later.txt"), "later\n");
          run(repo, "add", "later.txt");
          run(repo, "commit", "-q", "-m", "later");
          const later = run(repo, "rev-parse", "HEAD").trim();
          expect(yield* checks.lookup(repo, head, later)).toBeUndefined();
        }).pipe(Effect.provide(layer(database, dir, runner)));
        expect(seen).toHaveLength(1);
        removeDir(dir);
      }),
  );

  it.live("logs a work directory failure before the check starts", () =>
    Effect.gen(function* () {
      const { dir, repo, head, base } = fixture();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      const checks = nodePath.join(dir, "local-checks");
      mkdirSync(checks);
      write(nodePath.join(checks, "work"), "a file where the directory should be");
      const database = nodePath.join(dir, "gram.db");
      const failed = yield* checked(repo, head, base).pipe(
        Effect.provide(layer(database, dir, () => Effect.die("check should not run"))),
      );
      expect(failed).toMatchObject({
        status: "failed",
        failure: { kind: "unstartable" },
        reason: expect.stringContaining("EEXIST"),
      });
      expect(readFileSync(failed!.log!, "utf8")).toContain("EEXIST");
    }).pipe(Effect.scoped),
  );

  it.live(
    "an explicit fence reconciliation retires an older pass without bypassing the managed runner",
    () =>
      Effect.gen(function* () {
        const { dir, repo, head, base } = fixture();
        yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
        let runs = 0;
        const runner: LocalCheckRunnerShape["run"] = () =>
          Effect.sync(() => {
            runs++;
            return { ok: true };
          });
        yield* Effect.gen(function* () {
          const checks = yield* LocalChecks;
          const first = yield* checked(repo, head, base);
          expect(first?.status).toBe("passed");
          const done = yield* Deferred.make<LocalCheck>();
          const fresh = yield* checks.ensure(repo, head, base, {
            since: 0,
            after: first!.startedAt,
            onDone: (check) => Deferred.succeed(done, check).pipe(Effect.asVoid),
          });
          expect(fresh?.status).toBe("running");
          expect((yield* Deferred.await(done)).status).toBe("passed");
          expect(runs).toBe(2);
          expect(
            yield* checks.ensure(repo, head, base, {
              since: 0,
              after: first!.startedAt,
              onDone: () => Effect.void,
            }),
          ).toMatchObject({ status: "passed" });
          expect(runs).toBe(2);
        }).pipe(Effect.provide(layer(nodePath.join(dir, "gram.db"), dir, runner)));
      }).pipe(Effect.scoped),
  );

  // Selected-source preparation runs only on Linux; the test after these checks it refuses elsewhere.
  it.live.skipIf(process.platform !== "linux")(
    "prepares only an approved merged-tree selection and refuses substitutions",
    () =>
      Effect.gen(function* () {
        expect(Object.keys(ProjectLocalCheckSchema.fields)).toContain("preparation");
        // The omitted object exists only in Git and is identical in both branches.
        const { dir, repo, head, base, protectedOid: oid } = fixture(true);
        const tree = fixtureTree(dir, repo, base, head);
        const entries = run(repo, "ls-tree", "-r", "-z", "--full-tree", tree)
          .split("\0")
          .filter(Boolean)
          .map((item) => {
            const [meta, path] = item.split("\t");
            const [mode, , blob] = meta!.split(" ");
            return { path: path!, mode: mode!, oid: blob!, selected: path !== ".env.example" };
          });
        const manifest = nodePath.join(dir, "selected.json");
        const prepare = (doc: object) => {
          const raw = JSON.stringify(doc);
          write(manifest, raw);
          return { manifest, sha256: createHash("sha256").update(raw).digest("hex") };
        };
        const doc = { schema: "gram.selected-source/v1", head, base, tree, entries };
        const seen: Array<string> = [];
        const gitCalls: Array<{
          args: ReadonlyArray<string>;
          env: Readonly<Record<string, string>> | undefined;
        }> = [];
        const traced = Layer.effect(
          Proc,
          Effect.map(Effect.service(Proc), (proc) =>
            Proc.of({
              run: (bin, args, options) =>
                Effect.suspend(() => {
                  if (bin === "git") gitCalls.push({ args, env: options.env });
                  return proc.run(bin, args, options);
                }),
            }),
          ),
        ).pipe(Layer.provide(ProcLive));
        const child = nodePath.join(dir, "synthetic-check.cjs");
        const expectedDigest = createHash("sha256").update(JSON.stringify(doc)).digest("hex");
        write(
          child,
          `const fs=require("node:fs");if(fs.existsSync(".env.example")||process.env.GRAM_CHECK_SOURCE_SELECTION_MANIFEST!==${JSON.stringify(manifest)}||process.env.GRAM_CHECK_SOURCE_SELECTION_SHA256!==${JSON.stringify(expectedDigest)}||process.env.GRAM_CHECK_APPROVED_INPUT_SHA256!==${JSON.stringify("c".repeat(64))})process.exit(1);`,
        );
        const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(child)}`;
        const runner: LocalCheckRunnerShape["run"] = (work, log, wanted, source) =>
          Effect.gen(function* () {
            expect(existsSync(nodePath.join(work, ".env.example"))).toBe(false);
            expect(existsSync(nodePath.join(work, "feature.txt"))).toBe(true);
            expect(run(work, "ls-files", "--stage")).toContain(".env.example");
            expect(
              run(work, "ls-files", "-v")
                .split("\n")
                .filter(Boolean)
                .every((row) => row.startsWith("H ")),
            ).toBe(true);
            seen.push(work);
            return yield* spawnCheck(
              work,
              log,
              {
                base: {
                  HOME: dir,
                  GRAM_CHECK_SOURCE_SELECTION_SHA256: "inherited-forgery",
                  GRAM_CHECK_APPROVED_INPUT_SHA256: "inherited-forgery",
                },
                pathValue: LAUNCHD_PATH,
                retain: source.retain,
              },
              wanted,
            );
          });
        const execute = (setting: ProjectLocalCheck, suffix: string) =>
          Effect.gen(function* () {
            yield* configured(repo, setting);
            const store = yield* ThreadStore;
            const projects = yield* store.listProjects;
            expect(
              projects.find((p) => p.root === repo)?.localCheck,
              "stored selection",
            ).toMatchObject(setting);
            return yield* checked(repo, head, base);
          }).pipe(
            Effect.provide(layer(nodePath.join(dir, suffix + ".db"), dir, runner, false, traced)),
          );
        const pass = yield* execute(
          { command, preparation: { ...prepare(doc), inputConfigSha256: "c".repeat(64) } },
          "pass",
        );
        expect(pass, JSON.stringify(pass)).toMatchObject({ status: "passed" });
        const fetches = gitCalls.filter(({ args }) => args.includes("fetch"));
        expect(fetches.some(({ args }) => args.includes("--filter=blob:none"))).toBe(true);
        expect(
          fetches.every(({ args, env }) => !args.includes(oid!) && env?.GIT_NO_LAZY_FETCH === "1"),
        ).toBe(true);
        expect(
          gitCalls
            .filter(({ args }) => args.includes("merge-tree"))
            .every(({ env }) => env?.GIT_NO_LAZY_FETCH === "1"),
        ).toBe(true);
        expect(pass?.omittedSources).toEqual([
          { path: ".env.example", mode: "100644", oid, contents: "NOT_READ_OR_VERIFIED" },
        ]);
        expect(seen).toHaveLength(1);
        expect(existsSync(seen[0]!)).toBe(false);
        const stale = yield* execute(
          { command, preparation: prepare({ ...doc, tree: "0".repeat(40) }) },
          "stale",
        );
        expect(stale).toMatchObject({ status: "failed", failure: { kind: "unstartable" } });
        const missing = yield* execute(
          { command, preparation: prepare({ ...doc, entries: entries.slice(1) }) },
          "missing",
        );
        expect(missing).toMatchObject({ status: "failed", failure: { kind: "unstartable" } });
        const selectedProtected = entries.map((row) =>
          row.path === ".env.example" ? { ...row, selected: true } : row,
        );
        const refused = yield* execute(
          { command, preparation: prepare({ ...doc, entries: selectedProtected }) },
          "protected",
        );
        expect(refused).toMatchObject({ status: "failed", failure: { kind: "unstartable" } });
        const duplicate = yield* execute(
          { command, preparation: prepare({ ...doc, entries: [...entries, entries[0]] }) },
          "duplicate",
        );
        expect(duplicate).toMatchObject({ status: "failed", failure: { kind: "unstartable" } });
        const substituted = entries.map((row) =>
          row.path === "feature.txt" ? { ...row, oid: "0".repeat(40) } : row,
        );
        const wrongBlob = yield* execute(
          { command, preparation: prepare({ ...doc, entries: substituted }) },
          "blob",
        );
        expect(wrongBlob).toMatchObject({ status: "failed", failure: { kind: "unstartable" } });
        const escaped = entries.map((row) =>
          row.path === "feature.txt" ? { ...row, path: "../escape" } : row,
        );
        const traversal = yield* execute(
          { command, preparation: prepare({ ...doc, entries: escaped }) },
          "traversal",
        );
        expect(traversal).toMatchObject({ status: "failed", failure: { kind: "unstartable" } });
        const wrongHead = yield* execute(
          { command, preparation: prepare({ ...doc, head: "0".repeat(40) }) },
          "head",
        );
        expect(wrongHead).toMatchObject({ status: "failed", failure: { kind: "unstartable" } });
        const changedDigest = prepare(doc);
        changedDigest.sha256 = "0".repeat(64);
        const digestFailure = yield* execute({ command, preparation: changedDigest }, "digest");
        expect(digestFailure).toMatchObject({ status: "failed", failure: { kind: "unstartable" } });
        expect(seen).toHaveLength(1);
        // A server without filter capability must be refused before any fetch.
        let refusedFetch = false;
        const noFilter = Layer.effect(
          Proc,
          Effect.map(Effect.service(Proc), (proc) =>
            Proc.of({
              run: (bin, args, options) =>
                Effect.suspend(() => {
                  if (bin === "git" && args.includes("fetch")) refusedFetch = true;
                  if (bin === "git" && args.includes("ls-remote"))
                    return Effect.succeed({
                      status: 0,
                      stdout: "",
                      stderr: "fetch=shallow",
                      truncated: false,
                    });
                  return proc.run(bin, args, options);
                }),
            }),
          ),
        ).pipe(Layer.provide(ProcLive));
        const noCapability = yield* Effect.gen(function* () {
          yield* configured(repo, { command, preparation: prepare(doc) });
          return yield* checked(repo, head, base);
        }).pipe(
          Effect.provide(layer(nodePath.join(dir, "no-filter.db"), dir, runner, false, noFilter)),
        );
        expect(noCapability).toMatchObject({ status: "failed", failure: { kind: "unstartable" } });
        expect(refusedFetch).toBe(false);
        expect(seen).toHaveLength(1);
        const priorMerges = gitCalls.filter(({ args }) => args.includes("merge-tree")).length;
        // Change only the omitted synthetic Git object, without creating a protected file.
        const changedOid = execFileSync("git", ["hash-object", "-w", "--stdin"], {
          cwd: repo,
          input: "different synthetic protected fixture",
          encoding: "utf8",
        }).trim();
        const env = { ...process.env, GIT_INDEX_FILE: nodePath.join(dir, "changed-index") };
        execFileSync("git", ["read-tree", head], { cwd: repo, env });
        execFileSync(
          "git",
          ["update-index", "--add", "--cacheinfo", `100644,${changedOid},.env.example`],
          { cwd: repo, env },
        );
        const changedTree = execFileSync("git", ["write-tree"], {
          cwd: repo,
          env,
          encoding: "utf8",
        }).trim();
        const changedHead = run(
          repo,
          "commit-tree",
          changedTree,
          "-p",
          head,
          "-m",
          "changed synthetic omission",
        ).trim();
        const changedDoc = { ...doc, head: changedHead };
        const blocked = yield* Effect.gen(function* () {
          yield* configured(repo, { command, preparation: prepare(changedDoc) });
          return yield* checked(repo, changedHead, base);
        }).pipe(
          Effect.provide(
            layer(nodePath.join(dir, "changed-omission.db"), dir, runner, false, traced),
          ),
        );
        expect(gitCalls.filter(({ args }) => args.includes("merge-tree"))).toHaveLength(
          priorMerges,
        );
        expect(blocked).toMatchObject({ status: "failed", failure: { kind: "unstartable" } });
        expect(seen).toHaveLength(1);
        // Both sides changing an omitted object must stop before merge-tree too.
        const otherOid = execFileSync("git", ["hash-object", "-w", "--stdin"], {
          cwd: repo,
          input: "third synthetic protected fixture",
          encoding: "utf8",
        }).trim();
        const otherEnv = { ...process.env, GIT_INDEX_FILE: nodePath.join(dir, "conflict-index") };
        execFileSync("git", ["read-tree", base], { cwd: repo, env: otherEnv });
        execFileSync(
          "git",
          ["update-index", "--add", "--cacheinfo", `100644,${otherOid},.env.example`],
          { cwd: repo, env: otherEnv },
        );
        const otherTree = execFileSync("git", ["write-tree"], {
          cwd: repo,
          env: otherEnv,
          encoding: "utf8",
        }).trim();
        const otherBase = run(
          repo,
          "commit-tree",
          otherTree,
          "-p",
          base,
          "-m",
          "conflicting synthetic omission",
        ).trim();
        const conflicting = yield* Effect.gen(function* () {
          yield* configured(repo, {
            command,
            preparation: prepare({ ...doc, head: changedHead, base: otherBase }),
          });
          return yield* checked(repo, changedHead, otherBase);
        }).pipe(
          Effect.provide(
            layer(nodePath.join(dir, "conflicting-omission.db"), dir, runner, false, traced),
          ),
        );
        expect(conflicting).toMatchObject({ status: "failed", failure: { kind: "unstartable" } });
        expect(gitCalls.filter(({ args }) => args.includes("merge-tree"))).toHaveLength(
          priorMerges,
        );
        expect(seen).toHaveLength(1);
        removeDir(dir);
      }),
  );

  // Selected-source preparation runs only on Linux; the test after these checks it refuses elsewhere.
  it.live.skipIf(process.platform !== "linux")(
    "refuses attribute-transformed selected bytes before starting the command",
    () =>
      Effect.gen(function* () {
        const { dir, repo } = fixture();
        run(repo, "checkout", "-q", "feature");
        write(nodePath.join(repo, "feature.txt"), "$Id$\n");
        run(repo, "add", "feature.txt");
        run(repo, "commit", "-qm", "ident content");
        const head = run(repo, "rev-parse", "HEAD").trim();
        run(repo, "checkout", "-q", "main");
        write(nodePath.join(repo, ".gitattributes"), "feature.txt ident\n");
        run(repo, "add", ".gitattributes");
        run(repo, "commit", "-qm", "ident attribute");
        const base = run(repo, "rev-parse", "HEAD").trim();
        const tree = fixtureTree(dir, repo, base, head);
        const entries = run(repo, "ls-tree", "-r", "-z", "--full-tree", tree)
          .split("\0")
          .filter(Boolean)
          .map((item) => {
            const [meta, path] = item.split("\t");
            const [mode, , oid] = meta!.split(" ");
            return { path: path!, mode: mode!, oid: oid!, selected: true };
          });
        const raw = JSON.stringify({
          schema: "gram.selected-source/v1",
          head,
          base,
          tree,
          entries,
        });
        const manifest = nodePath.join(dir, "selection.json");
        write(manifest, raw);
        let invoked = false;
        const runner: LocalCheckRunnerShape["run"] = () =>
          Effect.sync(() => {
            invoked = true;
            return { ok: true };
          });
        const outcome = yield* Effect.gen(function* () {
          yield* configured(repo, {
            command: "synthetic",
            preparation: {
              manifest,
              sha256: createHash("sha256").update(raw).digest("hex"),
            },
          });
          return yield* checked(repo, head, base);
        }).pipe(Effect.provide(layer(nodePath.join(dir, "ident.db"), dir, runner, false)));
        expect(outcome).toMatchObject({
          status: "failed",
          reason: "selected-source materialization differs",
        });
        expect(invoked).toBe(false);
        removeDir(dir);
      }),
  );

  it.live.skipIf(process.platform === "linux" || process.platform === "win32")(
    "refuses a selected-source check off Linux before starting the command",
    () =>
      Effect.gen(function* () {
        const { dir, repo, head, base } = fixture();
        const tree = fixtureTree(dir, repo, base, head);
        const raw = JSON.stringify({
          schema: "gram.selected-source/v1",
          head,
          base,
          tree,
          entries: [],
        });
        const manifest = nodePath.join(dir, "selection.json");
        write(manifest, raw);
        let invoked = false;
        const runner: LocalCheckRunnerShape["run"] = () =>
          Effect.sync(() => {
            invoked = true;
            return { ok: true };
          });
        const outcome = yield* Effect.gen(function* () {
          yield* configured(repo, {
            command: "synthetic",
            preparation: {
              manifest,
              sha256: createHash("sha256").update(raw).digest("hex"),
            },
          });
          return yield* checked(repo, head, base);
        }).pipe(Effect.provide(layer(nodePath.join(dir, "off-linux.db"), dir, runner, false)));
        expect(outcome).toMatchObject({
          status: "failed",
          reason: "selected-source metadata preparation refused",
          failure: { kind: "unstartable" },
        });
        expect(invoked).toBe(false);
        removeDir(dir);
      }),
  );

  it.live.skipIf(process.platform === "win32")(
    "removes a stopped check's worktree only once the processes it owns have exited",
    () =>
      Effect.gen(function* () {
        const { dir, repo, head, base } = fixture();
        const pidFile = nodePath.join(dir, "pid");
        const script = nodePath.join(dir, "child.cjs");
        // It ignores SIGTERM before it writes its pid, so no interruption lands in between.
        write(
          script,
          `process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(process.argv[2], String(process.pid));setInterval(()=>{},1000);`,
        );
        let worktree: string | undefined;
        let pid: number | undefined;
        const runner: LocalCheckRunnerShape["run"] = (work, log, wanted, source) => {
          worktree = work;
          return spawnCheck(
            work,
            log,
            {
              base: { HOME: dir },
              pathValue: LAUNCHD_PATH,
              killGraceMs: 300,
              retain: source.retain,
            },
            { ...wanted, command: `exec "${process.execPath}" "${script}" "${pidFile}"` },
          );
        };
        try {
          // Gram quits while the check runs: its scope closes.
          yield* Effect.scoped(
            Effect.gen(function* () {
              const context = yield* Layer.build(layer(nodePath.join(dir, "gram.db"), dir, runner));
              const started = yield* Effect.gen(function* () {
                const checks = yield* LocalChecks;
                return yield* checks.ensure(repo, head, base, {
                  since: 0,
                  onDone: () => Effect.void,
                });
              }).pipe(Effect.provide(context));
              expect(started?.status).toBe("running");
              for (let n = 0; n < 300 && !existsSync(pidFile); n++)
                yield* Effect.sleep("10 millis");
              pid = Number(readFileSync(pidFile, "utf8"));
            }),
          );
          expect(alive(pid!)).toBe(false);
          expect(existsSync(worktree!)).toBe(false);
        } finally {
          if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
          removeDir(dir);
        }
      }),
  );

  it.live("never lends a pass to another base or head, even when the merged tree is the same", () =>
    Effect.gen(function* () {
      const { dir, repo, head, base } = fixture();
      let runs = 0;
      const runner: LocalCheckRunnerShape["run"] = () => Effect.sync(() => (++runs, { ok: true }));
      yield* Effect.gen(function* () {
        const checks = yield* LocalChecks;
        expect(yield* checked(repo, head, base)).toMatchObject({ status: "passed", head, base });
        expect(runs).toBe(1);

        // The base moves by an empty commit: `head` merged onto it is the very same tree, but the
        // pass was recorded for the old base, so it is stale for the new one.
        run(repo, "checkout", "-q", "main");
        run(repo, "commit", "-q", "--allow-empty", "-m", "empty");
        const moved = run(repo, "rev-parse", "HEAD").trim();
        expect(yield* checks.lookup(repo, head, moved)).toBeUndefined();
        // Asking for the new pair runs it afresh rather than handing back the stale pass.
        expect(yield* checked(repo, head, moved)).toMatchObject({
          status: "passed",
          head,
          base: moved,
        });
        expect(runs).toBe(2);
        expect(yield* checks.lookup(repo, head, moved)).toMatchObject({ base: moved });

        // A new head on the same base is a new check too.
        run(repo, "checkout", "-q", "feature");
        run(repo, "commit", "-q", "--allow-empty", "-m", "next");
        const next = run(repo, "rev-parse", "HEAD").trim();
        expect(yield* checks.lookup(repo, next, moved)).toBeUndefined();
        expect(yield* checked(repo, next, moved)).toMatchObject({ status: "passed", head: next });
        expect(runs).toBe(3);
      }).pipe(Effect.provide(layer(":memory:", dir, runner)));
      removeDir(dir);
    }),
  );

  it.live("counts a pass only for the command it ran, across a restart", () =>
    Effect.gen(function* () {
      const { dir, repo, head, base } = fixture();
      const commands: Array<string> = [];
      const runner: LocalCheckRunnerShape["run"] = (_dir, _log, checkRun) =>
        Effect.sync(() => (commands.push(checkRun.command), { ok: true }));
      const database = nodePath.join(dir, "gram.db");
      const passed = yield* checked(repo, head, base).pipe(
        Effect.provide(layer(database, dir, runner)),
      );
      expect(passed).toMatchObject({
        status: "passed",
        command: localCheckRunFor({ command: "invented-check" })!.command,
      });
      expect(commands).toEqual([localCheckRunFor({ command: "invented-check" })!.command]);
      // The project's command was something else when this pass was recorded.
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ key: string; data: string }>`SELECT key, data FROM local_checks`;
        for (const row of rows) {
          const data = JSON.stringify({ ...JSON.parse(row.data), command: "make old-check" });
          yield* sql`UPDATE local_checks SET data = ${data} WHERE key = ${row.key}`;
        }
      }).pipe(Effect.provide(ThreadStore.layerSqlite(database).pipe(Layer.orDie)));
      yield* Effect.gen(function* () {
        const checks = yield* LocalChecks;
        expect(yield* checks.lookup(repo, head, base)).toBeUndefined();
        expect(
          checks.latest(repo, head, base, (yield* (yield* ThreadStore).listProjects)[0]),
        ).toBeUndefined();
        expect(yield* checked(repo, head, base)).toMatchObject({
          status: "passed",
          command: localCheckRunFor({ command: "invented-check" })!.command,
        });
      }).pipe(Effect.provide(layer(database, dir, runner)));
      expect(commands).toHaveLength(2);
      removeDir(dir);
    }),
  );

  it.live("checks the real head, whatever a replace ref, a graft or a checkout hook says", () =>
    Effect.gen(function* () {
      const { dir, repo, head, base } = fixture();
      // Something else, standing in for the head through a replace ref.
      run(repo, "checkout", "-q", "-b", "decoy", base);
      write(nodePath.join(repo, "decoy.txt"), "decoy\n");
      run(repo, "add", "decoy.txt");
      run(repo, "commit", "-q", "-m", "decoy");
      const decoy = run(repo, "rev-parse", "HEAD").trim();
      run(repo, "checkout", "-q", "main");
      run(repo, "replace", head, decoy);
      // A graft that has the head branch off `base`: the merge would then drop base.txt.
      write(
        nodePath.resolve(repo, run(repo, "rev-parse", "--git-common-dir").trim(), "info", "grafts"),
        `${head} ${base}\n`,
      );
      // And a checkout hook that would write into the worktree after git did.
      const hooks = nodePath.join(dir, "hooks");
      mkdirSync(hooks);
      write(nodePath.join(hooks, "post-checkout"), "#!/bin/sh\necho hooked > hooked.txt\n");
      chmodSync(nodePath.join(hooks, "post-checkout"), 0o755);
      run(repo, "config", "core.hooksPath", hooks);
      const seen: Array<Array<string>> = [];
      const runner: LocalCheckRunnerShape["run"] = (worktree) =>
        Effect.sync(() => {
          seen.push(
            ["feature.txt", "base.txt", "decoy.txt", "hooked.txt"].filter((file) =>
              existsSync(nodePath.join(worktree, file)),
            ),
          );
          return { ok: true };
        });
      yield* checked(repo, head, base).pipe(Effect.provide(layer(":memory:", dir, runner)));
      expect(seen).toEqual([["feature.txt", "base.txt"]]);
      removeDir(dir);
    }),
  );

  describe("what an agent's checkout can write to its repository", () => {
    it.live("a stored pass without the isolation never qualifies, however it is keyed", () =>
      Effect.gen(function* () {
        const { dir, repo, head, base, info } = failing();
        // As a runner without the isolation would see it: a repo-local smudge filter turns the
        // committed `exit 1` into `exit 0` in the check's checkout, and that runner records a pass.
        run(repo, "config", "filter.evil.smudge", "cat >/dev/null; echo 'exit 0'");
        write(nodePath.join(info, "attributes"), "test.sh filter=evil\n");
        const tree = run(repo, "merge-tree", "--write-tree", "--no-messages", base, head).trim();
        const unisolated = {
          head,
          base,
          tree,
          status: "passed",
          command: "invented-check",
          startedAt: 1,
          finishedAt: 2,
          host: "unisolated",
        };
        const database = nodePath.join(dir, "gram.db");
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* configured(repo, { command: unisolated.command });
          const project = (yield* (yield* ThreadStore).listProjects)[0]!;
          const data = { ...unisolated, projectId: project.id, timeoutMs: 5_400_000 };
          // Under a key without the base, and under one for another run.
          for (const key of [`${head}:${tree}`, `${head}:${base}:${tree}:other-run`])
            yield* sql`INSERT INTO local_checks (key, data) VALUES (${key}, ${JSON.stringify(data)})`;
        }).pipe(Effect.provide(ThreadStore.layerSqlite(database).pipe(Layer.orDie)));
        const seen: Array<string> = [];
        yield* Effect.gen(function* () {
          const checks = yield* LocalChecks;
          expect(yield* checks.lookup(repo, head, base)).toBeUndefined();
          expect(
            checks.latest(repo, head, base, (yield* (yield* ThreadStore).listProjects)[0]),
          ).toBeUndefined();
          // Asked for, it runs afresh, isolated, and the committed `exit 1` fails it.
          expect(yield* checked(repo, head, base)).toMatchObject({
            status: "failed",
            isolation: LOCAL_CHECK_ISOLATION,
          });
          expect(seen).toHaveLength(1);
          expect(yield* checks.lookup(repo, head, base)).toMatchObject({ status: "failed" });
        }).pipe(Effect.provide(layer(database, dir, judge(seen))));
        removeDir(dir);
      }),
    );

    it.live("ignores git variables Gram inherited that point it at the agent's repository", () =>
      Effect.gen(function* () {
        const { dir, repo, head, base } = failing();
        const attributes = nodePath.join(dir, "attributes");
        write(attributes, "test.sh filter=evil\n");
        // As if Gram were launched from a shell inside the agent's checkout, with config injected.
        const inherited: Record<string, string> = {
          GIT_DIR: nodePath.join(repo, ".git"),
          GIT_WORK_TREE: repo,
          GIT_COMMON_DIR: nodePath.join(repo, ".git"),
          GIT_INDEX_FILE: nodePath.join(repo, ".git", "index"),
          GIT_ALTERNATE_OBJECT_DIRECTORIES: nodePath.join(repo, ".git", "objects"),
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: "filter.evil.smudge",
          GIT_CONFIG_VALUE_0: "cat >/dev/null; echo 'exit 0'",
          GIT_CONFIG_KEY_1: "core.attributesFile",
          GIT_CONFIG_VALUE_1: attributes,
        };
        const before = { ...process.env };
        // In process, and through the command worker the server uses on macOS, which a function
        // in the run's options would never reach.
        for (const proc of [ProcLive, ProcNonBlockingLive]) {
          const seen: Array<string> = [];
          const result = yield* Effect.acquireUseRelease(
            Effect.sync(() => Object.assign(process.env, inherited)),
            () =>
              checked(repo, head, base).pipe(
                Effect.provide(layer(":memory:", dir, judge(seen), true, proc)),
              ),
            () =>
              Effect.sync(() => {
                for (const name of Object.keys(inherited))
                  if (before[name] === undefined) delete process.env[name];
                  else process.env[name] = before[name];
              }),
          );
          expect(result).toMatchObject({ status: "failed" });
          expect(seen).toHaveLength(1);
        }
        removeDir(dir);
      }),
    );

    it.live("a smudge filter can't rewrite what is checked", () =>
      Effect.gen(function* () {
        const { dir, repo, head, base, info } = failing();
        run(repo, "config", "filter.evil.smudge", "cat >/dev/null; echo 'exit 0'");
        write(nodePath.join(info, "attributes"), "test.sh filter=evil\n");
        const seen: Array<string> = [];
        const result = yield* checked(repo, head, base).pipe(
          Effect.provide(layer(":memory:", dir, judge(seen))),
        );
        expect(result).toMatchObject({ status: "failed" });
        removeDir(dir);
      }),
    );

    it.live("a merge driver can't forge the merged tree", () =>
      Effect.gen(function* () {
        const { dir, repo, head, base, info } = failing();
        run(repo, "config", "merge.evil.driver", "echo forged > %A");
        write(nodePath.join(info, "attributes"), "shared.txt merge=evil\n");
        const seen: Array<string> = [];
        yield* checked(repo, head, base).pipe(Effect.provide(layer(":memory:", dir, judge(seen))));
        expect(seen).toEqual(["A\nb\nc\nd\ne\nF\n"]);
        removeDir(dir);
      }),
    );

    it.live("a tampered object file can't stand in for the one its id names", () =>
      Effect.gen(function* () {
        const { dir, repo, head, base } = failing();
        const blob = run(repo, "rev-parse", `${head}:test.sh`).trim();
        write(nodePath.join(dir, "good.sh"), "exit 0\n");
        const good = run(repo, "hash-object", "-w", nodePath.join(dir, "good.sh")).trim();
        const path = (sha: string) =>
          nodePath.join(repo, ".git", "objects", sha.slice(0, 2), sha.slice(2));
        chmodSync(path(blob), 0o644);
        copyFileSync(path(good), path(blob));
        const seen: Array<string> = [];
        const result = yield* checked(repo, head, base).pipe(
          Effect.provide(layer(":memory:", dir, judge(seen))),
        );
        // The forged object never arrives: nothing could be checked, and nothing passed.
        expect(result?.status).not.toBe("passed");
        expect(seen).toEqual([]);
        removeDir(dir);
      }),
    );
  });

  it.live("keeps a failure for its pair until asked again after it, and refuses conflicts", () =>
    Effect.gen(function* () {
      const { dir, repo, head, base } = fixture();
      let runs = 0;
      const runner: LocalCheckRunnerShape["run"] = () =>
        Effect.sync(() => (++runs === 1 ? { ok: false, reason: "exited 1" } : { ok: true }));
      yield* Effect.gen(function* () {
        const failed = yield* checked(repo, head, base, 0);
        expect(failed).toMatchObject({ status: "failed", reason: "exited 1" });
        // Asked again with nothing new: the failure stands, unrun.
        expect(yield* checked(repo, head, base, 0)).toMatchObject({ status: "failed" });
        expect(runs).toBe(1);
        // Asked again after it failed: it runs again.
        expect(yield* checked(repo, head, base, failed!.finishedAt! + 1)).toMatchObject({
          status: "passed",
        });
        expect(runs).toBe(2);

        // A branch that conflicts with its base is never run.
        run(repo, "checkout", "-q", "-b", "clash", base);
        write(nodePath.join(repo, "feature.txt"), "other\n");
        run(repo, "add", "feature.txt");
        run(repo, "commit", "-q", "-m", "clash");
        const clashBase = run(repo, "rev-parse", "HEAD").trim();
        expect(yield* checked(repo, head, clashBase)).toMatchObject({
          status: "failed",
          reason: expect.stringContaining("conflicts with its base"),
        });
        expect(runs).toBe(2);
        // Unknown commits can't be checked at all.
        expect(yield* checked(repo, "f".repeat(40), base)).toBeUndefined();
      }).pipe(Effect.provide(layer(":memory:", dir, runner)));
      removeDir(dir);
    }),
  );
  it.live("runs a run of its own on one commit, and keeps it apart from the project's check", () =>
    Effect.gen(function* () {
      const { dir, repo, head } = fixture();
      const commands: Array<string> = [];
      const runner: LocalCheckRunnerShape["run"] = (_dir, _log, checkRun) =>
        Effect.sync(() => (commands.push(checkRun.command), { ok: true }));
      const own = { ...localCheckRunFor({ command: "driver-cmd" })!, profile: "verify/unit/v1" };
      yield* Effect.gen(function* () {
        const checks = yield* LocalChecks;
        const done = yield* Deferred.make<LocalCheck>();
        yield* checks.ensure(repo, head, head, {
          since: 0,
          run: own,
          onDone: (check) => Deferred.succeed(done, check).pipe(Effect.asVoid),
        });
        expect(yield* Deferred.await(done)).toMatchObject({ status: "passed", head, base: head });
        expect(commands).toEqual(["driver-cmd"]);
        expect(yield* checks.lookup(repo, head, head, undefined, own)).toMatchObject({
          status: "passed",
        });
        // The project's own check of the same pair has no pass from it.
        expect(yield* checks.lookup(repo, head, head)).toBeUndefined();
      }).pipe(Effect.provide(layer(":memory:", dir, runner)));
      removeDir(dir);
    }),
  );
});

/** A fake `bun` whose `run` step does `script`. */
const scriptedBun = (dir: string, script: string, shell = "/bin/sh") => {
  mkdirSync(dir, { recursive: true });
  const bun = nodePath.join(dir, "bun");
  write(
    bun,
    `#!${shell}\nif [ "$1" = "--version" ]; then echo 1.4.3; exit 0; fi\nif [ "$1" = "run" ]; then ${script}; exit $?; fi\nexit 0\n`,
  );
  chmodSync(bun, 0o755);
};

describe.skipIf(process.platform === "win32")("a local check that can't finish", () => {
  // `/bin/sh` is bash on macOS and dash on Debian and Ubuntu, which word the miss differently.
  const shells = ["/bin/sh", "/bin/bash", "/bin/dash"].filter((shell) => existsSync(shell));
  it.live.each(shells)(
    "names a command missing from the check's PATH under %s, not a bare exit 127",
    (shell) =>
      Effect.gen(function* () {
        const dir = tempDir();
        const work = nodePath.join(dir, "work");
        mkdirSync(work);
        const bin = nodePath.join(dir, "bin");
        scriptedBun(bin, "gram-test-missing-tool --version", shell);
        const pathValue = `${bin}:${LAUNCHD_PATH}`;
        const log = nodePath.join(dir, "check.log");
        const outcome = yield* spawnCheck(
          work,
          log,
          { base: { HOME: dir }, pathValue },
          { isolation: LOCAL_CHECK_ISOLATION, command: "bun run check:ci" },
        );
        expect(outcome).toMatchObject({
          ok: false,
          reason: expect.stringContaining(
            "`gram-test-missing-tool` was not found on the check's PATH",
          ),
          failure: {
            kind: "not-found",
            command: "gram-test-missing-tool",
            path: pathValue,
            exitCode: 127,
          },
        });
        expect(outcome.reason).toContain(`PATH=${pathValue}`);
        removeDir(dir);
      }),
  );

  it.live("says it timed out, with the output's end", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      const work = nodePath.join(dir, "work");
      mkdirSync(work);
      const bin = nodePath.join(dir, "bin");
      scriptedBun(bin, "echo still building; sleep 30");
      const log = nodePath.join(dir, "check.log");
      const outcome = yield* spawnCheck(
        work,
        log,
        {
          base: { HOME: dir },
          pathValue: `${bin}:${LAUNCHD_PATH}`,
        },
        { isolation: LOCAL_CHECK_ISOLATION, command: "bun run check:ci", timeoutMs: 800 },
      );
      expect(outcome).toEqual({
        ok: false,
        reason: "timed out: still running after 800 ms, so Gram stopped it",
        failure: { kind: "timed-out", tail: "still building" },
      });
      removeDir(dir);
    }),
  );

  it.live.each([
    ["one that stops on SIGTERM", "sleep 30"],
    ["one that ignores SIGTERM", "sh -c 'trap \"\" TERM; sleep 30; :'"],
  ])("stops what a passing check left running in the background, %s", ([, background]) =>
    Effect.gen(function* () {
      const dir = tempDir();
      const work = nodePath.join(dir, "work");
      mkdirSync(work);
      const bin = nodePath.join(dir, "bin");
      const pidFile = nodePath.join(dir, "pid");
      scriptedBun(bin, `${background} & echo $! > '${pidFile}'; sleep 0.2; exit 0`);
      const outcome = yield* spawnCheck(
        nodePath.join(dir, "work"),
        nodePath.join(dir, "log"),
        {
          base: { HOME: dir },
          pathValue: `${bin}:${LAUNCHD_PATH}`,
          killGraceMs: 500,
        },
        { isolation: LOCAL_CHECK_ISOLATION, command: "bun run check:ci" },
      );
      expect(outcome).toEqual({ ok: true });
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      // Gone, and reaped, by the time the result is told, before the worktree is removed.
      const left = alive(pid);
      if (left) process.kill(pid, "SIGKILL");
      expect(left).toBe(false);
      removeDir(dir);
    }),
  );

  it.live("waits for the processes it owns to exit before an interruption ends", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = tempDir();
        const pidFile = nodePath.join(dir, "pid");
        const script = nodePath.join(dir, "child.cjs");
        write(
          script,
          `process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(process.argv[2], String(process.pid));setInterval(()=>{},1000);`,
        );
        let pid: number | undefined;
        try {
          const fiber = yield* spawnCheck(
            dir,
            nodePath.join(dir, "log"),
            { base: { HOME: dir }, pathValue: LAUNCHD_PATH, killGraceMs: 300 },
            {
              isolation: LOCAL_CHECK_ISOLATION,
              command: `exec "${process.execPath}" "${script}" "${pidFile}"`,
              timeoutMs: 30_000,
            },
          ).pipe(Effect.forkScoped);
          for (let n = 0; n < 200 && !existsSync(pidFile); n++) yield* Effect.sleep("10 millis");
          pid = Number(readFileSync(pidFile, "utf8"));
          const at = Date.now();
          yield* Fiber.interrupt(fiber);
          // It ignored SIGTERM, so the interruption lasted the grace and its SIGKILL.
          expect(Date.now() - at).toBeGreaterThanOrEqual(300);
          expect(alive(pid)).toBe(false);
        } finally {
          if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
          removeDir(dir);
        }
      }),
    ),
  );
});

describe.skipIf(!hasGit)("project local gate configuration", () => {
  it.live("never shares a pass between projects in the same repository", () =>
    Effect.gen(function* () {
      const { dir, repo, head, base } = fixture();
      let runs = 0;
      yield* Effect.gen(function* () {
        const checks = yield* LocalChecks;
        const store = yield* ThreadStore;
        const a = yield* store.ensureProject({ root: repo, name: "A" });
        const nested = nodePath.join(repo, "nested");
        mkdirSync(nested);
        const b = yield* store.ensureProject({ root: nested, repoRoot: repo, name: "B" });
        yield* configured(repo, { command: "same-check" });
        expect(yield* checked(repo, head, base, 0, a.id)).toMatchObject({
          status: "passed",
          projectId: a.id,
        });
        expect(yield* checks.lookup(nested, head, base, b.id)).toBeUndefined();
        yield* configured(nested, { command: "same-check" });
        const currentB = (yield* store.listProjects).find((p) => p.id === b.id)!;
        expect(yield* checks.lookup(nested, head, base, b.id)).toBeUndefined();
        expect(checks.latest(nested, head, base, currentB)).toBeUndefined();
        expect(runs).toBe(1);
        yield* configured(repo, {});
        expect(yield* checks.lookup(repo, head, base, a.id)).toBeUndefined();
      }).pipe(
        Effect.provide(
          layer(
            ":memory:",
            dir,
            () =>
              Effect.sync(() => {
                runs++;
                return { ok: true };
              }),
            false,
          ),
        ),
      );
      removeDir(dir);
    }),
  );
  it.live(
    "defaults to no gate for every project, and configuration changes invalidate passes",
    () =>
      Effect.gen(function* () {
        const { dir, repo, head, base } = fixture();
        let runs = 0;
        yield* Effect.gen(function* () {
          const checks = yield* LocalChecks;
          const store = yield* ThreadStore;
          yield* store.ensureProject({ root: repo, name: "other-language" });
          expect(yield* checks.configuration(repo)).toMatchObject({
            config: undefined,
            reason: expect.stringContaining("no local check configured for other-language"),
          });
          expect(yield* checked(repo, head, base)).toBeUndefined();
          expect(runs).toBe(0);
          // The owner explicitly applies Gram's former command; there is no product seed/detection.
          const command = "bun install --frozen-lockfile && bun run check:ci";
          yield* configured(repo, { command });
          expect(yield* checked(repo, head, base)).toMatchObject({ status: "passed", command });
          yield* configured(repo, { command, setup: "echo setup" });
          expect(yield* checks.lookup(repo, head, base)).toBeUndefined();
          expect(checks.latest(repo, head, base, (yield* store.listProjects)[0])).toBeUndefined();
          yield* checked(repo, head, base);
          yield* configured(repo, { command: "another-check" });
          expect(yield* checks.lookup(repo, head, base)).toBeUndefined();
          expect(checks.latest(repo, head, base, (yield* store.listProjects)[0])).toBeUndefined();
          yield* checked(repo, head, base);
          yield* configured(repo, { command: "another-check", timeoutMs: 5000 });
          expect(yield* checks.lookup(repo, head, base)).toBeUndefined();
          yield* configured(repo, {});
          expect(yield* checks.lookup(repo, head, base)).toBeUndefined();
          expect(yield* checked(repo, head, base)).toBeUndefined();
          expect(runs).toBe(3);
        }).pipe(
          Effect.provide(
            layer(
              ":memory:",
              dir,
              (_dir, _log, config) =>
                Effect.sync(() => {
                  runs++;
                  expect(config.command).toBeTruthy();
                  return { ok: true };
                }),
              false,
            ),
          ),
        );
        removeDir(dir);
      }),
  );
});

describe("project run identity", () => {
  it("has no default and retires passes when any configured field changes", () => {
    expect(localCheckRunFor(undefined)).toBeUndefined();
    expect(localCheckRunFor({ setup: "make deps" })).toBeUndefined();
    const configuredRun = localCheckRunFor({ command: "make test" }, "project-1" as never)!;
    const id = runIdOf(configuredRun);
    const preparation = { manifest: "/tmp/selection.json", sha256: "a".repeat(64) };
    const selected = localCheckRunFor({ command: "make test", preparation }, "project-1" as never)!;
    expect(runIdOf(selected)).not.toBe(id);
    expect(
      runIdOf({ ...selected, preparation: { ...preparation, sha256: "b".repeat(64) } }),
    ).not.toBe(runIdOf(selected));
    expect(
      runIdOf({ ...selected, preparation: { ...preparation, inputConfigSha256: "c".repeat(64) } }),
    ).not.toBe(runIdOf(selected));
    for (const change of [
      { command: "cargo test" },
      { setup: "make deps" },
      { timeoutMs: 1000 },
      { projectId: "project-2" },
      { isolation: "another-runner" },
      { isolation: "own-bare-repository/1" },
    ]) {
      expect(runIdOf({ ...configuredRun, ...change })).not.toBe(id);
    }
  });
});

/** Starts the pair's check in its own service scope, which closes, as Gram quitting does. */
const quitWhile = (
  database: string,
  dir: string,
  repo: string,
  head: string,
  base: string,
  runner: LocalCheckRunnerShape["run"],
  /** Until when the check runs before the quit. */
  until: (check: LocalCheck | undefined) => boolean = () => true,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(layer(database, dir, runner));
      return yield* Effect.gen(function* () {
        const checks = yield* LocalChecks;
        const started = yield* checks.ensure(repo, head, base, {
          since: 0,
          onDone: () => Effect.void,
        });
        expect(started?.status).toBe("running");
        let now = yield* checks.lookup(repo, head, base);
        for (let n = 0; n < 500 && !until(now); n++) {
          yield* Effect.sleep("10 millis");
          now = yield* checks.lookup(repo, head, base);
        }
        return now;
      }).pipe(Effect.provide(context));
    }),
  );

/** A runner that spawns `command` as Gram's own does, durable across a quit. */
const durableRunner =
  (
    dir: string,
    command: string,
    starts: { count: number },
    timeoutMs?: number,
  ): LocalCheckRunnerShape["run"] =>
  (work, log, wanted, source) => {
    starts.count++;
    return spawnCheck(
      work,
      log,
      {
        base: { HOME: dir },
        pathValue: LAUNCHD_PATH,
        killGraceMs: 300,
        retain: source.retain,
        durable: source.durable,
      },
      { ...wanted, command, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
    );
  };

/** Stops a test's own leftover check group, by the id it recorded. */
const stopOwnGroup = (pid: number | undefined) => {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
};

describe.skipIf(!hasGit || process.platform === "win32")("a local check across a quit", () => {
  it.live("runs a check whose process a quit cut off again once, saying so", () =>
    Effect.gen(function* () {
      // Ported from the audit's reproduction: a runner with no process to take back.
      const { dir, repo, head, base } = fixture();
      const database = nodePath.join(dir, "gram.db");
      let starts = 0;
      try {
        yield* quitWhile(
          database,
          dir,
          repo,
          head,
          base,
          () =>
            Effect.sync(() => {
              starts++;
            }).pipe(Effect.andThen(Effect.never)),
          () => starts > 0,
        );
        const outcome = yield* Effect.gen(function* () {
          const checks = yield* LocalChecks;
          // Not silently lost: it reads as running again, and why.
          expect(yield* checks.lookup(repo, head, base)).toMatchObject({
            status: "running",
            afterQuit: "restarted",
            reason: "restarted after Gram quit",
          });
          return yield* checked(repo, head, base);
        }).pipe(
          Effect.provide(
            layer(database, dir, () =>
              Effect.sync(() => {
                starts++;
                return { ok: true };
              }),
            ),
          ),
        );
        expect(outcome).toMatchObject({ status: "passed", afterQuit: "restarted" });
        expect(outcome).not.toHaveProperty("reason");
        expect(outcome).not.toHaveProperty("job");
        // Once before the quit, once after it, and no more.
        expect(starts).toBe(2);
      } finally {
        removeDir(dir);
      }
    }),
  );

  it.live("fails a check a quit cut off a second time, rather than run it a third", () =>
    Effect.gen(function* () {
      const { dir, repo, head, base } = fixture();
      const database = nodePath.join(dir, "gram.db");
      let starts = 0;
      const restarted = () => starts >= 2;
      const never: LocalCheckRunnerShape["run"] = () =>
        Effect.sync(() => {
          starts++;
        }).pipe(Effect.andThen(Effect.never));
      try {
        yield* quitWhile(database, dir, repo, head, base, never, () => starts > 0);
        // Restarted on the next start, and cut off again by the next quit.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(layer(database, dir, never));
            yield* Effect.gen(function* () {
              const checks = yield* LocalChecks;
              for (let n = 0; n < 500 && !restarted(); n++) yield* Effect.sleep("10 millis");
              expect(yield* checks.lookup(repo, head, base)).toMatchObject({
                status: "running",
                afterQuit: "restarted",
              });
            }).pipe(Effect.provide(context));
          }),
        );
        const outcome = yield* Effect.gen(function* () {
          const checks = yield* LocalChecks;
          let found = yield* checks.lookup(repo, head, base);
          for (let n = 0; n < 500 && found?.status === "running"; n++) {
            yield* Effect.sleep("10 millis");
            found = yield* checks.lookup(repo, head, base);
          }
          return found;
        }).pipe(Effect.provide(layer(database, dir, never)));
        expect(outcome).toMatchObject({
          status: "failed",
          failure: { kind: "stopped" },
          reason: expect.stringContaining("again after running it once more"),
        });
        expect(starts).toBe(2);
      } finally {
        removeDir(dir);
      }
    }),
  );

  it.live("keeps a check running past a quit, and takes it back after the restart", () =>
    Effect.gen(function* () {
      const { dir, repo, head, base } = fixture();
      const database = nodePath.join(dir, "gram.db");
      const runs = nodePath.join(dir, "runs");
      const release = nodePath.join(dir, "release");
      const starts = { count: 0 };
      let job: LocalCheck["job"];
      try {
        const running = yield* quitWhile(
          database,
          dir,
          repo,
          head,
          base,
          durableRunner(
            dir,
            `echo run >> '${runs}'; while [ ! -f '${release}' ]; do sleep 0.05; done; echo done`,
            starts,
          ),
          (check) => check?.job?.pid !== undefined,
        );
        job = running?.job;
        expect(job?.pid).toBeDefined();
        // Gram has quit: the check is still running, in its worktree.
        expect(alive(job!.pid!)).toBe(true);
        expect(existsSync(job!.work!)).toBe(true);
        const outcome = yield* Effect.gen(function* () {
          const checks = yield* LocalChecks;
          expect(yield* checks.lookup(repo, head, base)).toMatchObject({
            status: "running",
            afterQuit: "kept",
            reason: "kept running while Gram was closed",
          });
          write(release, "");
          return yield* checked(repo, head, base);
        }).pipe(Effect.provide(layer(database, dir, durableRunner(dir, "exit 1", starts))));
        expect(outcome).toMatchObject({ status: "passed", afterQuit: "kept" });
        expect(outcome).not.toHaveProperty("job");
        // It ran once, from before the quit to its end; nothing ran it again.
        expect(readFileSync(runs, "utf8")).toBe("run\n");
        expect(starts.count).toBe(1);
        expect(readFileSync(outcome!.log!, "utf8")).toContain("done");
        expect(existsSync(job!.work!)).toBe(false);
        expect(alive(job!.pid!)).toBe(false);
      } finally {
        stopOwnGroup(job?.pid);
        removeDir(dir);
      }
    }),
  );

  it.live("keeps how a check ended while Gram was closed", () =>
    Effect.gen(function* () {
      const { dir, repo, head, base } = fixture();
      const database = nodePath.join(dir, "gram.db");
      const release = nodePath.join(dir, "release");
      const starts = { count: 0 };
      let job: LocalCheck["job"];
      try {
        const running = yield* quitWhile(
          database,
          dir,
          repo,
          head,
          base,
          durableRunner(
            dir,
            `while [ ! -f '${release}' ]; do sleep 0.05; done; echo failing; exit 3`,
            starts,
          ),
          (check) => check?.job?.pid !== undefined,
        );
        job = running?.job;
        // It ends while Gram is closed.
        write(release, "");
        for (let n = 0; n < 500 && alive(job!.pid!); n++) yield* Effect.sleep("10 millis");
        const outcome = yield* checked(repo, head, base).pipe(
          Effect.provide(layer(database, dir, durableRunner(dir, "exit 0", starts))),
        );
        expect(outcome).toMatchObject({
          status: "failed",
          afterQuit: "kept",
          reason: "exited 3",
          failure: { kind: "exited", exitCode: 3, tail: expect.stringMatching(/^failing\n/) },
        });
        expect(starts.count).toBe(1);
        expect(existsSync(job!.work!)).toBe(false);
      } finally {
        stopOwnGroup(job?.pid);
        removeDir(dir);
      }
    }),
  );

  it.live("passes a check that ended while Gram was closed, and stops what it left behind", () =>
    Effect.gen(function* () {
      const { dir, repo, head, base } = fixture();
      const database = nodePath.join(dir, "gram.db");
      const release = nodePath.join(dir, "release");
      const leftover = nodePath.join(dir, "leftover");
      const starts = { count: 0 };
      let job: LocalCheck["job"];
      try {
        const running = yield* quitWhile(
          database,
          dir,
          repo,
          head,
          base,
          durableRunner(
            dir,
            `sleep 30 & echo $! > '${leftover}'; while [ ! -f '${release}' ]; do sleep 0.05; done; exit 0`,
            starts,
          ),
          (check) => check?.job?.pid !== undefined,
        );
        job = running?.job;
        write(release, "");
        // It ends, with its background sleep still in its group.
        for (let n = 0; n < 500 && readExitStatusOf(job!.status!) === undefined; n++)
          yield* Effect.sleep("10 millis");
        const outcome = yield* checked(repo, head, base).pipe(
          Effect.provide(layer(database, dir, durableRunner(dir, "exit 1", starts))),
        );
        // Its status, not its deadline 90 minutes on, ends it.
        expect(outcome).toMatchObject({ status: "passed", afterQuit: "kept" });
        expect(alive(Number(readFileSync(leftover, "utf8")))).toBe(false);
        expect(existsSync(job!.work!)).toBe(false);
        expect(starts.count).toBe(1);
      } finally {
        stopOwnGroup(job?.pid);
        removeDir(dir);
      }
    }),
  );

  it.live(
    "fails a check stopped at its deadline while Gram was closed, rather than run it again",
    () =>
      Effect.gen(function* () {
        const { dir, repo, head, base } = fixture();
        const database = nodePath.join(dir, "gram.db");
        const starts = { count: 0 };
        let job: LocalCheck["job"];
        try {
          const running = yield* quitWhile(
            database,
            dir,
            repo,
            head,
            base,
            durableRunner(dir, "sleep 30", starts, 500),
            (check) => check?.job?.pid !== undefined,
          );
          job = running?.job;
          // As its watchdog does once the deadline passes: the group ends before any status.
          stopOwnGroup(job!.pid);
          for (let n = 0; n < 500 && Date.now() < job!.deadline!; n++)
            yield* Effect.sleep("10 millis");
          const outcome = yield* checked(repo, head, base).pipe(
            Effect.provide(layer(database, dir, durableRunner(dir, "exit 0", starts))),
          );
          expect(outcome).toMatchObject({ status: "failed", failure: { kind: "timed-out" } });
          expect(starts.count).toBe(1);
          expect(existsSync(job!.work!)).toBe(false);
        } finally {
          stopOwnGroup(job?.pid);
          removeDir(dir);
        }
      }),
  );

  it.live("stops a check it took back once its deadline passes", () =>
    Effect.gen(function* () {
      const { dir, repo, head, base } = fixture();
      const database = nodePath.join(dir, "gram.db");
      const starts = { count: 0 };
      let job: LocalCheck["job"];
      try {
        const running = yield* quitWhile(
          database,
          dir,
          repo,
          head,
          base,
          durableRunner(dir, "sleep 30", starts, 1500),
          (check) => check?.job?.pid !== undefined,
        );
        job = running?.job;
        const outcome = yield* checked(repo, head, base).pipe(
          Effect.provide(layer(database, dir, durableRunner(dir, "exit 0", starts))),
        );
        expect(outcome).toMatchObject({ status: "failed", failure: { kind: "timed-out" } });
        expect(alive(job!.pid!)).toBe(false);
        expect(existsSync(job!.work!)).toBe(false);
        expect(starts.count).toBe(1);
      } finally {
        stopOwnGroup(job?.pid);
        removeDir(dir);
      }
    }),
  );
});

/** Settings with only a local-check cap, or none. */
const withCap = (localCheckConcurrency?: number) =>
  ({
    workspaces: localCheckConcurrency === undefined ? {} : { localCheckConcurrency },
  }) as unknown as Parameters<typeof localCheckConcurrencyOf>[0];

/** Waits, up to five seconds, for `until`. */
const settle = (until: () => boolean) =>
  Effect.gen(function* () {
    for (let n = 0; n < 500 && !until(); n++) yield* Effect.sleep("10 millis");
  });

describe("local checks at once", () => {
  it("follows the machine's cores until a choice is saved", () => {
    expect(localCheckConcurrencyOf(withCap(), 8)).toBe(1);
    expect(localCheckConcurrencyOf(withCap(), 12)).toBe(2);
    expect(localCheckConcurrencyOf(withCap(3), 8)).toBe(3);
  });
});

describe.skipIf(!hasGit)("a local check over the cap", () => {
  it.live("waits its turn, reading as queued, and runs once the one before it ends", () =>
    Effect.gen(function* () {
      const { dir, repo, head, base } = fixture();
      // A second head on the same base: another check.
      run(repo, "checkout", "-q", head);
      write(nodePath.join(repo, "second.txt"), "second\n");
      run(repo, "add", "second.txt");
      run(repo, "commit", "-q", "-m", "second");
      const second = run(repo, "rev-parse", "HEAD").trim();
      run(repo, "checkout", "-q", "main");
      const started: Array<string> = [];
      const releases = new Map<string, Deferred.Deferred<void>>();
      const runner: LocalCheckRunnerShape["run"] = (_work, _log, _run, source) =>
        Effect.gen(function* () {
          const release = yield* Deferred.make<void>();
          releases.set(source.head, release);
          started.push(source.head);
          yield* Deferred.await(release);
          return { ok: true };
        });
      try {
        yield* Effect.gen(function* () {
          yield* (yield* ThreadStore).updateSettings((settings) => ({
            ...settings,
            workspaces: { ...settings.workspaces, localCheckConcurrency: 1 },
          }));
          const checks = yield* LocalChecks;
          const ends: Array<LocalCheck> = [];
          const ensure = (pair: string) =>
            checks.ensure(repo, pair, base, {
              since: 0,
              onDone: (check) => Effect.sync(() => void ends.push(check)),
            });
          yield* ensure(head);
          yield* ensure(second);
          yield* settle(() => started.length > 0);
          yield* Effect.sleep("200 millis");
          // One runs; the other waits, and says so.
          expect(started).toEqual([head]);
          expect(yield* checks.lookup(repo, second, base)).toMatchObject({
            status: "running",
            reason: "queued for local check (0 ahead)",
          });
          yield* Deferred.succeed(releases.get(head)!, undefined);
          yield* settle(() => started.length > 1);
          expect(started).toEqual([head, second]);
          const now = yield* checks.lookup(repo, second, base);
          expect(now?.status).toBe("running");
          expect(now).not.toHaveProperty("reason");
          yield* Deferred.succeed(releases.get(second)!, undefined);
          yield* settle(() => ends.length > 1);
          expect(ends.map((check) => [check.head, check.status])).toEqual([
            [head, "passed"],
            [second, "passed"],
          ]);
        }).pipe(Effect.provide(layer(nodePath.join(dir, "gram.db"), dir, runner)));
      } finally {
        removeDir(dir);
      }
    }),
  );
});
