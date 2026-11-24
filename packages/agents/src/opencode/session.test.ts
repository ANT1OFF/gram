import { describe, expect, it } from "@effect/vitest";
import {
  AgentUnavailable,
  type AgentEvent,
  type GatewayProfile,
  type MessageId,
  type ProfileId,
  type ThreadId,
  XAI_BASE_URL,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import type { OpenCodeClient } from "./client.ts";
import type { OpenCodeEvent, OpenCodeModel } from "./protocol.ts";
import type { OpenCodeServer, StartOpenCodeServer } from "./server.ts";
import {
  agentModels,
  gateAllows,
  gatewayConfig,
  GATEWAY_KEY_ENV,
  isAnthropic,
  makeOpenCodeHost,
  modelRefFor,
  rulesFor,
  sessionRules,
} from "./session.ts";

const THREAD = "thr_1" as ThreadId;

/** A server stood in for `opencode serve`: it records calls and plays the events it is handed. */
const standIn = () => {
  const calls: Array<readonly [string, ...Array<unknown>]> = [];
  const started: Array<StartOpenCodeServer> = [];
  let emit: ((event: OpenCodeEvent) => void) | undefined;
  const stopped: Array<number> = [];
  const failPermissions = { on: false };
  const client: OpenCodeClient = {
    createSession: async (input) => {
      calls.push(["createSession", input]);
      return { id: "ses_1" };
    },
    getSession: async (id) => {
      calls.push(["getSession", id]);
      if (id === "ses_child") return { id, parentID: "ses_1" };
      if (id === "ses_stranger") return { id, parentID: "ses_other" };
      return id === "ses_old" ? { id } : undefined;
    },
    listSessions: async () => [{ id: "ses_1", title: "Fix it", updated: 7, directory: "/w" }],
    prompt: async (...args) => void calls.push(["prompt", ...args]),
    interrupt: async (...args) => void calls.push(["interrupt", ...args]),
    setPermissions: async (...args) => {
      calls.push(["setPermissions", ...args]);
      if (failPermissions.on) throw new Error("PATCH refused");
    },
    setAgent: async (...args) => void calls.push(["setAgent", ...args]),
    setModel: async (...args) => void calls.push(["setModel", ...args]),
    permissions: async () => [],
    reply: async (...args) => void calls.push(["reply", ...args]),
    models: async () => [],
    subscribe: (onEvent, signal) =>
      new Promise((resolve) => {
        emit = onEvent;
        onEvent({ type: "server.connected", data: {} });
        signal.addEventListener("abort", () => resolve());
      }),
  };
  const start = async (input: StartOpenCodeServer): Promise<OpenCodeServer> => {
    started.push(input);
    const n = started.length;
    return {
      url: "http://127.0.0.1:1",
      client,
      pid: 100 + n,
      alive: () => !stopped.includes(n),
      stop: async () => void stopped.push(n),
    };
  };
  return {
    calls,
    started,
    stopped,
    start,
    failPermissions,
    emit: (event: OpenCodeEvent) => emit?.(event),
  };
};

const PROFILE: GatewayProfile = {
  id: "openrouter" as ProfileId,
  name: "OpenRouter",
  baseURL: "https://openrouter.ai/api/v1",
  kind: "openrouter",
  keyRef: "profile:openrouter",
  models: [
    { id: "openai/gpt-5", name: "GPT-5", contextWindow: 400_000 },
    { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
    { id: "~anthropic/claude-latest", name: "Claude latest" },
    { id: "moonshotai/kimi-k2", name: "Kimi K2" },
  ],
};

const hostWith = (stand: ReturnType<typeof standIn>) => {
  let n = 0;
  return makeOpenCodeHost({
    binary: Effect.succeed("/bin/opencode"),
    env: Effect.succeed({ PATH: "/bin" }),
    credentials: () => Effect.succeed({ profile: PROFILE, key: Redacted.make("sk-or-test") }),
    start: stand.start,
    newMessageId: () => `m${++n}` as MessageId,
  });
};

describe("the OpenCode host", () => {
  it.live("opens a session in build with the mode's rules, sends, and answers an approval", () =>
    Effect.gen(function* () {
      const stand = standIn();
      const host = yield* hostWith(stand);
      const session = yield* host.open({ threadId: THREAD, cwd: "/w" });
      const seen: Array<AgentEvent> = [];
      const reading = yield* session.events.pipe(
        Stream.runForEach((event) => Effect.sync(() => seen.push(event))),
        Effect.forkScoped,
      );
      expect(stand.calls[0]).toEqual([
        "createSession",
        { directory: "/w", agent: "build", permissions: rulesFor("default") },
      ]);

      yield* session.send({ text: "make a file" });
      expect(stand.calls.at(-1)).toEqual(["prompt", "ses_1", "make a file"]);

      stand.emit({
        type: "permission.asked",
        data: { id: "per_1", sessionID: "ses_1", action: "shell", resources: ["echo hi"] },
      });
      yield* Effect.sleep("20 millis");
      expect(seen[0]).toMatchObject({ type: "identity", agentSessionId: "ses_1" });
      const request = seen.find((event) => event.type === "request");
      expect(request).toMatchObject({ request: { id: "per_1", scopes: ["once", "always"] } });

      yield* session.respond("per_1" as never, {
        kind: "approval",
        decision: "allow",
        scope: "once",
      });
      yield* session.respond("per_1" as never, {
        kind: "approval",
        decision: "deny",
        scope: "once",
        message: "no",
      });
      expect(stand.calls.slice(-2)).toEqual([
        ["reply", "ses_1", "per_1", "once", undefined],
        ["reply", "ses_1", "per_1", "reject", "no"],
      ]);

      yield* session.setMode("plan");
      expect(stand.calls.slice(-2)).toEqual([
        ["setPermissions", "ses_1", rulesFor("plan")],
        ["setAgent", "ses_1", "plan"],
      ]);
      yield* session.steer({ text: "also this" });
      expect(stand.calls.at(-1)).toEqual(["prompt", "ses_1", "also this", "steer"]);
      yield* Fiber.interrupt(reading);
    }).pipe(Effect.scoped),
  );

  it.live("resumes a session, setting its rules again rather than making one", () =>
    Effect.gen(function* () {
      const stand = standIn();
      const host = yield* hostWith(stand);
      yield* host.open({
        threadId: THREAD,
        cwd: "/w",
        resumeId: "ses_old",
        permissionMode: "auto",
      });
      expect(stand.calls.map(([name]) => name)).toEqual(["getSession", "setPermissions"]);
      expect(stand.calls[1]).toEqual(["setPermissions", "ses_old", rulesFor("auto")]);
    }).pipe(Effect.scoped),
  );

  it.live(
    "starts one server a profile, with the key only in its env, and stops it on a change",
    () =>
      Effect.gen(function* () {
        const stand = standIn();
        const host = yield* hostWith(stand);
        const model = { agent: "opencode", model: "openai/gpt-5", profileId: PROFILE.id } as const;
        yield* host.open({ threadId: THREAD, cwd: "/w", model });
        yield* host.open({ threadId: THREAD, cwd: "/w", model });
        expect(stand.started).toHaveLength(1);
        const env = stand.started[0]!.env;
        expect(env[GATEWAY_KEY_ENV]).toBe("sk-or-test");
        expect(env["OPENCODE_CONFIG_CONTENT"]).not.toContain("sk-or-test");
        expect(stand.calls[0]).toMatchObject([
          "createSession",
          { model: { providerID: "gram", id: "openai/gpt-5" } },
        ]);
        yield* host.invalidateProfile!(PROFILE.id);
        expect(stand.stopped).toEqual([1]);
        const sessions = yield* host.listSessions!({ cwd: "/w" });
        expect(sessions).toEqual([
          { agentSessionId: "ses_1", title: "Fix it", updatedAt: 7, cwd: "/w" },
        ]);
      }).pipe(Effect.scoped),
  );

  it.live("starts one server for opens at once", () =>
    Effect.gen(function* () {
      const stand = standIn();
      const host = yield* hostWith(stand);
      yield* Effect.all(
        [host.open({ threadId: THREAD, cwd: "/w" }), host.open({ threadId: THREAD, cwd: "/v" })],
        { concurrency: "unbounded" },
      );
      expect(stand.started).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.live("refuses a mode OpenCode didn't take, saying so, and answers a session grant once", () =>
    Effect.gen(function* () {
      const stand = standIn();
      const host = yield* hostWith(stand);
      const session = yield* host.open({ threadId: THREAD, cwd: "/w" });
      stand.failPermissions.on = true;
      const error = yield* session.setMode("bypassPermissions").pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "ModeRefused", mode: "bypassPermissions" });
      // The rules it couldn't change are put back as the old mode's, and the agent with them.
      expect(stand.calls.slice(-2).map(([name, , rules]) => [name, rules])).toEqual([
        ["setPermissions", rulesFor("bypassPermissions")],
        ["setPermissions", rulesFor("default")],
      ]);
      yield* session.respond("per_1" as never, {
        kind: "approval",
        decision: "allow",
        scope: "session",
      });
      expect(stand.calls.at(-1)).toEqual(["reply", "ses_1", "per_1", "once", undefined]);
    }).pipe(Effect.scoped),
  );

  it.live("refuses a session whose writes and shell it would have to bound", () =>
    Effect.gen(function* () {
      const stand = standIn();
      const host = yield* hostWith(stand);
      const error = yield* host
        .open({ threadId: THREAD, cwd: "/w", confineWrites: true })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "AgentUnavailable", agent: "opencode" });
      expect(stand.started).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live("answers a command the gate lets through itself, and shows a push", () =>
    Effect.gen(function* () {
      const stand = standIn();
      const host = yield* hostWith(stand);
      const session = yield* host.open({
        threadId: THREAD,
        cwd: "/w",
        permissionMode: "bypassPermissions",
        outwardGate: "all",
      });
      const seen: Array<AgentEvent> = [];
      yield* session.events.pipe(
        Stream.runForEach((event) => Effect.sync(() => seen.push(event))),
        Effect.forkScoped,
      );
      const ask = (id: string, command: string) =>
        stand.emit({
          type: "permission.asked",
          data: { id, sessionID: "ses_1", action: "shell", resources: [command] },
        });
      ask("per_a", "npm test");
      ask("per_b", "git push origin main");
      yield* Effect.sleep("20 millis");
      expect(stand.calls).toContainEqual(["reply", "ses_1", "per_a", "once"]);
      const requests = seen.flatMap((event) =>
        event.type === "request" ? [event.request.id] : [],
      );
      expect(requests).toEqual(["per_b"]);
    }).pipe(Effect.scoped),
  );

  it.live(
    "shows a subagent's approval in its parent's thread and answers it under the subagent",
    () =>
      Effect.gen(function* () {
        const stand = standIn();
        const host = yield* hostWith(stand);
        const session = yield* host.open({ threadId: THREAD, cwd: "/w" });
        const seen: Array<AgentEvent> = [];
        yield* session.events.pipe(
          Stream.runForEach((event) => Effect.sync(() => seen.push(event))),
          Effect.forkScoped,
        );
        const ask = (id: string, sessionID: string) =>
          stand.emit({
            type: "permission.asked",
            data: { id, sessionID, action: "edit", resources: ["a.ts"] },
          });
        ask("per_child", "ses_child");
        ask("per_stranger", "ses_stranger");
        yield* Effect.sleep("20 millis");
        const requests = seen.flatMap((event) =>
          event.type === "request" ? [event.request.id] : [],
        );
        expect(requests).toEqual(["per_child"]);
        yield* session.respond("per_child" as never, {
          kind: "approval",
          decision: "allow",
          scope: "once",
        });
        expect(stand.calls.at(-1)).toEqual(["reply", "ses_child", "per_child", "once", undefined]);
      }).pipe(Effect.scoped),
  );

  it.live("says OpenCode is unavailable when it isn't installed", () =>
    Effect.gen(function* () {
      const host = yield* makeOpenCodeHost({
        binary: Effect.fail(
          new AgentUnavailable({
            agent: "opencode",
            message: "OpenCode isn't installed",
          }),
        ),
        env: Effect.succeed({}),
        credentials: () => Effect.die("unused"),
        start: () => Promise.reject(new Error("unused")),
        newMessageId: () => "m" as MessageId,
      });
      const error = yield* host.open({ threadId: THREAD, cwd: "/w" }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "AgentUnavailable", agent: "opencode" });
    }).pipe(Effect.scoped),
  );
});

const model = (id: string, providerID: string, rest: Partial<OpenCodeModel> = {}) =>
  ({ id, providerID, name: id, ...rest }) as OpenCodeModel;

type Mode = Parameters<typeof rulesFor>[0];
const gatedShell = (mode: Mode) =>
  sessionRules(mode, "all").findLast((each) => each.action === "shell")?.effect;
const asked = (command: string, mode: Mode = "bypassPermissions") =>
  gateAllows(mode, "all", { action: "shell", resources: [command] });

const effect = (mode: Mode, action: string) =>
  rulesFor(mode).findLast((each) => each.action === action || each.action === "*")?.effect ?? "ask";

describe("OpenCode's rules", () => {
  it("runs commands unasked only when permissions are bypassed", () => {
    expect(effect("bypassPermissions", "shell")).toBe("allow");
    for (const mode of ["default", "auto", "acceptEdits"] as const)
      expect(effect(mode, "shell")).toBe("ask");
    expect(effect("dontAsk", "shell")).toBe("deny");
    expect(effect("dontAsk", "edit")).toBe("deny");
    expect(effect("dontAsk", "read")).toBe("allow");
    // An action none of the rules names, such as an MCP tool, falls to the first, catch-all rule.
    expect(effect("dontAsk", "github_create_issue")).toBe("deny");
    expect(effect("plan", "github_create_issue")).toBe("ask");
    expect(rulesFor("dontAsk")[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
    expect(rulesFor("plan")[0]).toEqual({ action: "*", resource: "*", effect: "ask" });
  });

  it("lets plan read and nothing else", () => {
    for (const action of ["edit", "write", "shell", "subagent"])
      expect(effect("plan", action)).toBe("deny");
    expect(effect("plan", "read")).toBe("allow");
    expect(effect("acceptEdits", "edit")).toBe("allow");
    for (const mode of ["default", "auto", "acceptEdits", "dontAsk"] as const)
      expect(effect(mode, "subagent")).toBe("deny");
    expect(effect("bypassPermissions", "subagent")).toBe("allow");
  });

  it("asks about every command while a push gate is on, and lets through what it doesn't ask about", () => {
    expect(gatedShell("bypassPermissions")).toBe("ask");
    expect(gatedShell("dontAsk")).toBe("deny");
    expect(asked("npm test")).toBe(true);
    expect(asked("git push origin main")).toBe(false);
    expect(asked("npm test", "default")).toBe(false);
    expect(gateAllows("bypassPermissions", undefined, { action: "shell", resources: ["ls"] })).toBe(
      false,
    );
  });
});

describe("OpenCode's models and config", () => {
  it("offers every maker's tool-using models but Anthropic's", () => {
    const offered = agentModels([
      model("gpt-5", "openai", { variants: [{ id: "high" }, { id: "fast" }] }),
      model("claude-sonnet-4-5", "anthropic"),
      model("anthropic/claude-opus", "openrouter"),
      model("no-tools", "openai", { capabilities: { tools: false } }),
      model("old", "openai", { status: "deprecated" }),
    ]);
    expect(offered).toEqual([
      { id: "openai/gpt-5", displayName: "gpt-5", supportsEffort: true, efforts: ["high"] },
    ]);
    expect(isAnthropic({ id: "claude-3", providerID: "github-copilot" })).toBe(true);
  });

  it("points a gateway profile's config at its URL, naming the key's env var and no Anthropic model", () => {
    const config = JSON.parse(
      gatewayConfig({ profile: PROFILE, key: Redacted.make("sk-or-test") }),
    );
    expect(config).toEqual({
      model: "gram/openai/gpt-5",
      providers: {
        gram: {
          name: "OpenRouter",
          env: [GATEWAY_KEY_ENV],
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: "https://openrouter.ai/api/v1" },
          models: {
            "openai/gpt-5": { name: "GPT-5", limit: { context: 400_000 } },
            "moonshotai/kimi-k2": { name: "Kimi K2" },
          },
        },
      },
    });
  });

  it("prices a gateway model the gateway lists prices for, cached input included", () => {
    const config = JSON.parse(
      gatewayConfig({
        profile: {
          id: "xai" as ProfileId,
          name: "xAI",
          baseURL: XAI_BASE_URL,
          kind: "xai",
          keyRef: "profile:xai",
          models: [
            {
              id: "grok-4.7",
              name: "grok-4.7",
              price: { input: 2, cachedInput: 0.5, output: 6 },
            },
          ],
        },
        key: Redacted.make("xai-test"),
      }),
    );
    expect(config.providers.gram.models["grok-4.7"].cost).toEqual({
      input: 2,
      output: 6,
      cache: { read: 0.5 },
    });
  });

  it("reads a model id as OpenCode's provider and model", () => {
    expect(modelRefFor({ agent: "opencode", model: "openai/gpt-5" })).toEqual({
      providerID: "openai",
      id: "gpt-5",
    });
    expect(modelRefFor({ agent: "opencode", model: "plain" })).toBeUndefined();
    expect(modelRefFor(undefined)).toBeUndefined();
  });
});
