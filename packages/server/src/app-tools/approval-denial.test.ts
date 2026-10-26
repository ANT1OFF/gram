import { describe, expect, it } from "@effect/vitest";
import { ApprovalAnswer, AppToolError, ThreadNotFound } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ThreadStore } from "../persistence/thread-store.ts";
import { RuntimeTestLayer } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { bindAppTools, defineAppTool, makeApprovalGate } from "./registry.ts";
import { callAppTool } from "./http-mcp.ts";

const denial = { kind: "approval", decision: "deny", scope: "once" } as const;

describe("fail-closed approval routing", () => {
  for (const route of ["unattributed", "unavailable", "runtime-denial"] as const) {
    it.effect(`keeps ${route} refusal truthful without executing or asking a user`, () =>
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
        const thread = yield* runtimes.create({
          projectRoot: "/invented/repo",
          checkout: { kind: "main", path: "/invented/repo" },
          model: { agent: "codex", model: "gpt-6.1-sol" },
        });
        let executed = false;
        const gate = makeApprovalGate(
          {
            ...runtimes,
            requestApproval: () =>
              route === "unavailable"
                ? Effect.fail(new ThreadNotFound({ threadId: thread.id }))
                : Effect.succeed({
                    ...denial,
                    ...(route === "runtime-denial"
                      ? {
                          resolution: {
                            origin: "runtime" as const,
                            reason: "approval-route-denied",
                            threadId: thread.id,
                            resolvedAt: 1,
                          },
                        }
                      : {}),
                  }),
          },
          store,
        );
        const [tool] = bindAppTools(
          [
            defineAppTool({
              descriptor: {
                name: "merge_when_ready",
                class: "outward",
                description: "Invented action",
              },
              input: Schema.Struct({ pr: Schema.optionalKey(Schema.Number) }),
              handle: () =>
                Effect.sync(() => {
                  executed = true;
                }),
            }),
          ],
          thread.id,
          gate,
        );
        const result = yield* callAppTool(tool!, { pr: 101 });
        expect(result).toMatchObject({
          isError: true,
          structuredContent: {
            tool: "merge_when_ready",
            executionStarted: false,
            approvalResolution: {
              origin: route === "unattributed" ? "unknown" : "runtime",
              reason:
                route === "unattributed"
                  ? "approval-denied"
                  : route === "unavailable"
                    ? "approval-unavailable"
                    : "approval-route-denied",
            },
          },
        });
        expect(JSON.stringify(result.content)).not.toContain("The user declined");
        expect(executed).toBe(false);
        expect(yield* store.listRequests(thread.id)).toEqual([]);
      }).pipe(Effect.provide(RuntimeTestLayer)),
    );
  }

  it("decodes errors without a resolution and strips untrusted provenance from client/native answers", () => {
    const answer = Schema.decodeUnknownSync(ApprovalAnswer)({
      ...denial,
      resolution: { origin: "user", reason: "rejected", threadId: "invented", resolvedAt: 1 },
    });
    expect(answer).toEqual(denial);
    const plainError = Schema.decodeUnknownSync(AppToolError)({
      _tag: "AppToolError",
      tool: "merge_when_ready",
      message: "a refusal",
      approvalRequired: true,
    });
    expect(plainError.approvalResolution).toBeUndefined();
  });
});
