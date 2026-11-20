import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { existsSync, mkdirSync, readdirSync, utimesSync } from "node:fs";
import * as nodePath from "node:path";

import { ThreadStore } from "../persistence/thread-store.ts";
import { SqlClient } from "../platform/unstable.ts";
import { evidenceDirOf } from "./check-evidence.ts";
import { checked, fixture, layer } from "./local-checks-fixture.ts";
import { LocalChecks, LOCAL_CHECK_ISOLATION, type LocalCheckRunnerShape } from "./local-checks.ts";
import { hasGit, removeDir, run, write } from "./test-repo.ts";

/** A runner whose every check passes. */
const pass: LocalCheckRunnerShape["run"] = () => Effect.succeed({ ok: true });

describe.skipIf(!hasGit || process.platform === "win32")("a retention sweep", () => {
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
          }).pipe(Effect.provide(ThreadStore.layerSqlite(database).pipe(Layer.orDie)));
          for (const path of [oldFailure.log, oldPass.log]) {
            write(path, "old\n");
            utimesSync(path, old, old);
          }
          const orphanOld = nodePath.join(checksDir, "orphan-old.log");
          const orphanNew = nodePath.join(checksDir, "orphan-new.log");
          write(orphanOld, "old\n");
          utimesSync(orphanOld, old, old);
          write(orphanNew, "new\n");
          // Evidence goes with its log, kept or not, and a folder whose log is gone goes too.
          const evidence = (log: string) => {
            write(nodePath.join(evidenceDirOf(log), "shot.png"), "png");
            utimesSync(evidenceDirOf(log), old, old);
            return evidenceDirOf(log);
          };
          const goneEvidence = [oldFailure.log, orphanOld].map(evidence);
          const keptEvidence = [passed!.log!, orphanNew].map(evidence);
          goneEvidence.push(evidence(nodePath.join(checksDir, "no-log.log")));

          // Work folders: one never checked out, one a crash left checked out, one kept because
          // its processes weren't shown gone, and one Gram didn't make.
          const work = nodePath.join(checksDir, "work");
          const [own] = readdirSync(nodePath.join(checksDir, "repos")).map((name) =>
            nodePath.join(checksDir, "repos", name),
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
          for (const folder of [empty, crashed, retained, foreign]) utimesSync(folder, old, old);
          // A repository of Gram's own that has kept nothing for longer than a pass is kept.
          const unused = nodePath.join(checksDir, "repos", "0123456789abcdef.git");
          run(dir, "init", "-q", "--bare", unused);
          const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
          utimesSync(nodePath.join(unused, "HEAD"), longAgo, longAgo);

          const report = yield* Effect.gen(function* () {
            const checks = yield* LocalChecks;
            const swept = yield* checks.sweep;
            // The current pass is still found, its commits kept by a ref.
            expect(yield* checks.lookup(repo, head, base)).toMatchObject({ status: "passed" });
            return swept;
          }).pipe(Effect.provide(layer(database, dir, pass)));
          expect(report).toMatchObject({ records: 2, logs: 3, work: 2, collected: 1, repos: 1 });
          expect(existsSync(unused)).toBe(false);
          expect(existsSync(own!)).toBe(true);
          expect([oldFailure.log, oldPass.log, orphanOld].filter(existsSync)).toEqual([]);
          expect([passed!.log!, orphanNew].every(existsSync)).toBe(true);
          expect(goneEvidence.filter(existsSync)).toEqual([]);
          expect(keptEvidence.every(existsSync)).toBe(true);
          expect([empty, crashed].filter(existsSync)).toEqual([]);
          expect([retained, foreign].every(existsSync)).toBe(true);
          expect(run(own!, "worktree", "list")).not.toContain("cccccccccccc");
          expect(
            run(own!, "for-each-ref", "--format=%(objectname)", "refs/gram/keep/").trim(),
          ).toBe(passed!.mergedCommit);
          // After a restart, the pass is still there to reuse, and the old ones aren't.
          yield* Effect.gen(function* () {
            const checks = yield* LocalChecks;
            expect(yield* checks.lookup(repo, head, base)).toMatchObject({ status: "passed" });
            expect(yield* checked(repo, head, base)).toMatchObject({ status: "passed" });
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
});
