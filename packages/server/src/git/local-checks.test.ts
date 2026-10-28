import {
  localCheckConcurrencyOf,
  ProjectLocalCheck as ProjectLocalCheckSchema,
  type ThreadId,
  type ProjectId,
  type ProjectLocalCheck,
} from "@gram/contracts";
import { describe, expect, it } from "@effect/vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { type Proc, ProcLive, ProcNonBlockingLive } from "@gram/git";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  utimesSync,
} from "node:fs";
import * as nodePath from "node:path";
import { ServerConfig } from "../config.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { SqlClient } from "../platform/unstable.ts";
import { TEST_CONFIG } from "../runtime/test-harness.ts";
import {
  LocalCheckRunner,
  LocalChecks,
  LocalChecksLive,
  type LocalCheck,
  type LocalCheckRunnerShape,
  diagnoseExit,
  lastLines,
  localCheckRunFor,
  LOCAL_CHECK_ISOLATION,
  runIdOf,
  missingCommand,
  spawnCheck,
  readExitStatus as readExitStatusOf,
  keptCheck,
  logsOverBudget,
  OTHER_KEEP_MS,
  PASS_KEEP_MS,
} from "./local-checks.ts";
import {
  hasGit,
  makeRepo,
  removeDir,
  run,
  tempDir,
  write,
} from "./test-repo.ts";

/** A repo with `main` one commit past where `feature` branched, each adding its own file. */
const fixture = () => {
  const dir = tempDir();
  const repo = makeRepo(dir);
  run(repo, "checkout", "-q", "-b", "feature");
  write(nodePath.join(repo, "feature.txt"), "feature\n");
  run(repo, "add", "feature.txt");
  run(repo, "commit", "-q", "-m", "feature");
  const head = run(repo, "rev-parse", "HEAD").trim();
  run(repo, "checkout", "-q", "main");
  write(nodePath.join(repo, "base.txt"), "base\n");
  run(repo, "add", "base.txt");
  run(repo, "commit", "-q", "-m", "base");
  const base = run(repo, "rev-parse", "HEAD").trim();
  return { dir, repo, head, base };
};

const configured = (repo: string, setting: ProjectLocalCheck) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const project = yield* store.ensureProject({
      root: repo,
      name: "invented",
    });
    const writes = (
      ["command", "setup", "timeoutMs", "preparation"] as const
    ).map((field) => ({
      key: `project.localCheck.${field}`,
      path: ["localCheck", field],
      before: project.localCheck?.[field],
      after: setting[field],
    }));
    const updated = yield* store.updateProjectLocalCheckAudited(
      project.id,
      writes,
      {
        at: 1,
        threadId: "test" as ThreadId,
        proposerRole: "plain",
        scope: "project",
        approvedBy: "user",
        approvedAt: 1,
        changes: [],
        shown: [],
      },
      project.localCheckRevision!,
    );
    expect(updated).toBeDefined();
  });

const layer = (
  database: string,
  logs: string,
  runner: LocalCheckRunnerShape["run"],
  configure = true,
  proc: Layer.Layer<Proc> = ProcLive,
) =>
  LocalChecksLive.pipe(
    Layer.provide(Layer.succeed(LocalCheckRunner, { run: runner })),
    Layer.provide(proc),
    Layer.provide(ServerConfig.layer({ ...TEST_CONFIG, dataDir: logs })),
    Layer.provideMerge(
      configure
        ? Layer.effectDiscard(
            configured(nodePath.join(logs, "repo"), {
              command: "invented-check",
            }),
          ).pipe(
            Layer.provideMerge(
              ThreadStore.layerSqlite(database).pipe(Layer.orDie),
            ),
          )
        : ThreadStore.layerSqlite(database).pipe(Layer.orDie),
    ),
  );

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

/** Ensures the pair and waits for how it ended. */
const checked = (
  repo: string,
  head: string,
  base: string,
  since = 0,
  projectId?: ProjectId,
) =>
  Effect.gen(function* () {
    const checks = yield* LocalChecks;
    const done = yield* Deferred.make<LocalCheck>();
    const started = yield* checks.ensure(repo, head, base, {
      since,
      ...(projectId === undefined ? {} : { projectId }),
      onDone: (check) => Deferred.succeed(done, check).pipe(Effect.asVoid),
    });
    if (started?.status !== "running") return started;
    return yield* Deferred.await(done);
  });

/** Passes only where `test.sh` says so, and keeps what it saw of `shared.txt`. */
const judge =
  (seen: Array<string>): LocalCheckRunnerShape["run"] =>
  (worktree) =>
    Effect.sync(() => {
      seen.push(readFileSync(nodePath.join(worktree, "shared.txt"), "utf8"));
      return {
        ok:
          readFileSync(nodePath.join(worktree, "test.sh"), "utf8").trim() ===
          "exit 0",
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
        expect(seen).toEqual([
          { dir: seen[0]!.dir, files: ["feature.txt", "base.txt"] },
        ]);
        // The worktree is gone, and git no longer lists it.
        expect(existsSync(seen[0]!.dir)).toBe(false);
        expect(run(repo, "worktree", "list")).not.toContain(seen[0]!.dir);

        // A restart reads the pass back, and asking again doesn't run it again.
        yield* Effect.gen(function* () {
          const checks = yield* LocalChecks;
          expect(yield* checks.lookup(repo, head, base)).toMatchObject({
            status: "passed",
          });
          expect(yield* checked(repo, head, base)).toMatchObject({
            status: "passed",
          });
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

  it.live.skipIf(process.platform === "win32")(
    "prepares only an approved merged-tree selection and refuses substitutions",
    () =>
      Effect.gen(function* () {
        expect(Object.keys(ProjectLocalCheckSchema.fields)).toContain(
          "preparation",
        );
        const { dir, repo, head } = fixture();
        // Install a synthetic protected blob directly in the index, without opening a protected file.
        const oid = execFileSync("git", ["hash-object", "-w", "--stdin"], {
          cwd: repo,
          input: "synthetic protected fixture",
          encoding: "utf8",
        }).trim();
        run(
          repo,
          "update-index",
          "--add",
          "--cacheinfo",
          `100644,${oid},.env.example`,
        );
        run(repo, "commit", "-qm", "synthetic protected tree entry");
        const base = run(repo, "rev-parse", "HEAD").trim();
        const tree = run(
          repo,
          "merge-tree",
          "--write-tree",
          "--no-messages",
          base,
          head,
        ).trim();
        const entries = run(repo, "ls-tree", "-r", "-z", "--full-tree", tree)
          .split("\0")
          .filter(Boolean)
          .map((item) => {
            const [meta, path] = item.split("\t");
            const [mode, , blob] = meta!.split(" ");
            return {
              path: path!,
              mode: mode!,
              oid: blob!,
              selected: path !== ".env.example",
            };
          });
        const manifest = nodePath.join(dir, "selected.json");
        const prepare = (doc: object) => {
          const raw = JSON.stringify(doc);
          write(manifest, raw);
          return {
            manifest,
            sha256: createHash("sha256").update(raw).digest("hex"),
          };
        };
        const doc = {
          schema: "gram.selected-source/v1",
          head,
          base,
          tree,
          entries,
        };
        const seen: Array<string> = [];
        const child = nodePath.join(dir, "synthetic-check.cjs");
        const expectedDigest = createHash("sha256")
          .update(JSON.stringify(doc))
          .digest("hex");
        write(
          child,
          `const fs=require("node:fs");if(fs.existsSync(".env.example")||process.env.GRAM_CHECK_SOURCE_SELECTION_MANIFEST!==${JSON.stringify(manifest)}||process.env.GRAM_CHECK_SOURCE_SELECTION_SHA256!==${JSON.stringify(expectedDigest)}||process.env.GRAM_CHECK_APPROVED_INPUT_SHA256!==${JSON.stringify("c".repeat(64))})process.exit(1);`,
        );
        const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(child)}`;
        const runner: LocalCheckRunnerShape["run"] = (
          work,
          log,
          wanted,
          source,
        ) =>
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
            Effect.provide(
              layer(nodePath.join(dir, suffix + ".db"), dir, runner, false),
            ),
          );
        const pass = yield* execute(
          {
            command,
            preparation: { ...prepare(doc), inputConfigSha256: "c".repeat(64) },
          },
          "pass",
        );
        expect(pass, JSON.stringify(pass)).toMatchObject({ status: "passed" });
        expect(pass?.omittedSources).toEqual([
          {
            path: ".env.example",
            mode: "100644",
            oid,
            contents: "NOT_READ_OR_VERIFIED",
          },
        ]);
        expect(seen).toHaveLength(1);
        expect(existsSync(seen[0]!)).toBe(false);
        const stale = yield* execute(
          { command, preparation: prepare({ ...doc, tree: "0".repeat(40) }) },
          "stale",
        );
        expect(stale).toMatchObject({
          status: "failed",
          failure: { kind: "unstartable" },
        });
        const missing = yield* execute(
          {
            command,
            preparation: prepare({ ...doc, entries: entries.slice(1) }),
          },
          "missing",
        );
        expect(missing).toMatchObject({
          status: "failed",
          failure: { kind: "unstartable" },
        });
        const selectedProtected = entries.map((row) =>
          row.path === ".env.example" ? { ...row, selected: true } : row,
        );
        const refused = yield* execute(
          {
            command,
            preparation: prepare({ ...doc, entries: selectedProtected }),
          },
          "protected",
        );
        expect(refused).toMatchObject({
          status: "failed",
          failure: { kind: "unstartable" },
        });
        const duplicate = yield* execute(
          {
            command,
            preparation: prepare({ ...doc, entries: [...entries, entries[0]] }),
          },
          "duplicate",
        );
        expect(duplicate).toMatchObject({
          status: "failed",
          failure: { kind: "unstartable" },
        });
        const substituted = entries.map((row) =>
          row.path === "feature.txt" ? { ...row, oid: "0".repeat(40) } : row,
        );
        const wrongBlob = yield* execute(
          { command, preparation: prepare({ ...doc, entries: substituted }) },
          "blob",
        );
        expect(wrongBlob).toMatchObject({
          status: "failed",
          failure: { kind: "unstartable" },
        });
        const escaped = entries.map((row) =>
          row.path === "feature.txt" ? { ...row, path: "../escape" } : row,
        );
        const traversal = yield* execute(
          { command, preparation: prepare({ ...doc, entries: escaped }) },
          "traversal",
        );
        expect(traversal).toMatchObject({
          status: "failed",
          failure: { kind: "unstartable" },
        });
        const wrongHead = yield* execute(
          { command, preparation: prepare({ ...doc, head: "0".repeat(40) }) },
          "head",
        );
        expect(wrongHead).toMatchObject({
          status: "failed",
          failure: { kind: "unstartable" },
        });
        const changedDigest = prepare(doc);
        changedDigest.sha256 = "0".repeat(64);
        const digestFailure = yield* execute(
          { command, preparation: changedDigest },
          "digest",
        );
        expect(digestFailure).toMatchObject({
          status: "failed",
          failure: { kind: "unstartable" },
        });
        expect(seen).toHaveLength(1);
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
        const runner: LocalCheckRunnerShape["run"] = (
          work,
          log,
          wanted,
          source,
        ) => {
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
            {
              ...wanted,
              command: `exec "${process.execPath}" "${script}" "${pidFile}"`,
            },
          );
        };
        try {
          // Gram quits while the check runs: its scope closes.
          yield* Effect.scoped(
            Effect.gen(function* () {
              const context = yield* Layer.build(
                layer(nodePath.join(dir, "gram.db"), dir, runner),
              );
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

  it.live(
    "never lends a pass to another base or head, even when the merged tree is the same",
    () =>
      Effect.gen(function* () {
        const { dir, repo, head, base } = fixture();
        let runs = 0;
        const runner: LocalCheckRunnerShape["run"] = () =>
          Effect.sync(() => (++runs, { ok: true }));
        yield* Effect.gen(function* () {
          const checks = yield* LocalChecks;
          expect(yield* checked(repo, head, base)).toMatchObject({
            status: "passed",
            head,
            base,
          });
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
          expect(yield* checks.lookup(repo, head, moved)).toMatchObject({
            base: moved,
          });

          // A new head on the same base is a new check too.
          run(repo, "checkout", "-q", "feature");
          run(repo, "commit", "-q", "--allow-empty", "-m", "next");
          const next = run(repo, "rev-parse", "HEAD").trim();
          expect(yield* checks.lookup(repo, next, moved)).toBeUndefined();
          expect(yield* checked(repo, next, moved)).toMatchObject({
            status: "passed",
            head: next,
          });
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
      expect(commands).toEqual([
        localCheckRunFor({ command: "invented-check" })!.command,
      ]);
      // The project's command was something else when this pass was recorded.
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          key: string;
          data: string;
        }>`SELECT key, data FROM local_checks`;
        for (const row of rows) {
          const data = JSON.stringify({
            ...JSON.parse(row.data),
            command: "make old-check",
          });
          yield* sql`UPDATE local_checks SET data = ${data} WHERE key = ${row.key}`;
        }
      }).pipe(
        Effect.provide(ThreadStore.layerSqlite(database).pipe(Layer.orDie)),
      );
      yield* Effect.gen(function* () {
        const checks = yield* LocalChecks;
        expect(yield* checks.lookup(repo, head, base)).toBeUndefined();
        expect(
          checks.latest(
            repo,
            head,
            base,
            (yield* (yield* ThreadStore).listProjects)[0],
          ),
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

  it.live(
    "checks the real head, whatever a replace ref, a graft or a checkout hook says",
    () =>
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
          nodePath.resolve(
            repo,
            run(repo, "rev-parse", "--git-common-dir").trim(),
            "info",
            "grafts",
          ),
          `${head} ${base}\n`,
        );
        // And a checkout hook that would write into the worktree after git did.
        const hooks = nodePath.join(dir, "hooks");
        mkdirSync(hooks);
        write(
          nodePath.join(hooks, "post-checkout"),
          "#!/bin/sh\necho hooked > hooked.txt\n",
        );
        chmodSync(nodePath.join(hooks, "post-checkout"), 0o755);
        run(repo, "config", "core.hooksPath", hooks);
        const seen: Array<Array<string>> = [];
        const runner: LocalCheckRunnerShape["run"] = (worktree) =>
          Effect.sync(() => {
            seen.push(
              ["feature.txt", "base.txt", "decoy.txt", "hooked.txt"].filter(
                (file) => existsSync(nodePath.join(worktree, file)),
              ),
            );
            return { ok: true };
          });
        yield* checked(repo, head, base).pipe(
          Effect.provide(layer(":memory:", dir, runner)),
        );
        expect(seen).toEqual([["feature.txt", "base.txt"]]);
        removeDir(dir);
      }),
  );

  describe("what an agent's checkout can write to its repository", () => {
    it.live(
      "a stored pass without the isolation never qualifies, however it is keyed",
      () =>
        Effect.gen(function* () {
          const { dir, repo, head, base, info } = failing();
          // As a runner without the isolation would see it: a repo-local smudge filter turns the
          // committed `exit 1` into `exit 0` in the check's checkout, and that runner records a pass.
          run(
            repo,
            "config",
            "filter.evil.smudge",
            "cat >/dev/null; echo 'exit 0'",
          );
          write(nodePath.join(info, "attributes"), "test.sh filter=evil\n");
          const tree = run(
            repo,
            "merge-tree",
            "--write-tree",
            "--no-messages",
            base,
            head,
          ).trim();
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
            const data = {
              ...unisolated,
              projectId: project.id,
              timeoutMs: 5_400_000,
            };
            // Under a key without the base, and under one for another run.
            for (const key of [
              `${head}:${tree}`,
              `${head}:${base}:${tree}:other-run`,
            ])
              yield* sql`INSERT INTO local_checks (key, data) VALUES (${key}, ${JSON.stringify(data)})`;
          }).pipe(
            Effect.provide(ThreadStore.layerSqlite(database).pipe(Layer.orDie)),
          );
          const seen: Array<string> = [];
          yield* Effect.gen(function* () {
            const checks = yield* LocalChecks;
            expect(yield* checks.lookup(repo, head, base)).toBeUndefined();
            expect(
              checks.latest(
                repo,
                head,
                base,
                (yield* (yield* ThreadStore).listProjects)[0],
              ),
            ).toBeUndefined();
            // Asked for, it runs afresh, isolated, and the committed `exit 1` fails it.
            expect(yield* checked(repo, head, base)).toMatchObject({
              status: "failed",
              isolation: LOCAL_CHECK_ISOLATION,
            });
            expect(seen).toHaveLength(1);
            expect(yield* checks.lookup(repo, head, base)).toMatchObject({
              status: "failed",
            });
          }).pipe(Effect.provide(layer(database, dir, judge(seen))));
          removeDir(dir);
        }),
    );

    it.live(
      "ignores git variables Gram inherited that point it at the agent's repository",
      () =>
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
            GIT_ALTERNATE_OBJECT_DIRECTORIES: nodePath.join(
              repo,
              ".git",
              "objects",
            ),
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
                  Effect.provide(
                    layer(":memory:", dir, judge(seen), true, proc),
                  ),
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
        run(
          repo,
          "config",
          "filter.evil.smudge",
          "cat >/dev/null; echo 'exit 0'",
        );
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
        yield* checked(repo, head, base).pipe(
          Effect.provide(layer(":memory:", dir, judge(seen))),
        );
        expect(seen).toEqual(["A\nb\nc\nd\ne\nF\n"]);
        removeDir(dir);
      }),
    );

    it.live(
      "a tampered object file can't stand in for the one its id names",
      () =>
        Effect.gen(function* () {
          const { dir, repo, head, base } = failing();
          const blob = run(repo, "rev-parse", `${head}:test.sh`).trim();
          write(nodePath.join(dir, "good.sh"), "exit 0\n");
          const good = run(
            repo,
            "hash-object",
            "-w",
            nodePath.join(dir, "good.sh"),
          ).trim();
          const path = (sha: string) =>
            nodePath.join(
              repo,
              ".git",
              "objects",
              sha.slice(0, 2),
              sha.slice(2),
            );
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

  it.live(
    "keeps a failure for its pair until asked again after it, and refuses conflicts",
    () =>
      Effect.gen(function* () {
        const { dir, repo, head, base } = fixture();
        let runs = 0;
        const runner: LocalCheckRunnerShape["run"] = () =>
          Effect.sync(() =>
            ++runs === 1 ? { ok: false, reason: "exited 1" } : { ok: true },
          );
        yield* Effect.gen(function* () {
          const failed = yield* checked(repo, head, base, 0);
          expect(failed).toMatchObject({
            status: "failed",
            reason: "exited 1",
          });
          // Asked again with nothing new: the failure stands, unrun.
          expect(yield* checked(repo, head, base, 0)).toMatchObject({
            status: "failed",
          });
          expect(runs).toBe(1);
          // Asked again after it failed: it runs again.
          expect(
            yield* checked(repo, head, base, failed!.finishedAt! + 1),
          ).toMatchObject({
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
});

describe.skipIf(process.platform === "win32")(
  "the configured local check",
  () => {
    it.live(
      "runs setup then command on login-shell PATH without a Bun pin check",
      () =>
        Effect.gen(function* () {
          const dir = tempDir();
          const bin = nodePath.join(dir, "login-bin");
          mkdirSync(bin);
          const tool = nodePath.join(bin, "invented-check");
          write(
            tool,
            '#!/bin/sh\necho "check PATH=$PATH CI=${CI-unset} GRAM=${GRAM_STATE_DIR-unset} GITDIR=${GIT_DIR-unset} SSH=${GIT_SSH_COMMAND-unset}"\ntest -f setup.txt\n',
          );
          chmodSync(tool, 0o755);
          write(nodePath.join(dir, ".bun-version"), "unavailable-bun\n");
          const log = nodePath.join(dir, "check.log");
          const pathValue = `${bin}:${LAUNCHD_PATH}`;
          const environment = {
            base: {
              PATH: LAUNCHD_PATH,
              CI: "1",
              GRAM_STATE_DIR: "/invented",
              GIT_DIR: "/invented/other.git",
              GIT_SSH_COMMAND: "ssh -x",
            },
            pathValue,
          };
          expect(
            yield* spawnCheck(dir, log, environment, {
              isolation: LOCAL_CHECK_ISOLATION,
              setup: "touch setup.txt",
              command: "invented-check",
              timeoutMs: 1000,
            }),
          ).toEqual({ ok: true });
          expect(readFileSync(log, "utf8")).toContain(
            `check PATH=${pathValue} CI=unset GRAM=unset`,
          );
          expect(readFileSync(log, "utf8")).toContain(
            "GITDIR=unset SSH=ssh -x",
          );
          expect(
            yield* spawnCheck(dir, log, environment, {
              isolation: LOCAL_CHECK_ISOLATION,
              setup: "exit 4",
              command: "echo should-not-run",
              timeoutMs: 1000,
            }),
          ).toMatchObject({
            ok: false,
            reason: "exited 4",
            failure: { kind: "exited", exitCode: 4 },
          });
          expect(readFileSync(log, "utf8")).not.toContain("should-not-run");
          expect(
            yield* spawnCheck(dir, log, environment, {
              isolation: LOCAL_CHECK_ISOLATION,
              command: "exit 3",
              timeoutMs: 1000,
            }),
          ).toMatchObject({
            ok: false,
            reason: "exited 3",
            failure: { kind: "exited", exitCode: 3 },
          });
          removeDir(dir);
        }),
    );
    it.live("keeps setup shell syntax separate from the required command", () =>
      Effect.gen(function* () {
        const dir = tempDir();
        const log = nodePath.join(dir, "check.log");
        const environment = {
          base: { PATH: LAUNCHD_PATH },
          pathValue: LAUNCHD_PATH,
        };
        const result = yield* spawnCheck(dir, log, environment, {
          isolation: LOCAL_CHECK_ISOLATION,
          setup: "true); exit 0; (true",
          command: "echo RAN; exit 1",
          timeoutMs: 1000,
        });
        expect(result.ok).toBe(false);
        expect(readFileSync(log, "utf8")).not.toContain("RAN");
        // A setup can exit successfully, but that never returns a pass for the command.
        expect(
          yield* spawnCheck(dir, log, environment, {
            isolation: LOCAL_CHECK_ISOLATION,
            setup: "echo SETUP; exit 0",
            command: "echo RAN; exit 1",
            timeoutMs: 1000,
          }),
        ).toMatchObject({ ok: false, failure: { exitCode: 1 } });
        expect(readFileSync(log, "utf8")).toBe("SETUP\nRAN\n");
        // Shell comments in either independently valid value retain their normal meaning.
        expect(
          yield* spawnCheck(dir, log, environment, {
            isolation: LOCAL_CHECK_ISOLATION,
            setup: "echo SETUP # install dependencies",
            command: "echo RAN # run tests",
            timeoutMs: 1000,
          }),
        ).toEqual({ ok: true });
        expect(readFileSync(log, "utf8")).toBe("SETUP\nRAN\n");
        removeDir(dir);
      }),
    );
    it.live(
      "runs Gram's former sequence only when its owner explicitly configures it",
      () =>
        Effect.gen(function* () {
          const dir = tempDir();
          const bin = nodePath.join(dir, "bin");
          mkdirSync(bin);
          const bun = nodePath.join(bin, "bun");
          write(
            bun,
            '#!/bin/sh\nif [ "$1" = "--version" ]; then echo invented-pin; exit 0; fi\necho "bun $*"\n',
          );
          write(nodePath.join(dir, ".bun-version"), "invented-pin\n");
          chmodSync(bun, 0o755);
          const log = nodePath.join(dir, "check.log");
          expect(
            yield* spawnCheck(
              dir,
              log,
              {
                base: { PATH: LAUNCHD_PATH },
                pathValue: `${bin}:${LAUNCHD_PATH}`,
              },
              {
                isolation: LOCAL_CHECK_ISOLATION,
                command: "bun install --frozen-lockfile && bun run check:ci",
                setup: 'test "$(bun --version)" = "$(cat .bun-version)"',
                timeoutMs: 5_400_000,
              },
            ),
          ).toEqual({ ok: true });
          expect(readFileSync(log, "utf8")).toBe(
            "bun install --frozen-lockfile\nbun run check:ci\n",
          );
          removeDir(dir);
        }),
    );
    it.live(
      "shares one timeout across separate setup and command processes",
      () =>
        Effect.gen(function* () {
          const dir = tempDir();
          const result = yield* spawnCheck(
            dir,
            nodePath.join(dir, "check.log"),
            {
              base: { PATH: LAUNCHD_PATH },
              pathValue: LAUNCHD_PATH,
            },
            {
              isolation: LOCAL_CHECK_ISOLATION,
              setup: "sleep 0.2",
              command: "sleep 0.2; touch finished",
              timeoutMs: 300,
            },
          );
          expect(result).toMatchObject({
            ok: false,
            reason: "timed out: still running after 300 ms, so Gram stopped it",
          });
          expect(existsSync(nodePath.join(dir, "finished"))).toBe(false);
          removeDir(dir);
        }),
    );
    it.live("enforces the configured timeout", () =>
      Effect.gen(function* () {
        const dir = tempDir();
        expect(
          yield* spawnCheck(
            dir,
            nodePath.join(dir, "check.log"),
            { base: { PATH: LAUNCHD_PATH }, pathValue: LAUNCHD_PATH },
            {
              isolation: LOCAL_CHECK_ISOLATION,
              command: "sleep 5",
              timeoutMs: 20,
            },
          ),
        ).toEqual({
          ok: false,
          reason: "timed out: still running after 20 ms, so Gram stopped it",
          failure: { kind: "timed-out" },
        });
        removeDir(dir);
      }),
    );
  },
);

describe("why a local check failed", () => {
  it("names the command a shell or env couldn't find", () => {
    expect(missingCommand("/bin/sh: line 1: tsc: command not found")).toBe(
      "tsc",
    );
    expect(missingCommand("sh: tsc: command not found")).toBe("tsc");
    expect(missingCommand("/bin/sh: 1: node: not found")).toBe("node");
    expect(missingCommand("zsh: command not found: cargo")).toBe("cargo");
    expect(missingCommand("env: node: No such file or directory")).toBe("node");
    expect(
      missingCommand("/usr/bin/env: ‘python3’: No such file or directory"),
    ).toBe("python3");
    // The last one named is the one that stopped it.
    expect(
      missingCommand(
        "sh: a: command not found\nok\nsh: b: command not found\n",
      ),
    ).toBe("b");
    expect(missingCommand("FAIL src/x.test.ts\n1 failed")).toBeUndefined();
    // A script bash runs names itself by its path.
    expect(
      missingCommand("./scripts/build.sh: line 3: tsc: command not found"),
    ).toBe("tsc");
    expect(
      missingCommand("/tmp/x/bin/bun: 2: gram-test-missing-tool: not found"),
    ).toBe("gram-test-missing-tool");
    expect(missingCommand("bun: command not found: vite")).toBe("vite");
    // Only a shell's or env's own line counts, coloured or not.
    expect(
      missingCommand("\u001b[31msh: line 1: tsc: command not found\u001b[0m"),
    ).toBe("tsc");
    expect(missingCommand("Error: command not found")).toBeUndefined();
    expect(
      missingCommand("  expected: command not found: foo"),
    ).toBeUndefined();
  });

  it("explains each kind of exit", () => {
    expect(diagnoseExit(0, null, "", "/usr/bin")).toEqual({ ok: true });
    expect(
      diagnoseExit(
        127,
        null,
        "sh: line 1: tsc: command not found\n",
        "/usr/bin:/bin",
      ),
    ).toEqual({
      ok: false,
      reason:
        "`tsc` was not found on the check's PATH (exit 127); install it or add its folder to PATH in your shell profile, then restart Gram. PATH=/usr/bin:/bin",
      failure: {
        kind: "not-found",
        command: "tsc",
        path: "/usr/bin:/bin",
        exitCode: 127,
        tail: "sh: line 1: tsc: command not found",
      },
    });
    expect(diagnoseExit(127, null, "", "/usr/bin").reason).toMatch(
      /^a command was not found/,
    );
    expect(
      diagnoseExit(
        1,
        null,
        "\u001b[31mFAIL\u001b[0m a.test.ts\n\n 2 failed\n",
        "/p",
      ),
    ).toEqual({
      ok: false,
      reason: "exited 1",
      failure: {
        kind: "exited",
        exitCode: 1,
        tail: "FAIL a.test.ts\n 2 failed",
      },
    });
    expect(diagnoseExit(null, "SIGKILL", "", "/p")).toEqual({
      ok: false,
      reason: "stopped by SIGKILL",
      failure: { kind: "stopped" },
    });
    expect(
      lastLines(
        Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"),
        3,
      ),
    ).toBe("line 37\nline 38\nline 39");
    // Progress overwritten in place, a window title and stray control characters: plain lines.
    expect(lastLines("10%\r50%\r100%\n\u001b]0;title\u0007done\u0008\n")).toBe(
      "100%\ndone",
    );
    // The check runs with the server's environment: what a test prints of it is redacted.
    const token = `ghp_${"a".repeat(36)}`;
    const leaked = diagnoseExit(
      1,
      null,
      `env dump\nGH_TOKEN=${token}\nAPI_KEY=hunter22\n`,
      "/p",
    );
    expect(JSON.stringify(leaked)).not.toContain(token);
    expect(JSON.stringify(leaked)).not.toContain("hunter22");
    expect(leaked.failure?.tail).toContain("[redacted]");
  });
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

describe.skipIf(process.platform === "win32")(
  "a local check that can't finish",
  () => {
    // `/bin/sh` is bash on macOS and dash on Debian and Ubuntu, which word the miss differently.
    const shells = ["/bin/sh", "/bin/bash", "/bin/dash"].filter((shell) =>
      existsSync(shell),
    );
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
          {
            isolation: LOCAL_CHECK_ISOLATION,
            command: "bun run check:ci",
            timeoutMs: 1500,
          },
        );
        expect(outcome).toEqual({
          ok: false,
          reason: "timed out: still running after 1500 ms, so Gram stopped it",
          failure: { kind: "timed-out", tail: "still building" },
        });
        removeDir(dir);
      }),
    );

    it.live.each([
      ["one that stops on SIGTERM", "sleep 30"],
      ["one that ignores SIGTERM", "sh -c 'trap \"\" TERM; sleep 30; :'"],
    ])(
      "stops what a passing check left running in the background, %s",
      ([, background]) =>
        Effect.gen(function* () {
          const dir = tempDir();
          const work = nodePath.join(dir, "work");
          mkdirSync(work);
          const bin = nodePath.join(dir, "bin");
          const pidFile = nodePath.join(dir, "pid");
          scriptedBun(
            bin,
            `${background} & echo $! > '${pidFile}'; sleep 0.2; exit 0`,
          );
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

    it.live(
      "waits for the processes it owns to exit before an interruption ends",
      () =>
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
                {
                  base: { HOME: dir },
                  pathValue: LAUNCHD_PATH,
                  killGraceMs: 300,
                },
                {
                  isolation: LOCAL_CHECK_ISOLATION,
                  command: `exec "${process.execPath}" "${script}" "${pidFile}"`,
                  timeoutMs: 30_000,
                },
              ).pipe(Effect.forkScoped);
              for (let n = 0; n < 200 && !existsSync(pidFile); n++)
                yield* Effect.sleep("10 millis");
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
  },
);

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
        const b = yield* store.ensureProject({
          root: nested,
          repoRoot: repo,
          name: "B",
        });
        yield* configured(repo, { command: "same-check" });
        expect(yield* checked(repo, head, base, 0, a.id)).toMatchObject({
          status: "passed",
          projectId: a.id,
        });
        expect(yield* checks.lookup(nested, head, base, b.id)).toBeUndefined();
        yield* configured(nested, { command: "same-check" });
        const currentB = (yield* store.listProjects).find(
          (p) => p.id === b.id,
        )!;
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
            reason: expect.stringContaining(
              "no local check configured for other-language",
            ),
          });
          expect(yield* checked(repo, head, base)).toBeUndefined();
          expect(runs).toBe(0);
          // The owner explicitly applies Gram's former command; there is no product seed/detection.
          const command = "bun install --frozen-lockfile && bun run check:ci";
          yield* configured(repo, { command });
          expect(yield* checked(repo, head, base)).toMatchObject({
            status: "passed",
            command,
          });
          yield* configured(repo, { command, setup: "echo setup" });
          expect(yield* checks.lookup(repo, head, base)).toBeUndefined();
          expect(
            checks.latest(repo, head, base, (yield* store.listProjects)[0]),
          ).toBeUndefined();
          yield* checked(repo, head, base);
          yield* configured(repo, { command: "another-check" });
          expect(yield* checks.lookup(repo, head, base)).toBeUndefined();
          expect(
            checks.latest(repo, head, base, (yield* store.listProjects)[0]),
          ).toBeUndefined();
          yield* checked(repo, head, base);
          yield* configured(repo, {
            command: "another-check",
            timeoutMs: 5000,
          });
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
    const configuredRun = localCheckRunFor(
      { command: "make test" },
      "project-1" as never,
    )!;
    const id = runIdOf(configuredRun);
    const preparation = {
      manifest: "/tmp/selection.json",
      sha256: "a".repeat(64),
    };
    const selected = localCheckRunFor(
      { command: "make test", preparation },
      "project-1" as never,
    )!;
    expect(runIdOf(selected)).not.toBe(id);
    expect(
      runIdOf({
        ...selected,
        preparation: { ...preparation, sha256: "b".repeat(64) },
      }),
    ).not.toBe(runIdOf(selected));
    expect(
      runIdOf({
        ...selected,
        preparation: { ...preparation, inputConfigSha256: "c".repeat(64) },
      }),
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

describe.skipIf(!hasGit || process.platform === "win32")(
  "a local check across a quit",
  () => {
    it.live(
      "runs a check whose process a quit cut off again once, saying so",
      () =>
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
            expect(outcome).toMatchObject({
              status: "passed",
              afterQuit: "restarted",
            });
            expect(outcome).not.toHaveProperty("reason");
            expect(outcome).not.toHaveProperty("job");
            // Once before the quit, once after it, and no more.
            expect(starts).toBe(2);
          } finally {
            removeDir(dir);
          }
        }),
    );

    it.live(
      "fails a check a quit cut off a second time, rather than run it a third",
      () =>
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
            yield* quitWhile(
              database,
              dir,
              repo,
              head,
              base,
              never,
              () => starts > 0,
            );
            // Restarted on the next start, and cut off again by the next quit.
            yield* Effect.scoped(
              Effect.gen(function* () {
                const context = yield* Layer.build(layer(database, dir, never));
                yield* Effect.gen(function* () {
                  const checks = yield* LocalChecks;
                  for (let n = 0; n < 500 && !restarted(); n++)
                    yield* Effect.sleep("10 millis");
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
              reason: expect.stringContaining(
                "again after running it once more",
              ),
            });
            expect(starts).toBe(2);
          } finally {
            removeDir(dir);
          }
        }),
    );

    it.live(
      "keeps a check running past a quit, and takes it back after the restart",
      () =>
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
            }).pipe(
              Effect.provide(
                layer(database, dir, durableRunner(dir, "exit 1", starts)),
              ),
            );
            expect(outcome).toMatchObject({
              status: "passed",
              afterQuit: "kept",
            });
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
          for (let n = 0; n < 500 && alive(job!.pid!); n++)
            yield* Effect.sleep("10 millis");
          const outcome = yield* checked(repo, head, base).pipe(
            Effect.provide(
              layer(database, dir, durableRunner(dir, "exit 0", starts)),
            ),
          );
          expect(outcome).toMatchObject({
            status: "failed",
            afterQuit: "kept",
            reason: "exited 3",
            failure: { kind: "exited", exitCode: 3, tail: "failing" },
          });
          expect(starts.count).toBe(1);
          expect(existsSync(job!.work!)).toBe(false);
        } finally {
          stopOwnGroup(job?.pid);
          removeDir(dir);
        }
      }),
    );

    it.live(
      "passes a check that ended while Gram was closed, and stops what it left behind",
      () =>
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
            for (
              let n = 0;
              n < 500 && readExitStatusOf(job!.status!) === undefined;
              n++
            )
              yield* Effect.sleep("10 millis");
            const outcome = yield* checked(repo, head, base).pipe(
              Effect.provide(
                layer(database, dir, durableRunner(dir, "exit 1", starts)),
              ),
            );
            // Its status, not its deadline 90 minutes on, ends it.
            expect(outcome).toMatchObject({
              status: "passed",
              afterQuit: "kept",
            });
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
              Effect.provide(
                layer(database, dir, durableRunner(dir, "exit 0", starts)),
              ),
            );
            expect(outcome).toMatchObject({
              status: "failed",
              failure: { kind: "timed-out" },
            });
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
            Effect.provide(
              layer(database, dir, durableRunner(dir, "exit 0", starts)),
            ),
          );
          expect(outcome).toMatchObject({
            status: "failed",
            failure: { kind: "timed-out" },
          });
          expect(alive(job!.pid!)).toBe(false);
          expect(existsSync(job!.work!)).toBe(false);
          expect(starts.count).toBe(1);
        } finally {
          stopOwnGroup(job?.pid);
          removeDir(dir);
        }
      }),
    );
  },
);

describe("local check retention", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = 100 * DAY;
  const record = (status: LocalCheck["status"], age: number): LocalCheck => ({
    head: "a".repeat(40),
    base: "b".repeat(40),
    tree: "c".repeat(40),
    status,
    command: "invented-check",
    isolation: LOCAL_CHECK_ISOLATION,
    startedAt: now - age,
    ...(status === "running" ? {} : { finishedAt: now - age }),
    host: "invented",
  });

  it("keeps running checks, passes for a month and anything else for a week", () => {
    expect(keptCheck(record("running", 365 * DAY), now)).toBe(true);
    expect(keptCheck(record("passed", PASS_KEEP_MS - 1), now)).toBe(true);
    expect(keptCheck(record("passed", PASS_KEEP_MS + 1), now)).toBe(false);
    expect(keptCheck(record("failed", OTHER_KEEP_MS - 1), now)).toBe(true);
    expect(keptCheck(record("failed", OTHER_KEEP_MS + 1), now)).toBe(false);
  });

  it("deletes the oldest finished checks' logs until the rest fit, never a running one's", () => {
    const logs = [
      { key: "running", check: record("running", 9 * DAY), size: 50 },
      { key: "newest", check: record("passed", 1 * DAY), size: 30 },
      { key: "oldest", check: record("failed", 3 * DAY), size: 30 },
      { key: "middle", check: record("passed", 2 * DAY), size: 30 },
    ];
    expect(logsOverBudget(logs, 1000)).toEqual([]);
    expect(logsOverBudget(logs, 100)).toEqual(["oldest", "middle"]);
    // However small the budget, a running check keeps its log.
    expect(logsOverBudget(logs, 0)).toEqual(["oldest", "middle", "newest"]);
  });
});

/** A runner whose every check passes. */
const pass: LocalCheckRunnerShape["run"] = () => Effect.succeed({ ok: true });

describe.skipIf(!hasGit || process.platform === "win32")(
  "a retention sweep",
  () => {
    it.live(
      "forgets old checks and their logs, reclaims abandoned work folders it made and keeps a pass's commits",
      () =>
        Effect.gen(function* () {
          const { dir, repo, head, base } = fixture();
          const database = nodePath.join(dir, "gram.db");
          const checksDir = nodePath.join(dir, "local-checks");
          const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
          try {
            const passed = yield* checked(repo, head, base).pipe(
              Effect.provide(layer(database, dir, pass)),
            );
            expect(passed).toMatchObject({ status: "passed" });
            write(passed!.log!, "kept\n");
            // Older checks of other heads, past what retention keeps.
            const stale = (status: string, age: number, name: string) => ({
              head: name.repeat(40),
              base,
              tree: "e".repeat(40),
              status,
              command: "invented-check",
              isolation: LOCAL_CHECK_ISOLATION,
              startedAt: Date.now() - age,
              finishedAt: Date.now() - age,
              host: "invented",
              log: nodePath.join(checksDir, `${name}.log`),
            });
            const oldFailure = stale("failed", 10 * 24 * 60 * 60 * 1000, "1");
            const oldPass = stale("passed", 40 * 24 * 60 * 60 * 1000, "2");
            yield* Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              for (const [key, data] of [
                ["stale-failure", oldFailure],
                ["stale-pass", oldPass],
              ] as const)
                yield* sql`INSERT INTO local_checks (key, data) VALUES (${key}, ${JSON.stringify(data)})`;
            }).pipe(
              Effect.provide(
                ThreadStore.layerSqlite(database).pipe(Layer.orDie),
              ),
            );
            for (const path of [oldFailure.log, oldPass.log]) {
              write(path, "old\n");
              utimesSync(path, old, old);
            }
            const orphanOld = nodePath.join(checksDir, "orphan-old.log");
            const orphanNew = nodePath.join(checksDir, "orphan-new.log");
            write(orphanOld, "old\n");
            utimesSync(orphanOld, old, old);
            write(orphanNew, "new\n");

            // Work folders: one never checked out, one a crash left checked out, one kept because
            // its processes weren't shown gone, and one Gram didn't make.
            const work = nodePath.join(checksDir, "work");
            const [own] = readdirSync(nodePath.join(checksDir, "repos")).map(
              (name) => nodePath.join(checksDir, "repos", name),
            );
            const empty = nodePath.join(work, "aaaaaaaaaaaa-AbCdEf");
            mkdirSync(nodePath.join(empty, "src"), { recursive: true });
            const crashed = nodePath.join(work, "cccccccccccc-Zz9Zz9");
            mkdirSync(crashed, { recursive: true });
            run(
              own!,
              "worktree",
              "add",
              "-q",
              "--detach",
              nodePath.join(crashed, "src"),
              passed!.mergedCommit!,
            );
            const retained = nodePath.join(work, "bbbbbbbbbbbb-Retain");
            mkdirSync(nodePath.join(retained, "src"), { recursive: true });
            write(nodePath.join(retained, "retained"), "");
            const foreign = nodePath.join(work, "notours");
            mkdirSync(foreign, { recursive: true });
            for (const folder of [empty, crashed, retained, foreign])
              utimesSync(folder, old, old);
            // A repository of Gram's own that has kept nothing for longer than a pass is kept.
            const unused = nodePath.join(
              checksDir,
              "repos",
              "0123456789abcdef.git",
            );
            run(dir, "init", "-q", "--bare", unused);
            const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
            utimesSync(nodePath.join(unused, "HEAD"), longAgo, longAgo);

            const report = yield* Effect.gen(function* () {
              const checks = yield* LocalChecks;
              const swept = yield* checks.sweep;
              // The current pass is still found, its commits kept by a ref.
              expect(yield* checks.lookup(repo, head, base)).toMatchObject({
                status: "passed",
              });
              return swept;
            }).pipe(Effect.provide(layer(database, dir, pass)));
            expect(report).toMatchObject({
              records: 2,
              logs: 3,
              work: 2,
              collected: 1,
              repos: 1,
            });
            expect(existsSync(unused)).toBe(false);
            expect(existsSync(own!)).toBe(true);
            expect(
              [oldFailure.log, oldPass.log, orphanOld].filter(existsSync),
            ).toEqual([]);
            expect([passed!.log!, orphanNew].every(existsSync)).toBe(true);
            expect([empty, crashed].filter(existsSync)).toEqual([]);
            expect([retained, foreign].every(existsSync)).toBe(true);
            expect(run(own!, "worktree", "list")).not.toContain("cccccccccccc");
            expect(
              run(
                own!,
                "for-each-ref",
                "--format=%(objectname)",
                "refs/gram/keep/",
              ).trim(),
            ).toBe(passed!.mergedCommit);
            // After a restart, the pass is still there to reuse, and the old ones aren't.
            yield* Effect.gen(function* () {
              const checks = yield* LocalChecks;
              expect(yield* checks.lookup(repo, head, base)).toMatchObject({
                status: "passed",
              });
              expect(yield* checked(repo, head, base)).toMatchObject({
                status: "passed",
              });
              // Collected already today, and nothing else to remove.
              expect(yield* checks.sweep).toMatchObject({
                records: 0,
                logs: 0,
                work: 0,
                collected: 0,
              });
            }).pipe(Effect.provide(layer(database, dir, pass)));
          } finally {
            removeDir(dir);
          }
        }),
    );
  },
);

/** Settings with only a local-check cap, or none. */
const withCap = (localCheckConcurrency?: number) =>
  ({
    workspaces:
      localCheckConcurrency === undefined ? {} : { localCheckConcurrency },
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
  it.live(
    "waits its turn, reading as queued, and runs once the one before it ends",
    () =>
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
        const runner: LocalCheckRunnerShape["run"] = (
          _work,
          _log,
          _run,
          source,
        ) =>
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
          }).pipe(
            Effect.provide(layer(nodePath.join(dir, "gram.db"), dir, runner)),
          );
        } finally {
          removeDir(dir);
        }
      }),
  );
});
