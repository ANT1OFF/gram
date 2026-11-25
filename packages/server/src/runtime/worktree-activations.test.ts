import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { RequestId } from "@gram/contracts";
import { ProcLive } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { eventually, makeRepo, removeDir, run, tempDir, write } from "../git/test-repo.ts";
import { markNewWorktree, worktreeHookFingerprint } from "../host/worktree-hook-source.ts";
import { localAppHeadersForTests } from "../http/local-app.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { makeRespondHandlers } from "../rpc/handlers/respond.ts";
import { FakeAgentControl } from "./fake-agent.ts";
import { makeRuntimeTestLayer, TEST_CONFIG } from "./test-harness.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";
import { makeWorktreeActivations } from "./worktree-activations.ts";

describe.skipIf(process.platform === "win32")("worktree hook activation", () => {
  it.live("sends setup failure in the first brief and runs resume again before a warm wake", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      const repo = makeRepo(dir);
      for (const [kind, script] of [
        [
          "setup",
          "printf s >> attempts\necho 'sh: fixture-setup-failed: command not found' >&2\nexit 127",
        ],
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
        const localApp = { headers: localAppHeadersForTests() };
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
          if (phase === "setup") {
            const duplicate = yield* runtimes.startSession(worker.id).pipe(Effect.flip);
            expect(duplicate._tag).toBe("InvalidState");
          }
          if (before.shown === undefined) throw new Error("Expected a keyed approval");
          yield* ui["thread.respond"](
            {
              threadId: worker.id,
              requestId: before.id,
              shown: before.shown,
              answer: { kind: "approval", decision: "allow", scope: "once" },
            },
            localApp,
          );
        }
        const session = yield* eventually(
          "first worker input",
          Effect.sync(() => agent.sessions.find((candidate) => candidate.sent.length > 0)),
        );
        expect(session.sent[0]?.text).toContain(
          "A required tool is unavailable on the hook's machine.",
        );
        expect(session.sent[0]?.text).toContain("Fixture brief");
        expect(session.sent[0]?.text).not.toContain("fixture-setup-failed");
        const setup = (yield* store.getThread(worker.id)).worktreeHooks?.find(
          (each) => each.kind === "setup",
        );
        expect(setup?.result).toMatchObject({
          status: "failed",
          failure: "missing-tool",
          exitCode: 127,
          reason: expect.stringContaining("fixture-setup-failed"),
          log: "sh: fixture-setup-failed: command not found\n",
        });
        expect(readFileSync(join(checkout, "attempts"), "utf8")).toBe("sr");
        yield* runtimes.steer(worker.id, { text: "Fixture steer" });
        expect(session.steered).toEqual([{ text: "Fixture steer" }]);
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
        yield* eventually(
          "restarted worker idle",
          runtimes.status(worker.id).pipe(Effect.map((status) => status === "idle")),
        );
        const resumed = agent.sessions[1]!;
        write(join(checkout, ".gram", "resume"), "#!/bin/sh\nprintf x >> attempts\n");
        run(checkout, "add", ".gram/resume");
        run(checkout, "commit", "-qm", "new resume");
        yield* runtimes.sendNotice(worker.id, "wake:changed-hook", {
          text: "Wake after hook change",
        });
        const changed = yield* eventually(
          "changed resume approval",
          store.listRequests(worker.id).pipe(Effect.map((cards) => cards[0])),
        );
        if (changed.shown === undefined) throw new Error("Missing changed-hook card key");
        yield* ui["thread.respond"](
          {
            threadId: worker.id,
            requestId: changed.id,
            shown: changed.shown,
            answer: { kind: "approval", decision: "deny", scope: "once" },
          },
          localApp,
        );
        yield* eventually(
          "wake after decline",
          Effect.sync(() => resumed.sent.length > 0),
        );
        expect(resumed.sent[0]?.text).toContain("The user declined this hook revision.");
        expect(resumed.sent[0]?.text).not.toContain(".gram/setup");
        const resume = (yield* store.getThread(worker.id)).worktreeHooks?.find(
          (each) => each.kind === "resume",
        );
        expect(resume?.result).toMatchObject({ status: "skipped" });
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

  it.effect(
    "interrupts setup when its start cannot be recorded or an earlier start was interrupted",
    () =>
      Effect.gen(function* () {
        const dataDir = tempDir();
        yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dataDir)));
        yield* Effect.gen(function* () {
          const runtimes = yield* ThreadRuntimes;
          const store = yield* ThreadStore;
          const revision = "a".repeat(40);
          const path = ".gram/setup";
          const script = "#!/bin/sh\nexit 0\n";
          let failWrite = true;
          let ran = 0;
          const activations = makeWorktreeActivations({
            dataDir,
            store: {
              ...store,
              updateThread: (...args) =>
                Effect.suspend(() => {
                  if (!failWrite) return store.updateThread(...args);
                  failWrite = false;
                  return Effect.die("fixture storage failure");
                }),
            },
            local: {
              inspect: () =>
                Effect.succeed({
                  status: "found",
                  path,
                  revision,
                  script,
                  fingerprint: worktreeHookFingerprint(path, script),
                }),
              run: () =>
                Effect.sync(() => {
                  ran++;
                  return { status: "passed", durationMs: 0, log: "" };
                }),
            },
            publish: () => Effect.void,
            ask: (threadId) =>
              Effect.succeed({
                kind: "approval",
                decision: "allow",
                scope: "once",
                uiVerified: true,
                resolution: {
                  threadId,
                  requestId: RequestId.make("fixture-approval"),
                  origin: "user",
                  reason: "approved",
                  resolvedAt: 0,
                },
              }),
          });
          const checkout = {
            kind: "worktree" as const,
            path: join(dataDir, "worker"),
            worktreeSetup: { generation: "fixture-generation", revision },
          };
          const thread = yield* runtimes.create({
            projectRoot: dataDir,
            checkout,
            mode: "default",
            model: { agent: "codex", model: "gpt-6.1-sol" },
            deferOpen: true,
          });
          yield* store.setProjectFolderTrust(thread.projectId, true);
          const [first] = yield* activations.setup(thread);
          expect(first?.result).toMatchObject({ status: "failed", failure: "interrupted" });
          expect(ran).toBe(0);
          const afterFailure = yield* store.getThread(thread.id);
          expect(afterFailure.worktreeHooks).toEqual([first]);
          yield* activations.setup(afterFailure);
          expect(ran).toBe(0);

          const interrupted = yield* store.updateThread(thread.id, (current) => ({
            ...current,
            worktreeHooks: [
              {
                checkout: checkout.path,
                kind: "setup",
                generation: checkout.worktreeSetup.generation,
                path,
                result: { status: "running" },
              },
            ],
          }));
          const [recovered] = yield* activations.setup(interrupted);
          expect(recovered?.result).toMatchObject({ status: "failed", failure: "interrupted" });
          expect((yield* store.getThread(thread.id)).worktreeHooks).toEqual([recovered]);
          expect(ran).toBe(0);
        }).pipe(
          Effect.provide(makeRuntimeTestLayer(undefined, undefined, { ...TEST_CONFIG, dataDir })),
        );
      }),
  );
});
