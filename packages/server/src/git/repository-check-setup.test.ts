import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { PathProbe, ProcLive } from "@gram/git";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ThreadStore } from "../persistence/thread-store.ts";
import { makeRespondHandlers } from "../rpc/handlers/respond.ts";
import { makeRuntimeTestLayer, TEST_CONFIG } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { configured, fixture } from "./local-checks-fixture.ts";
import { LocalCheckRunner, LocalChecks, LocalChecksLive, type LocalCheck } from "./local-checks.ts";
import { eventually, removeDir, run, write } from "./test-repo.ts";

describe.skipIf(process.platform === "win32")("repository setup for the local merge check", () => {
  it.live("runs the approved setup from the qualified merge before the check command", () =>
    Effect.gen(function* () {
      const { dir, repo, base } = fixture();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      run(repo, "checkout", "-q", "feature");
      const file = join(repo, ".gram", "setup");
      const script =
        "#!/bin/sh\ntest -f base.txt && test -f feature.txt || exit 15\nprintf ready > setup-proof\necho prepared\n";
      write(file, script);
      chmodSync(file, 0o755);
      run(repo, "add", ".gram/setup");
      run(repo, "commit", "-qm", "repository setup");
      const head = run(repo, "rev-parse", "HEAD").trim();
      write(file, "#!/bin/sh\nexit 99\n");
      const settings = { ...TEST_CONFIG, dataDir: dir };
      const runtime = makeRuntimeTestLayer(undefined, undefined, settings);
      const layer = LocalChecksLive.pipe(
        Layer.provideMerge(LocalCheckRunner.layer),
        Layer.provideMerge(ProcLive),
        Layer.provideMerge(Layer.succeed(PathProbe, { path: Effect.succeed("/usr/bin:/bin") })),
        Layer.provideMerge(runtime),
      );
      yield* Effect.gen(function* () {
        const store = yield* ThreadStore;
        const rt = yield* ThreadRuntimes;
        const checks = yield* LocalChecks;
        const thread = yield* rt.create({
          projectRoot: repo,
          checkout: { kind: "main", path: repo },
          deferOpen: true,
          mode: "default",
          model: { agent: "codex", model: "gpt-6.1-sol" },
        });
        yield* configured(repo, {
          command: 'test "$(cat setup-proof)" = ready && echo checked',
          setup: { source: "repository" },
        });
        const done = yield* Deferred.make<LocalCheck>();
        expect(
          yield* checks.ensure(repo, head, base, {
            projectId: thread.projectId,
            approvalThread: thread.id,
            since: 0,
            onDone: (check) => Deferred.succeed(done, check).pipe(Effect.asVoid),
          }),
        ).toMatchObject({ status: "running", repositorySetup: true });
        const card = yield* eventually(
          "repository setup approval",
          store.listRequests(thread.id).pipe(Effect.map((cards) => cards[0])),
        );
        if (card.kind !== "approval" || card.shown === undefined)
          throw new Error("Missing hook approval");
        expect(card.input["command"]).toBe(script);
        expect(yield* Deferred.isDone(done)).toBe(false);
        yield* makeRespondHandlers(store, rt)["thread.respond"]({
          threadId: thread.id,
          requestId: card.id,
          shown: card.shown,
          answer: { kind: "approval", decision: "allow", scope: "once" },
        });
        const result = yield* Deferred.await(done);
        expect(result).toMatchObject({
          status: "passed",
          head,
          base,
          setupFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        expect(readFileSync(result.log!, "utf8")).toBe(
          "Worktree setup .gram/setup\nprepared\nchecked\n",
        );
        expect(yield* checks.lookup(repo, head, base, thread.projectId)).toMatchObject({
          status: "passed",
        });
      }).pipe(Effect.provide(layer));
    }),
  );
});
