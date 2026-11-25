import { describe, expect, it } from "@effect/vitest";
import { RequestId, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { removeDir, tempDir } from "../git/test-repo.ts";
import { worktreeHookFingerprint } from "../host/worktree-hook-source.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { makeRespondHandlers } from "../rpc/handlers/respond.ts";
import { makeRuntimeTestLayer, TEST_CONFIG, waitFor } from "./test-harness.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";
import { worktreeHookConsent } from "./worktree-hook-consent.ts";
import type { ThreadRuntimesShape } from "./thread-runtimes-shape.ts";

const thread = { id: ThreadId.make("fixture-thread"), startedBy: "fixture-person" };
const answerFor = (decision: "allow" | "deny", answeredBy = thread.startedBy) => ({
  kind: "approval" as const,
  scope: "once" as const,
  decision,
  answeredBy,
  uiVerified: true as const,
  resolution: {
    threadId: thread.id,
    requestId: RequestId.make("fixture-request"),
    origin: "user" as const,
    reason: decision === "allow" ? "approved" : "rejected",
    resolvedAt: 0,
  },
});

const fixture = Effect.gen(function* () {
  const dir = tempDir();
  yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
  const script = "#!/bin/sh\nexit 0\n";
  return {
    dataDir: dir,
    thread,
    host: "fixture-host",
    machine: "Fixture machine",
    repository: "fixture-repo",
    kind: "setup" as const,
    path: ".gram/setup",
    revision: "a".repeat(40),
    fingerprint: worktreeHookFingerprint(".gram/setup", script),
    script,
  };
});

describe("worktree hook consent", () => {
  it.effect(
    "shares one decision for a fingerprint and asks again when the committed hook changes",
    () =>
      Effect.gen(function* () {
        const inputs = yield* fixture;
        const revisedScript = "#!/bin/sh\nexit 1\n";
        let asked = 0;
        const ask: ThreadRuntimesShape["requestApproval"] = (_id, card) =>
          Effect.sync(() => {
            expect(card.scopes).toEqual(["once"]);
            expect(card.input).toMatchObject({
              command: asked === 0 ? inputs.script : revisedScript,
              machine: inputs.machine,
              path: inputs.path,
            });
            asked++;
            return answerFor(asked === 1 ? "allow" : "deny");
          });
        const first = worktreeHookConsent({ ...inputs, ask });
        const grant = {
          decision: "allow",
          grant: {
            host: inputs.host,
            path: inputs.path,
            revision: inputs.revision,
            fingerprint: inputs.fingerprint,
          },
        };
        expect(yield* Effect.all([first, first], { concurrency: "unbounded" })).toEqual([
          grant,
          grant,
        ]);
        expect(asked).toBe(1);
        expect(yield* worktreeHookConsent({ ...inputs, script: revisedScript, ask })).toEqual({
          decision: "unavailable",
        });
        const changed = worktreeHookConsent({
          ...inputs,
          script: revisedScript,
          fingerprint: worktreeHookFingerprint(inputs.path, revisedScript),
          ask,
        });
        expect(yield* changed).toEqual({ decision: "deny" });
        expect(yield* changed).toEqual({ decision: "deny" });
        expect(asked).toBe(2);
      }),
  );

  it.effect("cannot remember an approval from a different principal", () =>
    Effect.gen(function* () {
      const inputs = yield* fixture;
      expect(
        yield* worktreeHookConsent({
          ...inputs,
          ask: () => Effect.succeed(answerFor("allow", "different-person")),
        }),
      ).toEqual({ decision: "unavailable" });
      expect(
        yield* worktreeHookConsent({
          ...inputs,
          ask: () => Effect.succeed(answerFor("deny")),
        }),
      ).toEqual({ decision: "deny" });
    }),
  );

  it.effect("keeps hook consent pending when an agent-side answer names the current card", () =>
    Effect.gen(function* () {
      const inputs = yield* fixture;
      yield* Effect.gen(function* () {
        const rt = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
        const personThread = yield* rt.create({
          projectRoot: "/invented",
          checkout: { kind: "main", path: "/invented" },
          model: { agent: "codex", model: "gpt-6.1-sol" },
          mode: "default",
          deferOpen: true,
        });
        const pending = yield* Effect.forkScoped(
          worktreeHookConsent({
            ...inputs,
            thread: personThread,
            ask: rt.requestApproval,
          }),
        );
        const card = yield* waitFor(
          "hook approval",
          store.listRequests(personThread.id).pipe(Effect.map((requests) => requests[0])),
        );
        if (card.shown === undefined) throw new Error("Expected a keyed worktree hook approval");
        const answer = {
          kind: "approval" as const,
          decision: "allow" as const,
          scope: "once" as const,
        };
        const blocked = yield* rt
          .respond(personThread.id, card.id, answer, card.shown)
          .pipe(Effect.flip);
        expect(blocked).toMatchObject({
          message: expect.stringContaining("from its card in the Gram app"),
        });
        expect(yield* store.listRequests(personThread.id)).toEqual([card]);
        expect(pending.pollUnsafe()).toBeUndefined();
        const ui = makeRespondHandlers(store, rt);
        const stale = yield* ui["thread.respond"]({
          threadId: personThread.id,
          requestId: card.id,
          answer,
          shown: "different-card",
        }).pipe(Effect.flip);
        expect(stale).toMatchObject({
          message: expect.stringContaining("from its card in the Gram app"),
        });
        yield* ui["thread.respond"]({
          threadId: personThread.id,
          requestId: card.id,
          answer,
          shown: card.shown,
        });
        expect(yield* Fiber.join(pending)).toMatchObject({ decision: "allow" });
      }).pipe(
        Effect.provide(
          makeRuntimeTestLayer(undefined, undefined, { ...TEST_CONFIG, dataDir: inputs.dataDir }),
        ),
      );
    }),
  );
});
