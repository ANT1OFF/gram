import { describe, expect, it } from "@effect/vitest";
import { RequestId, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { removeDir, tempDir } from "../git/test-repo.ts";
import { worktreeHookConsent } from "./worktree-hook-consent.ts";
import type { ThreadRuntimesShape } from "./thread-runtimes-shape.ts";

const thread = { id: ThreadId.make("fixture-thread"), startedBy: "fixture-person" };
const answerFor = (decision: "allow" | "deny", answeredBy = thread.startedBy) => ({
  kind: "approval" as const,
  scope: "once" as const,
  decision,
  answeredBy,
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
  return {
    dataDir: dir,
    thread,
    host: "fixture-host",
    machine: "Fixture machine",
    repository: "fixture-repo",
    kind: "setup" as const,
    path: ".gram/setup",
    fingerprint: "original-fingerprint",
    script: "#!/bin/sh\nexit 0\n",
  };
});

describe("worktree hook consent", () => {
  it.effect(
    "shares one decision for a fingerprint and asks again when the committed hook changes",
    () =>
      Effect.gen(function* () {
        const inputs = yield* fixture;
        let asked = 0;
        const ask: ThreadRuntimesShape["requestApproval"] = (_id, card) =>
          Effect.sync(() => {
            expect(card.scopes).toEqual(["once"]);
            expect(card.input).toMatchObject({ machine: inputs.machine, path: inputs.path });
            asked++;
            return answerFor(asked === 1 ? "allow" : "deny");
          });
        const first = worktreeHookConsent({ ...inputs, ask });
        expect(yield* Effect.all([first, first], { concurrency: "unbounded" })).toEqual([
          "allow",
          "allow",
        ]);
        expect(asked).toBe(1);
        const changed = worktreeHookConsent({ ...inputs, fingerprint: "changed-fingerprint", ask });
        expect(yield* changed).toBe("deny");
        expect(yield* changed).toBe("deny");
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
      ).toBe("unavailable");
      expect(
        yield* worktreeHookConsent({
          ...inputs,
          ask: () => Effect.succeed(answerFor("deny")),
        }),
      ).toBe("deny");
    }),
  );
});
