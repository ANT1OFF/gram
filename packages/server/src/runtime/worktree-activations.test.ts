import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { ProcLive } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { eventually, makeRepo, removeDir, run, tempDir, write } from "../git/test-repo.ts";
import { markNewWorktree } from "../host/worktree-hook-source.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { makeRespondHandlers } from "../rpc/handlers/respond.ts";
import { FakeAgentControl } from "./fake-agent.ts";
import { makeRuntimeTestLayer, TEST_CONFIG } from "./test-harness.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";

describe.skipIf(process.platform === "win32")("worktree hook activation", () => {
  it.live("sends setup failure in the first brief and runs resume again before a warm wake", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      const repo = makeRepo(dir);
      for (const [kind, script] of [
        ["setup", "printf s >> attempts\necho fixture-setup-failed\nexit 31"],
        ["resume", "printf r >> attempts"],
      ]) {
        const path = join(repo, ".gram", kind!);
        write(path, `#!/bin/sh\n${script}\n`);
        chmodSync(path, 0o755);
      }
      run(repo, "add", "-A");
      run(repo, "commit", "-qm", "fixture hooks");
      const checkout = join(dir, "worker");
      run(repo, "worktree", "add", "-qb", "fixture-worker", checkout);
      yield* Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
        const ui = makeRespondHandlers(store, runtimes);
        const agent = yield* FakeAgentControl;
        const model = { agent: "codex" as const, model: "gpt-6.1-sol" };
        const parent = yield* runtimes.create({
          projectRoot: repo,
          checkout: { kind: "main", path: repo },
          mode: "default",
          model,
          deferOpen: true,
        });
        const worker = yield* runtimes.create({
          projectRoot: repo,
          checkout: {
            kind: "worktree",
            path: checkout,
            repoRoot: repo,
            worktreeSetup: yield* markNewWorktree(checkout),
          },
          mode: "default",
          model,
          spawnedBy: { threadId: parent.id, feature: "fixture" },
          input: { text: "Fixture brief" },
        });
        for (const phase of ["setup", "resume"]) {
          const before = yield* eventually(
            `${phase} approval`,
            store
              .listRequests(worker.id)
              .pipe(
                Effect.map((cards) =>
                  cards.find(
                    (card) => card.kind === "approval" && card.input["path"] === `.gram/${phase}`,
                  ),
                ),
              ),
          );
          expect(agent.sessions).toHaveLength(0);
          if (before.shown === undefined) throw new Error("Expected a keyed approval");
          yield* ui["thread.respond"]({
            threadId: worker.id,
            requestId: before.id,
            shown: before.shown,
            answer: { kind: "approval", decision: "allow", scope: "once" },
          });
        }
        const session = yield* eventually(
          "first worker input",
          Effect.sync(() => agent.sessions.find((candidate) => candidate.sent.length > 0)),
        );
        expect(session.sent[0]?.text).toContain("The hook exited with status 31.");
        expect(session.sent[0]?.text).toContain("Fixture brief");
        expect(session.sent[0]?.text).not.toContain("fixture-setup-failed");
        const setup = (yield* store.getThread(worker.id)).worktreeHooks?.find(
          (each) => each.kind === "setup",
        );
        expect(setup?.result).toMatchObject({
          status: "failed",
          exitCode: 31,
          log: "fixture-setup-failed\n",
        });
        expect(readFileSync(join(checkout, "attempts"), "utf8")).toBe("sr");
        yield* session.completeTurn();
        yield* eventually(
          "idle worker",
          runtimes.status(worker.id).pipe(Effect.map((status) => status === "idle")),
        );
        yield* runtimes.sendNotice(worker.id, "wake:synthetic", { text: "Fixture wake" });
        yield* eventually(
          "warm wake delivered",
          Effect.sync(() => session.sent[1]?.text === "Fixture wake"),
        );
        expect(readFileSync(join(checkout, "attempts"), "utf8")).toBe("srr");
        expect(yield* store.listRequests(worker.id)).toHaveLength(0);
        yield* session.completeTurn();
        yield* eventually(
          "worker idle after its wake",
          runtimes.status(worker.id).pipe(Effect.map((status) => status === "idle")),
        );
        yield* runtimes.restartSession(worker.id);
        yield* eventually(
          "worker session restarted",
          Effect.sync(() => agent.sessions.length === 2),
        );
        expect(readFileSync(join(checkout, "attempts"), "utf8")).toBe("srrr");
      }).pipe(
        Effect.provide(
          makeRuntimeTestLayer(undefined, undefined, { ...TEST_CONFIG, dataDir: dir }).pipe(
            Layer.provideMerge(ProcLive),
          ),
        ),
      );
    }),
  );
});
