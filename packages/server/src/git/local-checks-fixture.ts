// The repository, project and layer Gram's local-check tests share.

import { type ProjectId, type ProjectLocalCheck, type ThreadId } from "@gram/contracts";
import { type Proc, ProcLive } from "@gram/git";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { execFileSync } from "node:child_process";
import * as nodePath from "node:path";
import { expect } from "@effect/vitest";

import { ServerConfig } from "../config.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { TEST_CONFIG } from "../runtime/test-harness.ts";
import {
  LocalCheckRunner,
  LocalChecks,
  LocalChecksLive,
  type LocalCheck,
  type LocalCheckRunnerShape,
} from "./local-checks.ts";
import { makeRepo, run, tempDir, write } from "./test-repo.ts";

/** A repo with `main` one commit past where `feature` branched, each adding its own file. */
export const fixture = (protectedBlob = false) => {
  const dir = tempDir();
  const repo = makeRepo(dir);
  let protectedOid: string | undefined;
  if (protectedBlob) {
    protectedOid = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: repo,
      input: "synthetic protected fixture",
      encoding: "utf8",
    }).trim();
    run(repo, "update-index", "--add", "--cacheinfo", `100644,${protectedOid},.env.example`);
    run(repo, "commit", "-qm", "synthetic protected ancestor");
  }
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
  return { dir, repo, head, base, protectedOid };
};

export const configured = (repo: string, setting: ProjectLocalCheck) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const project = yield* store.ensureProject({ root: repo, name: "invented" });
    const writes = (["command", "setup", "timeoutMs", "preparation"] as const).map((field) => ({
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

export const layer = (
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
            configured(nodePath.join(logs, "repo"), { command: "invented-check" }),
          ).pipe(Layer.provideMerge(ThreadStore.layerSqlite(database).pipe(Layer.orDie)))
        : ThreadStore.layerSqlite(database).pipe(Layer.orDie),
    ),
  );

/** Ensures the pair and waits for how it ended. */
export const checked = (
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
