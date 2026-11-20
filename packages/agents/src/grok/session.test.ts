import { MessageId, ThreadId, type AgentEvent } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";

import type { AcpConnection, AcpHandlers, StartAcpAgent } from "./acp.ts";
import {
  autoAnswer,
  billingLimits,
  connectorOf,
  grokCommands,
  promptOf,
  transcriptOf,
  grokPermission,
  makeGrokHost,
  permissionParams,
} from "./session.ts";

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

  it("lets Gram's own app tools through in every mode, and no other server's", () => {
    const gram = { kind: "other", rawInput: { tool_name: "gram__list_open_prs", tool_input: {} } };
    const other = { kind: "other", rawInput: { tool_name: "github__merge_pr", tool_input: {} } };
    for (const mode of ["default", "dontAsk", "plan"] as const)
      expect(autoAnswer(mode, "all", gram)).toBe("allow");
    expect(autoAnswer("default", "all", other)).toBeUndefined();
    expect(autoAnswer("dontAsk", undefined, other)).toBe("deny");
  });

  it("refuses in dontAsk, passes edits in acceptEdits, and shows the rest", () => {
    expect(autoAnswer("dontAsk", undefined, command("ls"))).toBe("deny");
    expect(autoAnswer("acceptEdits", undefined, { kind: "edit", rawInput: {} })).toBe("allow");
    expect(autoAnswer("acceptEdits", undefined, command("ls"))).toBeUndefined();
    expect(autoAnswer("default", undefined, command("ls"))).toBeUndefined();
  });
});

const billing = (percent: number, type: string, prepaid?: number) => ({
  config: {
    creditUsagePercent: percent,
    currentPeriod: { type, start: "2026-11-16T08:00:00Z", end: "2026-11-23T08:00:00Z" },
    ...(prepaid === undefined ? {} : { prepaidBalance: { val: prepaid } }),
  },
});

describe("Grok Build plan usage", () => {
  it("reads a weekly credit period as the seven-day window, with its reset", () => {
    expect(billingLimits(billing(5, "USAGE_PERIOD_TYPE_WEEKLY"))).toEqual([
      {
        window: "seven_day",
        utilization: 0.05,
        status: "allowed",
        resetsAt: Date.parse("2026-11-23T08:00:00Z"),
      },
    ]);
  });

  it("says a spent allowance is at its limit unless prepaid credits carry on", () => {
    expect(billingLimits(billing(100, "USAGE_PERIOD_TYPE_WEEKLY"))[0]).toMatchObject({
      status: "rejected",
      utilization: 1,
    });
    expect(billingLimits(billing(100, "USAGE_PERIOD_TYPE_WEEKLY", 500))[0]).toMatchObject({
      credits: true,
      creditsAvailable: true,
    });
  });

  it("gives no window for a monthly period or a reading without a share", () => {
    expect(billingLimits(billing(40, "USAGE_PERIOD_TYPE_MONTHLY"))).toEqual([]);
    expect(billingLimits({ config: {} })).toEqual([]);
  });
});

describe("Grok Build session content", () => {
  it("sends images inline and other attachments as links to their files", async () => {
    const blocks = await promptOf(
      {
        text: "Look",
        attachments: [
          { path: "/work/shot.png", name: "shot.png", mediaType: "image/png" },
          { path: "/work/notes.md", name: "notes.md" },
        ],
      },
      async () => new Uint8Array([1, 2, 3]),
    );
    expect(blocks).toEqual([
      { type: "text", text: "Look" },
      { type: "image", mimeType: "image/png", data: "AQID" },
      { type: "resource_link", uri: "file:///work/notes.md", name: "notes.md" },
    ]);
  });

  it("reads Grok's commands as slash commands with their hints", () => {
    expect(
      grokCommands({
        availableCommands: [
          { name: "compact", description: "Compress history", input: null },
          { name: "goal", description: "Set a goal", input: { hint: "<objective>" } },
        ],
      }),
    ).toEqual([
      { name: "compact", description: "Compress history" },
      { name: "goal", description: "Set a goal", argumentHint: "<objective>" },
    ]);
  });

  it("reports each server's state, Gram's own as built in and never switched", () => {
    expect(
      connectorOf({ name: "gram", session: { enabled: true, status: "ready" } }),
    ).toMatchObject({ status: "connected", builtIn: true });
    expect(
      connectorOf({
        name: "x",
        session: { enabled: true, status: "unavailable", authRequired: true },
      }),
    ).toMatchObject({ status: "needs-auth" });
    expect(connectorOf({ name: "y", session: { enabled: false } })?.status).toBe("disabled");
    expect(
      connectorOf({ name: "z", session: { enabled: true, status: "initializing" } })?.status,
    ).toBe("pending");
  });

  it("reads a replayed session as alternating messages with the calls made", () => {
    const update = (sessionUpdate: string, extra: Record<string, unknown>, at: number) => ({
      sessionId: "s",
      update: { sessionUpdate, ...extra },
      _meta: { agentTimestampMs: at },
    });
    expect(
      transcriptOf([
        update("user_message_chunk", { content: { type: "text", text: "List it" } }, 1),
        update("agent_thought_chunk", { content: { type: "text", text: "hm" } }, 2),
        update("agent_message_chunk", { content: { type: "text", text: "Listing" } }, 3),
        update("tool_call", { title: "list_dir", rawInput: {} }, 4),
        update("agent_message_chunk", { content: { type: "text", text: " done." } }, 5),
        update("user_message_chunk", { content: { type: "text", text: "Thanks" } }, 6),
      ]),
    ).toEqual([
      { role: "user", text: "List it", at: 1 },
      { role: "assistant", text: "Listing done.", tools: [{ name: "LS" }], at: 3 },
      { role: "user", text: "Thanks", at: 6 },
    ]);
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
          case "_x.ai/mcp/list":
            return {
              result: {
                servers: [
                  { name: "gram", session: { enabled: true, status: "ready" } },
                  { name: "github", session: { enabled: true, status: "ready" } },
                  { name: "linear", session: { enabled: true, status: "ready" } },
                ],
              },
            } as T;
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

  it("gives a role's instructions to Grok's system prompt and leaves out the servers a list does", async () => {
    const agent = fakeAgent();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* hostWith(agent);
          yield* host.open({
            threadId: ThreadId.make("t"),
            cwd: "/work",
            instructions: "You are a worker.",
            mcpAllowlist: ["github"],
          });
        }),
      ),
    );
    expect(agent.calls.find((call) => call.method === "session/new")?.params).toMatchObject({
      _meta: { rules: "You are a worker." },
    });
    const toggled = agent.calls.filter((call) => call.method === "_x.ai/mcp/toggle");
    expect(toggled.map((call) => call.params)).toEqual([
      { sessionId: "new-session", serverName: "linear", enabled: false },
    ]);
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
