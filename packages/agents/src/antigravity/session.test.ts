import { MessageId, ThreadId, type AgentEvent } from "@gram/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  AcpError,
  type AcpConnection,
  type AcpHandlers,
  type StartAcpAgent,
} from "../acp/connection.ts";
import type { Json } from "../acp/json.ts";
import {
  antigravityMode,
  antigravityModels,
  autoAnswer,
  promptUsage,
  toolFor,
} from "./extensions.ts";
import {
  API_KEY_NOTICE,
  makeAntigravityHost,
  SIGN_IN_MESSAGE,
  withHeadlessSignIn,
} from "./session.ts";
import { CUSTOMIZATIONS_REFUSAL } from "./workspace.ts";

const APP = "gram0a1b2c3d";
const ROOTS = [tmpdir()];
const command = (line: string): Json => ({
  kind: "execute",
  name: "run_command",
  rawInput: { CommandLine: line },
});

const edit = (path: string): Json => ({
  kind: "edit",
  name: "edit_file",
  rawInput: { Path: path },
  locations: [{ path }],
});

describe("Antigravity permissions", () => {
  it("follows Gram's mode, and asks for every command under an outward gate", () => {
    expect(antigravityMode("default", undefined)).toBe("default");
    expect(antigravityMode("acceptEdits", undefined)).toBe("accept-edits");
    expect(antigravityMode("plan", "all")).toBe("plan");
    expect(antigravityMode("auto", undefined)).toBe("auto");
    expect(antigravityMode("auto", "irreversible")).toBe("default");
    expect(antigravityMode("bypassPermissions", undefined)).toBe("default");
    expect(antigravityMode("dontAsk", undefined)).toBe("default");
  });

  it("answers every request itself in Bypass, and lets Antigravity's auto mode ask", () => {
    expect(autoAnswer("bypassPermissions", undefined, command("rm -rf build"), ROOTS, APP)).toBe(
      "allow",
    );
    expect(autoAnswer("auto", undefined, command("rm -rf build"), ROOTS, APP)).toBeUndefined();
    expect(autoAnswer("default", undefined, command("ls"), ROOTS, APP)).toBeUndefined();
    expect(autoAnswer("dontAsk", undefined, command("ls"), ROOTS, APP)).toBe("deny");
  });

  it("lets through what a gated Bypass or Auto session would run, except what the gate asks", () => {
    for (const mode of ["bypassPermissions", "auto"] as const) {
      expect(autoAnswer(mode, "all", command("ls -la"), ROOTS, APP)).toBe("allow");
      expect(autoAnswer(mode, "all", command("git push origin main"), ROOTS, APP)).toBeUndefined();
    }
    expect(
      autoAnswer("bypassPermissions", "irreversible", command("gh pr merge 12"), ROOTS, APP),
    ).toBeUndefined();
  });

  it("lets this session's app tools through in every mode, and no server named like them", () => {
    const own = { kind: "other", name: `mcp_${APP}_list_open_prs`, rawInput: {} };
    const lookalike = { kind: "other", name: `mcp_gram_${APP}_list_open_prs`, rawInput: {} };
    for (const mode of ["default", "dontAsk", "plan"] as const)
      expect(autoAnswer(mode, "all", own, ROOTS, APP)).toBe("allow");
    expect(autoAnswer("default", undefined, lookalike, ROOTS, APP)).toBeUndefined();
  });

  it("reads an app tool by its name alone, never the title the model can shape", () => {
    const titled = { kind: "other", title: `mcp_${APP}_list_open_prs`, rawInput: {} };
    expect(autoAnswer("default", undefined, titled, ROOTS, APP)).toBeUndefined();
  });

  it("puts any call carrying a command line through the gate, whatever its kind", () => {
    const push = { kind: "other", name: "x", rawInput: { command: "git push origin main" } };
    const list = { kind: "other", name: "x", rawInput: { CommandLine: "ls" } };
    expect(autoAnswer("bypassPermissions", "all", push, ROOTS, APP)).toBeUndefined();
    expect(autoAnswer("auto", "all", list, ROOTS, APP)).toBe("allow");
  });

  it("passes edits inside the thread's folders in Accept edits, and shows the rest", () => {
    expect(autoAnswer("acceptEdits", undefined, edit(join(tmpdir(), "a.ts")), ROOTS, APP)).toBe(
      "allow",
    );
    expect(autoAnswer("acceptEdits", undefined, edit("/etc/profile"), ROOTS, APP)).toBeUndefined();
  });
});

/** A work folder, its `.agents` folder not yet made; `write` adds a file under `.agents`. */
const workFolder = () => {
  const root = mkdtempSync(join(tmpdir(), "gram-agy-work-"));
  const write = (name: string, at = root) => {
    mkdirSync(join(at, ".agents"), { recursive: true });
    writeFileSync(join(at, ".agents", name), "{}");
  };
  return { root, write, done: () => rmSync(root, { recursive: true, force: true }) };
};

describe("Antigravity and a workspace's own .agents folder", () => {
  it("shows a card for a change under .agents in every mode, Bypass and the gate included", () => {
    const work = workFolder();
    try {
      mkdirSync(join(work.root, ".agents"));
      symlinkSync(join(work.root, ".agents"), join(work.root, "config"));
      const roots = [work.root];
      const changes: ReadonlyArray<Json> = [
        edit(join(work.root, ".agents", "hooks.json")),
        edit(".agents/mcp_config.json"),
        edit(join(work.root, ".AGENTS", "plugins", "x.json")),
        edit(join(work.root, "config", "hooks.json")),
        { kind: "edit", name: "write_file", rawInput: { TargetFile: ".agents" } },
        { kind: "other", name: "write_file", rawInput: { TargetFile: ".agents/hooks.json" } },
        { kind: "edit", name: "write_file", rawInput: {} },
      ];
      for (const change of changes)
        for (const [mode, gate] of [
          ["bypassPermissions", undefined],
          ["bypassPermissions", "all"],
          ["auto", "all"],
          ["acceptEdits", undefined],
        ] as const)
          expect(autoAnswer(mode, gate, change, roots, APP)).toBeUndefined();
      expect(autoAnswer("bypassPermissions", undefined, edit("src/a.ts"), roots, APP)).toBe(
        "allow",
      );
      expect(autoAnswer("acceptEdits", undefined, edit("src/a.ts"), roots, APP)).toBe("allow");
    } finally {
      work.done();
    }
  });

  it("shows a card for a command naming .agents, and a call of kind other naming no path", () => {
    const calls: ReadonlyArray<Json> = [
      command("echo '{}' > .agents/hooks.json"),
      command("cp /tmp/x ./.AGENTS/mcp_config.json"),
      { kind: "other", name: "x", rawInput: { CommandLine: "mv h .agents/hooks.json" } },
      { kind: "other", name: "write_anywhere", rawInput: { content: "{}" } },
      { name: "write_anywhere", rawInput: {} },
    ];
    for (const call of calls)
      for (const [mode, gate] of [
        ["bypassPermissions", undefined],
        ["bypassPermissions", "all"],
        ["auto", "all"],
      ] as const)
        expect(autoAnswer(mode, gate, call, ROOTS, APP)).toBeUndefined();
    expect(autoAnswer("bypassPermissions", undefined, command("ls src"), ROOTS, APP)).toBe("allow");
    expect(
      autoAnswer("bypassPermissions", undefined, { kind: "fetch", rawInput: {} }, ROOTS, APP),
    ).toBe("allow");
  });

  it("refuses to open, and never starts agy, where the folder or a parent in its repo has them", async () => {
    const work = workFolder();
    try {
      mkdirSync(join(work.root, ".git"));
      const sub = join(work.root, "packages", "app");
      mkdirSync(sub, { recursive: true });
      work.write("mcp_config.json");
      const agent = fakeAgent();
      const error = await turn(agent, { cwd: sub }).catch((cause: unknown) => cause);
      expect(String(error)).toContain(CUSTOMIZATIONS_REFUSAL);
      expect(agent.started).toHaveLength(0);
      const listed = await Effect.runPromise(
        Effect.flip(
          Effect.flatMap(
            hostWith(agent),
            (host) => host.listSessions?.({ cwd: sub, limit: 5 }) ?? Effect.die("no listing"),
          ),
        ),
      );
      expect(listed.message).toContain(CUSTOMIZATIONS_REFUSAL);
      expect(agent.started).toHaveLength(0);
    } finally {
      work.done();
    }
  });

  it("refuses an extra folder's plugins, and looks no higher than the repository's root", async () => {
    const outer = workFolder();
    const extra = workFolder();
    try {
      outer.write("hooks.json");
      const repo = join(outer.root, "repo");
      mkdirSync(join(repo, ".git"), { recursive: true });
      await turn(fakeAgent(), { cwd: repo });
      mkdirSync(join(extra.root, ".agents", "plugins"), { recursive: true });
      const agent = fakeAgent();
      const error = await turn(agent, { cwd: repo, additionalDirectories: [extra.root] }).catch(
        (cause: unknown) => cause,
      );
      expect(String(error)).toContain(CUSTOMIZATIONS_REFUSAL);
      expect(agent.started).toHaveLength(0);
    } finally {
      outer.done();
      extra.done();
    }
  });

  it("ends a turn unprompted, saying why, once a hook file appears during the session", async () => {
    const work = workFolder();
    try {
      const agent = fakeAgent();
      const events = await turn(agent, {
        cwd: work.root,
        beforeSend: () => work.write("hooks.json"),
      });
      expect(agent.calls.map((call) => call.method)).not.toContain("session/prompt");
      const ended = events.find((event) => event.type === "turnEnd");
      expect(ended).toMatchObject({ reason: "error" });
      expect(ended?.type === "turnEnd" ? ended.error : "").toContain(CUSTOMIZATIONS_REFUSAL);
    } finally {
      work.done();
    }
  });
});

const SESSION_NEW = {
  sessionId: "new-session",
  models: {
    availableModels: [
      { modelId: "gemini-4-neon-high" },
      { modelId: "gemini-4-neon-low" },
      { modelId: "gemini-3.8-flash-medium" },
      { modelId: "gpt-oss-120b-medium" },
    ],
    currentModelId: "gemini-4-neon-high",
  },
  configOptions: [
    {
      id: "model",
      currentValue: "gemini-4-neon",
      options: [
        { value: "gemini-4-neon", name: "Gemini 4 Neon" },
        { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
        { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
      ],
    },
    { id: "thought_level", currentValue: "high", options: [{ value: "low" }, { value: "high" }] },
  ],
  _meta: { antigravity: { tier: { name: "Google AI Pro", id: "g1-pro-tier" } } },
};

describe("Antigravity's models and usage", () => {
  it("lists each model once, with the thinking levels it is paired with", () => {
    expect(antigravityModels(SESSION_NEW)).toEqual([
      {
        id: "gemini-4-neon",
        displayName: "Gemini 4 Neon",
        supportsEffort: true,
        efforts: ["high", "low"],
      },
      {
        id: "gemini-3.8-flash",
        displayName: "Gemini 3.8 Flash",
        supportsEffort: true,
        efforts: ["medium"],
      },
      { id: "gpt-oss-120b-medium", displayName: "GPT-OSS 120B (Medium)", supportsEffort: false },
    ]);
  });

  it("reads a turn's usage, cached input and thinking apart", () => {
    expect(
      promptUsage({
        usage: {
          inputTokens: 13746,
          outputTokens: 528,
          cachedReadTokens: 14225,
          cachedWriteTokens: 0,
          thoughtTokens: 323,
          totalTokens: 28499,
        },
      }),
    ).toEqual({
      inputTokens: 13746,
      outputTokens: 528,
      cacheReadTokens: 14225,
      reasoningTokens: 323,
    });
    expect(promptUsage({ stopReason: "end_turn" })).toBeUndefined();
  });

  it("draws its calls as Claude Code's cards, and Gram's app tools by their own name", () => {
    expect(toolFor("run_command", { CommandLine: "ls", toolSummary: "List" }, APP)).toEqual({
      name: "Bash",
      input: { command: "ls", description: "List" },
    });
    expect(toolFor("edit_file", { Path: "/w/a.ts", Target: "a", Replacement: "b" }, APP)).toEqual({
      name: "Edit",
      input: { file_path: "/w/a.ts", old_string: "a", new_string: "b" },
    });
    expect(
      toolFor(`mcp_${APP}_list_open_prs`, { toolSummary: "List PRs", repo: "x" }, APP),
    ).toEqual({ name: "mcp__gram__list_open_prs", input: { repo: "x" } });
  });
});

/** A stand-in `agy acp`: records what Gram sends and answers like the CLI does. */
const fakeAgent = (options: { signedOut?: boolean; promptFails?: AcpError } = {}) => {
  const started: Array<StartAcpAgent> = [];
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let handlers: AcpHandlers | undefined;
  let authenticated = false;
  const start = (input: StartAcpAgent): AcpConnection => {
    started.push(input);
    handlers = input.handlers;
    return {
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "authenticate") authenticated = true;
        if (options.signedOut === true && !authenticated && method.startsWith("session/"))
          throw new Error("error getting token source: You are not logged into Antigravity.");
        switch (method) {
          case "initialize":
            return { agentCapabilities: { sessionCapabilities: { resume: {} } } };
          case "session/new":
          case "session/resume":
            return SESSION_NEW;
          case "session/prompt": {
            if (options.promptFails !== undefined) throw options.promptFails;
            const sessionId = params["sessionId"];
            handlers!.notification("session/update", {
              sessionId,
              update: { sessionUpdate: "usage_update", used: 9431, size: 1048576 },
            });
            const answer = (await handlers!.request("session/request_permission", {
              sessionId,
              toolCall: command("curl example.com"),
              options: [
                { optionId: "allow", kind: "allow_once" },
                { optionId: "deny", kind: "reject_once" },
              ],
            })) as Record<string, unknown>;
            calls.push({ method: "answered", params: answer });
            return {
              stopReason: "end_turn",
              usage: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 50 },
            };
          }
          default:
            return {};
        }
      },
      notify: () => {},
      ended: new Promise(() => {}),
      pid: 1,
      stop: async () => {},
    };
  };
  return { started, calls, start };
};

const hostWith = (agent: ReturnType<typeof fakeAgent>, env: Record<string, string> = {}) =>
  makeAntigravityHost({
    binary: Effect.succeed("agy"),
    env: Effect.succeed(env),
    args: Effect.succeed(["--gemini-dir", "/data/antigravity-owned-home/.gemini"]),
    start: agent.start,
    newMessageId: () => MessageId.make("m1"),
  });

const turn = (
  agent: ReturnType<typeof fakeAgent>,
  {
    env,
    beforeSend,
    ...open
  }: Record<string, unknown> & { env?: Record<string, string>; beforeSend?: () => void } = {},
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const events: Array<AgentEvent> = [];
        const host = yield* hostWith(agent, env);
        const session = yield* host.open({
          threadId: ThreadId.make("t"),
          cwd: "/work",
          permissionMode: "default",
          ...open,
        });
        beforeSend?.();
        const turnEnded = yield* Deferred.make<void>();
        const fiber = yield* Stream.runForEach(session.events, (event) =>
          Effect.gen(function* () {
            events.push(event);
            if (event.type === "turnEnd") yield* Deferred.succeed(turnEnded, undefined);
            if (event.type === "request")
              yield* session.respond(event.request.id, {
                kind: "approval",
                decision: "allow",
                scope: "once",
              });
          }),
        ).pipe(Effect.forkScoped);
        yield* session.send({ text: "go" });
        yield* Deferred.await(turnEnded);
        yield* Fiber.interrupt(fiber);
        return events;
      }),
    ),
  );

describe("Antigravity host", () => {
  it("starts in Gram's mode and model, in its own config folder, and asks before a command", async () => {
    const agent = fakeAgent();
    const events = await turn(agent, {
      model: { agent: "antigravity", model: "gemini-3.8-flash", variant: "medium" },
    });
    expect(agent.started[0]?.args).toEqual([
      "acp",
      "--gemini-dir",
      "/data/antigravity-owned-home/.gemini",
    ]);
    const sent = agent.calls.map((call) => [call.method, call.params] as const);
    expect(sent).toContainEqual([
      "session/set_mode",
      { sessionId: "new-session", modeId: "default" },
    ]);
    expect(sent).toContainEqual([
      "session/set_config_option",
      { sessionId: "new-session", configId: "model", value: "gemini-3.8-flash" },
    ]);
    expect(sent).toContainEqual([
      "session/set_config_option",
      { sessionId: "new-session", configId: "thought_level", value: "medium" },
    ]);
    expect(events.some((event) => event.type === "request")).toBe(true);
    expect(agent.calls).toContainEqual({
      method: "answered",
      params: { outcome: { outcome: "selected", optionId: "allow" } },
    });
    expect(events.find((event) => event.type === "usage")).toEqual({
      type: "usage",
      tokens: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50 },
      contextTokens: 9431,
      contextWindow: 1048576,
    });
  });

  it("asks under the outward gate in Auto, and Gram answers a command the gate passes", async () => {
    const agent = fakeAgent();
    const events = await turn(agent, { permissionMode: "auto", outwardGate: "all" });
    expect(agent.calls.find((call) => call.method === "session/set_mode")?.params).toEqual({
      sessionId: "new-session",
      modeId: "default",
    });
    expect(events.some((event) => event.type === "request")).toBe(false);
  });

  it("gives a role's instructions to its system prompt, and the extra folders to the session", async () => {
    const agent = fakeAgent();
    await turn(agent, { instructions: "You are a worker.", additionalDirectories: ["/more"] });
    expect(agent.calls.find((call) => call.method === "session/new")?.params).toMatchObject({
      cwd: "/work",
      additionalDirectories: ["/more"],
      _meta: { antigravity: { systemPrompt: { append: "You are a worker." } } },
    });
  });

  it("resumes the thread's own session rather than starting another", async () => {
    const agent = fakeAgent();
    await turn(agent, { resumeId: "old-session" });
    const methods = agent.calls.map((call) => call.method);
    expect(methods).toContain("session/resume");
    expect(methods).not.toContain("session/new");
  });

  it("says in the thread when a signed-out desktop falls back on the Gemini API key", async () => {
    const agent = fakeAgent({ signedOut: true });
    const events = await turn(agent, { env: { GEMINI_API_KEY: "placeholder" } });
    expect(agent.calls.map((call) => call.method)).toContain("authenticate");
    expect(events).toContainEqual({ type: "notice", level: "warning", message: API_KEY_NOTICE });
  });

  it("ends a failed turn with what the provider answered, beside the CLI's own error", async () => {
    const refused = new AcpError(-32603, "Internal error", { message: "quota exhausted (429)" });
    const events = await turn(fakeAgent({ promptFails: refused }));
    expect(events.find((event) => event.type === "turnEnd")).toMatchObject({
      reason: "error",
      error: "Internal error: quota exhausted (429)",
    });
  });

  it("says to sign in with agy when a desktop has no sign-in", async () => {
    const agent = fakeAgent({ signedOut: true });
    const error = await turn(agent).catch((cause: unknown) => cause);
    expect(String(error)).toContain(SIGN_IN_MESSAGE);
    expect(agent.calls.map((call) => call.method)).not.toContain("authenticate");
  });
});

const recording = (signedOut: boolean) => {
  const methods: Array<string> = [];
  let authenticated = false;
  const connection: AcpConnection = {
    request: async (method: string) => {
      methods.push(method);
      if (method === "authenticate") authenticated = true;
      if (signedOut && !authenticated && method === "session/new")
        throw new Error("You are not logged into Antigravity.");
      return {};
    },
    notify: () => {},
    ended: new Promise(() => {}),
    pid: 1,
    stop: async () => {},
  };
  return { methods, connection };
};

describe("Antigravity in a sandbox", () => {
  it("signs in on the Gemini API key once a session needs a sign-in it lacks", async () => {
    const { methods, connection } = recording(true);
    const wrapped = withHeadlessSignIn(connection, { GEMINI_API_KEY: "placeholder" });
    await wrapped.request("initialize", {});
    await wrapped.request("session/new", {});
    expect(methods).toEqual(["initialize", "session/new", "authenticate", "session/new"]);
  });

  it("leaves a signed-in desktop on its own sign-in, whatever key the shell holds", async () => {
    const { methods, connection } = recording(false);
    const wrapped = withHeadlessSignIn(connection, { GEMINI_API_KEY: "placeholder" });
    await wrapped.request("initialize", {});
    await wrapped.request("session/new", {});
    expect(methods).toEqual(["initialize", "session/new"]);
  });
});
