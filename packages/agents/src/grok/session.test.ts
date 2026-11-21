import { MessageId, ThreadId, type AgentEvent } from "@gram/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { AcpConnection, AcpHandlers, StartAcpAgent } from "./acp.ts";
import {
  autoAnswer,
  billingLimits,
  connectorOf,
  grokCommands,
  grokPermission,
  type Json,
  permissionParams,
  promptOf,
  transcriptOf,
} from "./extensions.ts";
import { makeGrokHost, withHeadlessSignIn } from "./session.ts";

const command = (text: string) => ({ kind: "execute", rawInput: { command: text } });
const ROOTS = [tmpdir()];
const edit = (rawInput: Json, locations?: ReadonlyArray<Json>): Json => ({
  kind: "edit",
  rawInput,
  ...(locations === undefined ? {} : { locations }),
});

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
    expect(autoAnswer("bypassPermissions", "all", command("ls -la"), ROOTS)).toBe("allow");
    expect(
      autoAnswer("bypassPermissions", "all", command("git push origin main"), ROOTS),
    ).toBeUndefined();
    expect(
      autoAnswer("bypassPermissions", "irreversible", command("gh pr merge 12"), ROOTS),
    ).toBeUndefined();
    expect(autoAnswer("auto", "all", { kind: "edit", rawInput: {} }, ROOTS)).toBe("allow");
  });

  it("lets Gram's own app tools through in every mode, and no other server's", () => {
    const gram = { kind: "other", rawInput: { tool_name: "gram__list_open_prs", tool_input: {} } };
    const other = { kind: "other", rawInput: { tool_name: "github__merge_pr", tool_input: {} } };
    for (const mode of ["default", "dontAsk", "plan"] as const)
      expect(autoAnswer(mode, "all", gram, ROOTS)).toBe("allow");
    expect(autoAnswer("default", "all", other, ROOTS)).toBeUndefined();
    expect(autoAnswer("dontAsk", undefined, other, ROOTS)).toBe("deny");
  });

  it("shows the card in acceptEdits for an edit outside the thread's folders, or naming none", () => {
    const top = mkdtempSync(join(tmpdir(), "grok-edit-"));
    const cwd = join(top, "thread");
    const granted = join(top, "granted");
    mkdirSync(cwd);
    mkdirSync(granted);
    symlinkSync(top, join(cwd, "up"));
    const answer = (call: Json) => autoAnswer("acceptEdits", undefined, call, [cwd, granted]);
    expect(answer(edit({ file_path: "a.ts" }))).toBe("allow");
    expect(answer(edit({ file_path: join(granted, "b.ts") }))).toBe("allow");
    expect(answer(edit({ file_path: "../.bashrc" }))).toBeUndefined();
    expect(answer(edit({ file_path: "/home/me/.ssh/authorized_keys" }))).toBeUndefined();
    expect(answer(edit({ file_path: "up/.bashrc" }))).toBeUndefined();
    // A link's `..` goes from where the link points, and a dangling link's write creates its target.
    expect(answer(edit({ file_path: "up/thread/../.bashrc" }))).toBeUndefined();
    symlinkSync(join(top, "made-outside.sh"), join(cwd, "notes.sh"));
    expect(answer(edit({ file_path: "notes.sh" }))).toBeUndefined();
    expect(answer(edit({ file_path: "new/dir/c.ts" }))).toBe("allow");
    symlinkSync(join(top, "missing"), join(cwd, "gone"));
    expect(answer(edit({ file_path: "gone/x.ts" }))).toBeUndefined();
    // A root that is itself a link counts as where it points.
    symlinkSync(cwd, join(top, "linked-thread"));
    const viaLink = join(top, "linked-thread");
    expect(autoAnswer("acceptEdits", undefined, edit({ file_path: "a.ts" }), [viaLink])).toBe(
      "allow",
    );
    expect(answer(edit({ file_path: "a.ts" }, [{ path: "/etc/profile" }]))).toBeUndefined();
    expect(answer(edit({}))).toBeUndefined();
    expect(answer(edit({ file_path: 7 }))).toBeUndefined();
  });

  it("refuses in dontAsk, passes edits in acceptEdits, and shows the rest", () => {
    expect(autoAnswer("dontAsk", undefined, command("ls"), ROOTS)).toBe("deny");
    const inside = edit({ file_path: join(tmpdir(), "src/a.ts") });
    expect(autoAnswer("acceptEdits", undefined, inside, ROOTS)).toBe("allow");
    expect(autoAnswer("acceptEdits", undefined, command("ls"), ROOTS)).toBeUndefined();
    expect(autoAnswer("default", undefined, command("ls"), ROOTS)).toBeUndefined();
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

const replayed = (sessionUpdate: string, extra: Record<string, unknown>, at: number) => ({
  sessionId: "s",
  update: { sessionUpdate, ...extra },
  _meta: { agentTimestampMs: at },
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
    expect(
      transcriptOf([
        replayed("user_message_chunk", { content: { type: "text", text: "List it" } }, 1),
        replayed("agent_thought_chunk", { content: { type: "text", text: "hm" } }, 2),
        replayed("agent_message_chunk", { content: { type: "text", text: "Listing" } }, 3),
        replayed("tool_call", { title: "list_dir", rawInput: {} }, 4),
        replayed("agent_message_chunk", { content: { type: "text", text: " done." } }, 5),
        replayed("user_message_chunk", { content: { type: "text", text: "Thanks" } }, 6),
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
          const turnEnded = yield* Deferred.make<void>();
          const fiber = yield* Stream.runForEach(session.events, (event) =>
            Effect.gen(function* () {
              events.push(event);
              if (event.type === "turnEnd") yield* Deferred.succeed(turnEnded, undefined);
              if (event.type === "request")
                yield* session.respond(event.request.id, {
                  kind: "approval",
                  decision: "allow",
                  scope: "always",
                });
            }),
          ).pipe(Effect.forkScoped);
          yield* session.send({ text: "go" });
          yield* Deferred.await(turnEnded);
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

const recording = () => {
  const methods: Array<string> = [];
  const connection: AcpConnection = {
    request: async <T>(method: string) => {
      methods.push(method);
      return {} as T;
    },
    notify: () => {},
    ended: new Promise(() => {}),
    pid: 1,
    stop: async () => {},
  };
  return { methods, connection };
};

describe("Grok Build in a sandbox", () => {
  it("signs in headless on the token command's login when the environment names one", async () => {
    const { methods, connection } = recording();
    const wrapped = withHeadlessSignIn(connection, { GROK_AUTH_PROVIDER_COMMAND: "printf token" });
    await wrapped.request("initialize", {});
    await wrapped.request("session/new", {});
    expect(methods).toEqual(["initialize", "authenticate", "session/new"]);
  });

  it("leaves a desktop CLI on its own sign-in", async () => {
    const { methods, connection } = recording();
    await withHeadlessSignIn(connection, {}).request("initialize", {});
    expect(methods).toEqual(["initialize"]);
  });
});
