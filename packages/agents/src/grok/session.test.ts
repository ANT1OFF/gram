import { MessageId, ThreadId, type AgentEvent } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";

import type { AcpConnection, AcpHandlers, StartAcpAgent } from "./acp.ts";
import { autoAnswer, grokPermission, makeGrokHost, permissionParams } from "./session.ts";

const command = (text: string) => ({ kind: "execute", rawInput: { command: text } });

describe("Grok Build permissions", () => {
  it("asks under an outward gate whatever the mode, so Gram sees every command", () => {
    expect(grokPermission("bypassPermissions", "all")).toBe("ask");
    expect(grokPermission("auto", "irreversible")).toBe("ask");
    expect(grokPermission("bypassPermissions", undefined)).toBe("always-approve");
    expect(grokPermission("auto", undefined)).toBe("auto");
    for (const mode of ["default", "acceptEdits", "plan", "dontAsk"] as const)
      expect(grokPermission(mode, undefined)).toBe("ask");
  });

  it("lets through what a gated bypass session would run, except what the gate asks about", () => {
    expect(autoAnswer("bypassPermissions", "all", command("ls -la"))).toBe("allow");
    expect(autoAnswer("bypassPermissions", "all", command("git push origin main"))).toBeUndefined();
    expect(
      autoAnswer("bypassPermissions", "irreversible", command("gh pr merge 12")),
    ).toBeUndefined();
    expect(autoAnswer("auto", "all", { kind: "edit", rawInput: {} })).toBe("allow");
  });

  it("refuses in dontAsk, passes edits in acceptEdits, and shows the rest", () => {
    expect(autoAnswer("dontAsk", undefined, command("ls"))).toBe("deny");
    expect(autoAnswer("acceptEdits", undefined, { kind: "edit", rawInput: {} })).toBe("allow");
    expect(autoAnswer("acceptEdits", undefined, command("ls"))).toBeUndefined();
    expect(autoAnswer("default", undefined, command("ls"))).toBeUndefined();
  });
});

/** A stand-in Grok Build: records what Gram sends and answers like the CLI does. */
const fakeAgent = () => {
  const started: Array<StartAcpAgent> = [];
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const notes: Array<{ method: string; params: Record<string, unknown> }> = [];
  let handlers: AcpHandlers | undefined;
  const start = (input: StartAcpAgent): AcpConnection => {
    started.push(input);
    handlers = input.handlers;
    return {
      request: async <T>(method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        switch (method) {
          case "initialize":
            return {
              agentCapabilities: { sessionCapabilities: { resume: {} } },
              _meta: { modelState: { availableModels: [] } },
            } as T;
          case "session/new":
            return { sessionId: "new-session", models: { currentModelId: "grok-4.7" } } as T;
          case "session/resume":
            return { models: { currentModelId: "grok-4.7" } } as T;
          case "session/prompt": {
            const answer = (await handlers!.request("session/request_permission", {
              sessionId: params["sessionId"],
              toolCall: { toolCallId: "call-1", kind: "execute", rawInput: { command: "curl x" } },
              options: [
                { optionId: "allow-once", kind: "allow_once" },
                { optionId: "always-allow", kind: "allow_always" },
                { optionId: "reject-once", kind: "reject_once" },
              ],
            })) as Record<string, unknown>;
            calls.push({ method: "answered", params: answer });
            return { stopReason: "end_turn" } as T;
          }
          default:
            return {} as T;
        }
      },
      notify: (method, params) => notes.push({ method, params }),
      ended: new Promise(() => {}),
      pid: 1,
      stop: async () => {},
    };
  };
  return { started, calls, notes, start };
};

const hostWith = (agent: ReturnType<typeof fakeAgent>) =>
  makeGrokHost({
    binary: Effect.succeed("grok"),
    env: Effect.succeed({}),
    start: agent.start,
    newMessageId: () => MessageId.make("m1"),
  });

describe("Grok Build host", () => {
  it("starts in Gram's mode, never the user's own default, and asks before a command", async () => {
    const agent = fakeAgent();
    const events: Array<AgentEvent> = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* hostWith(agent);
          const session = yield* host.open({
            threadId: ThreadId.make("t"),
            cwd: "/work",
            permissionMode: "default",
          });
          const fiber = yield* Stream.runForEach(session.events, (event) =>
            Effect.gen(function* () {
              events.push(event);
              if (event.type === "request")
                yield* session.respond(event.request.id, {
                  kind: "approval",
                  decision: "allow",
                  scope: "always",
                });
            }),
          ).pipe(Effect.forkScoped);
          yield* session.send({ text: "go" });
          yield* Effect.promise(async () => {
            while (!events.some((event) => event.type === "turnEnd"))
              await new Promise((resolve) => setTimeout(resolve, 5));
          });
          yield* Fiber.interrupt(fiber);
        }),
      ),
    );
    expect(agent.started[0]?.args.slice(0, 2)).toEqual(["--permission-mode", "default"]);
    expect(agent.notes).toContainEqual({
      method: "_x.ai/yolo_mode_changed",
      params: permissionParams("ask"),
    });
    const request = events.find((event) => event.type === "request");
    expect(
      request?.type === "request" && request.request.kind === "approval"
        ? request.request.scopes
        : undefined,
    ).toEqual(["once", "always"]);
    expect(agent.calls).toContainEqual({
      method: "answered",
      params: { outcome: { outcome: "selected", optionId: "always-allow" } },
    });
  });

  it("resumes the thread's own session rather than starting another", async () => {
    const agent = fakeAgent();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* hostWith(agent);
          yield* host.open({ threadId: ThreadId.make("t"), cwd: "/work", resumeId: "old-session" });
        }),
      ),
    );
    expect(agent.calls.map((call) => call.method)).toContain("session/resume");
    expect(agent.calls.map((call) => call.method)).not.toContain("session/new");
    expect(agent.calls.find((call) => call.method === "session/resume")?.params).toMatchObject({
      sessionId: "old-session",
      cwd: "/work",
    });
  });
});
