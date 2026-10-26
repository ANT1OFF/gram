import { claudeUsage } from "../testing/subscription-limit-shapes.ts";
import type {
  CanUseTool,
  HookInput,
  HookJSONOutput,
  McpServerStatus,
  ModelInfo,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import {
  AgentUnavailable,
  AppToolError,
  RequestId,
  ThreadId,
  type AgentEvent,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Redacted from "effect/Redacted";
import { GatewayKeyProvider, type GatewayKeyProviderShape } from "../gateway.ts";
import type { AgentSession, AppTool, ConnectorsSeen, OpenSessionOptions } from "../host.ts";
import { APP_TOOL_SERVER } from "./apptools.ts";
import { PEER_MESSAGING_SWITCH, REFUSE_PEER_MESSAGES } from "./env.ts";
import {
  CLAUDE_SIGN_IN_AGAIN,
  CLAUDE_SIGN_IN_HINT,
  CLAUDEAI_BEARER_REJECTED,
  GATEWAY_CLAUDE_AI_NOTE,
  makeConnectors,
  nextLapsedConnectors,
  NO_LAPSED_CONNECTORS,
  seenServer,
  type SeenServer,
} from "./connectors.ts";
import { ClaudeEnvironment } from "./environment.ts";
import { AsyncPushQueue } from "./input-queue.ts";
import { ClaudeSdk, type ClaudeSdkShape } from "./sdk.ts";
import {
  BLOCKING_ASK_TOOL,
  claudeSettingsDir,
  widenedEntries,
  CONFINED_DISALLOWED,
  CONFINED_MCP,
  ClaudeHost,
  ClaudeHostLayer,
  IRREVERSIBLE_GATE_REASON,
  TOOL_GATE_REASON,
  MODELS_TTL_MS,
  OUTWARD_GATE_REASON,
  SHELL_OUTPUT_POLL_MS,
  SHELL_OUTPUT_READ_TIMEOUT_MS,
  SHELL_OUTPUT_TIMEOUTS,
  type ClaudeHostConfig,
} from "./session.ts";
import { fixtureMessages } from "./testing.ts";

/** An SDK task lifecycle message, trimmed to what the session reads. */
const task = (subtype: string, task_id: string, extra: object = {}) =>
  ({ type: "system", subtype, task_id, session_id: "s", uuid: task_id, ...extra }) as never;

/** The CLI's level of background tasks, as `background_tasks_changed` lists them. */
const listed = (...ids: Array<string>) =>
  ({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: ids.map((id) => ({ task_id: id, task_type: "local_bash", description: id })),
    session_id: "s",
    uuid: ids.join(),
  }) as never;

class FakeQuery {
  readonly output = new AsyncPushQueue<SDKMessage>();
  readonly inputs: Array<SDKUserMessage> = [];
  readonly calls: Array<string> = [];
  closed = false;
  initFails = false;
  initError = "the CLI exited";
  interruptResult: Promise<undefined> = Promise.resolve(undefined);
  /** Modes `setPermissionMode` rejects, as the CLI does for a mode the session can't enter. */
  refusedModes: ReadonlyArray<string> = [];

  readonly options: Options;

  constructor(options: Options, prompt: AsyncIterable<SDKUserMessage>) {
    this.options = options;
    void (async () => {
      for await (const message of prompt) this.inputs.push(message);
    })();
  }

  [Symbol.asyncIterator]() {
    return this.output[Symbol.asyncIterator]();
  }

  initializationResult() {
    if (this.initFails) return Promise.reject(new Error(this.initError));
    return Promise.resolve({
      commands: [{ name: "review", description: "Review a PR", argumentHint: "" }],
      agents: [],
      models: [],
      account: {},
    });
  }

  supportedModels() {
    this.calls.push("supportedModels");
    return Promise.resolve([
      {
        value: "default",
        displayName: "Default (recommended)",
        description: "Opus 5",
        supportsEffort: true,
        supportedEffortLevels: ["low", "high", "max"],
      },
      { value: "haiku", displayName: "Haiku", description: "" },
    ]);
  }

  stopTask(taskId: string) {
    this.calls.push(`stopTask:${taskId}`);
    // As the SDK does for a task that has already ended.
    return taskId === "gone" ? Promise.reject(new Error("no such task")) : Promise.resolve();
  }

  interrupt() {
    this.calls.push("interrupt");
    return this.interruptResult;
  }

  setPermissionMode(mode: string) {
    this.calls.push(`setPermissionMode:${mode}`);
    return this.refusedModes.includes(mode)
      ? Promise.reject(new Error(`Cannot set permission mode to ${mode}`))
      : Promise.resolve();
  }

  setModel(model?: string) {
    this.calls.push(`setModel:${model}`);
    return Promise.resolve();
  }

  applyFlagSettings(settings: Record<string, unknown>) {
    this.calls.push(`applyFlagSettings:${JSON.stringify(settings)}`);
    return Promise.resolve();
  }

  close() {
    this.closed = true;
    this.output.end();
  }

  canUseTool(...args: Parameters<CanUseTool>): Promise<PermissionResult> {
    const canUseTool = this.options.canUseTool;
    if (!canUseTool) throw new Error("no canUseTool");
    return canUseTool(...args) as Promise<PermissionResult>;
  }
}

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly handler: (args: unknown, extra: unknown) => Promise<unknown>;
  readonly extras?: { alwaysLoad?: boolean };
}

interface HarnessOptions {
  readonly config?: ClaudeHostConfig;
  /** Added to the environment the session runs in. */
  readonly env?: Readonly<Record<string, string>>;
  readonly warnings?: ReadonlyArray<string>;
  readonly auth?: Effect.Effect<void, AgentUnavailable>;
  /** Registers a gateway key provider, as the server does. */
  readonly gateway?: GatewayKeyProviderShape;
  /** The CLI writes this to stderr and exits during startup. */
  readonly startupStderr?: string;
  /** What the SDK's startup rejects with; with it, startup fails even without `startupStderr`. */
  readonly startupError?: string;
  /** The SDK's transcript reader; absent, the host reads no past sessions. */
  readonly sessionMessages?: NonNullable<ClaudeSdkShape["getSessionMessages"]>;
  /** The SDK's raw transcript reader; absent, the host reads no saved cost. */
  readonly transcript?: NonNullable<ClaudeSdkShape["importSessionToStore"]>;
  /** What `claude --version` reported; absent, it couldn't be read. */
  readonly cliVersion?: string;
  /** Stands in for each query's `supportedModels`, called with how many queries came before. */
  readonly supportedModels?: (index: number) => Promise<ReadonlyArray<ModelInfo>>;
  /** The query's `getTaskOutput`, which SDK 0.3.296 has but leaves out of `Query`; absent, none. */
  readonly usage?: () => Promise<unknown>;
  readonly taskOutput?: (taskId: string) => Promise<unknown>;
}

const harness = (options: HarnessOptions = {}) => {
  const queries: Array<FakeQuery> = [];
  const tools: Array<ToolDefinition> = [];
  let ids = 0;
  const sdk: ClaudeSdkShape = {
    query: ((params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => {
      const q = new FakeQuery(params.options ?? {}, params.prompt);
      const supported = options.supportedModels;
      if (supported !== undefined) {
        const index = queries.length;
        q.supportedModels = () => {
          q.calls.push("supportedModels");
          return supported(index) as ReturnType<FakeQuery["supportedModels"]>;
        };
      }
      if (options.usage !== undefined) {
        Object.assign(q, {
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: (opts: unknown) => {
            q.calls.push(`get_usage:${JSON.stringify(opts)}`);
            return options.usage!();
          },
        });
      }
      const taskOutput = options.taskOutput;
      if (taskOutput !== undefined) {
        Object.assign(q, {
          getTaskOutput: (taskId: string) => {
            q.calls.push(`getTaskOutput:${taskId}`);
            return taskOutput(taskId);
          },
        });
      }
      if (options.startupStderr !== undefined) {
        q.options.stderr?.(options.startupStderr);
        q.initFails = true;
      }
      if (options.startupError !== undefined) {
        q.initError = options.startupError;
        q.initFails = true;
      }
      queries.push(q);
      return q as unknown as Query;
    }) as ClaudeSdkShape["query"],
    tool: ((
      name: string,
      description: string,
      inputSchema: Record<string, unknown>,
      handler: ToolDefinition["handler"],
      extras?: ToolDefinition["extras"],
    ) => {
      const definition = { name, description, inputSchema, handler, ...(extras ? { extras } : {}) };
      tools.push(definition);
      return definition;
    }) as unknown as ClaudeSdkShape["tool"],
    createSdkMcpServer: ((o: { name: string }) => ({
      type: "sdk",
      name: o.name,
      instance: {},
    })) as unknown as ClaudeSdkShape["createSdkMcpServer"],
    version: "0.3.273",
    ...(options.sessionMessages === undefined
      ? {}
      : { getSessionMessages: options.sessionMessages }),
    ...(options.transcript === undefined ? {} : { importSessionToStore: options.transcript }),
  };
  const authChecks = { count: 0 };
  const layer = ClaudeHostLayer({ newId: () => `id-${++ids}`, ...options.config }).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ClaudeSdk)(sdk),
        Layer.succeed(ClaudeEnvironment)({
          invalidate: Effect.void,
          prepare: Effect.succeed({
            binaryPath: "/bin/claude",
            sdkExecutable: "/bin/claude",
            env: { PATH: "/bin", CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1", ...options.env },
            warnings: options.warnings ?? [],
            ...(options.cliVersion === undefined ? {} : { cliVersion: options.cliVersion }),
          }),
          checkAuth: () =>
            Effect.suspend(() => {
              authChecks.count += 1;
              return options.auth ?? Effect.void;
            }),
        }),
        ...(options.gateway === undefined
          ? []
          : [Layer.succeed(GatewayKeyProvider)(options.gateway)]),
      ),
    ),
  );
  return { queries, tools, layer, authChecks };
};

const openSession = (overrides: Partial<OpenSessionOptions> = {}) =>
  Effect.gen(function* () {
    const host = yield* ClaudeHost;
    return yield* host.open({ threadId: ThreadId.make("t1"), cwd: "/repo", ...overrides });
  });

const take = (session: AgentSession, n: number) =>
  Stream.runCollect(Stream.take(session.events, n));

/** Lets pending promise callbacks and the fake's input loop run. */
const settle = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

const query = (h: ReturnType<typeof harness>): FakeQuery => {
  const q = h.queries[0];
  if (!q) throw new Error("query not opened");
  return q;
};

const signal = () => new AbortController().signal;

/** A `PreToolUse` hook's answer that sends the call to `canUseTool`, as the gate gives it. */
const asksWith = (permissionDecisionReason: string) => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "ask",
    permissionDecisionReason,
  },
});

/** Two foreground Bash calls the CLI has registered as tasks `b1` and `b2`. */
const twoRunningShells = (): Array<SDKMessage> => [
  {
    type: "assistant",
    message: {
      id: "msg_two",
      role: "assistant",
      model: "m",
      content: [
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm test" } },
        { type: "tool_use", id: "t2", name: "Bash", input: { command: "pnpm build" } },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    parent_tool_use_id: null,
    session_id: "s",
    uuid: "a1",
  } as never,
  task("task_started", "b1", {
    tool_use_id: "t1",
    task_type: "local_bash",
    is_backgrounded: false,
  }),
  task("task_started", "b2", {
    tool_use_id: "t2",
    task_type: "local_bash",
    is_backgrounded: false,
  }),
];
const snapshotsIn = (events: ReadonlyArray<AgentEvent>) =>
  events.flatMap((e) =>
    e.type === "chunk" && e.chunk.type === "tool-output-available" && e.chunk.preliminary === true
      ? [`${e.chunk.toolCallId} ${JSON.stringify(e.chunk.output)}`]
      : [],
  );
const answerWith = (output: string) =>
  Promise.resolve({ output, total_bytes: output.length, truncated: false });
const never = () => new Promise<never>(() => {});

describe("ClaudeHost.open", () => {
  it.effect("advertises Claude's capabilities", () =>
    Effect.gen(function* () {
      const host = yield* ClaudeHost.pipe(Effect.provide(harness().layer));
      expect(host.capabilities).toEqual({
        fork: true,
        rewind: "historyAndFiles",
        steer: true,
        planMode: true,
        approvalScopes: ["once", "session", "always"],
        userQuestions: true,
        costReporting: true,
        perTurnModel: true,
        reasoningEffort: true,
        listSessions: true,
        subagentStreams: true,
        stopTasks: true,
      });
    }),
  );

  it.effect("passes adapter options and emits identity at warm-up", () =>
    Effect.gen(function* () {
      const h = harness({ warnings: ["version skew"] });
      const session = yield* openSession({
        permissionMode: "plan",
        model: { agent: "claude", model: "haiku" },
      }).pipe(Effect.provide(h.layer));
      const q = query(h);
      expect(q.options).toMatchObject({
        pathToClaudeCodeExecutable: "/bin/claude",
        env: { PATH: "/bin", CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" },
        cwd: "/repo",
        includePartialMessages: true,
        forwardSubagentText: true,
        permissionMode: "plan",
        allowDangerouslySkipPermissions: true,
        model: "haiku",
        sessionId: "id-1",
      });
      expect(q.options).not.toHaveProperty("settingSources");
      expect(q.options).not.toHaveProperty("resume");
      // An omitted mode asks for approvals: the SDK would otherwise leave it to Claude Code.
      const unset = harness();
      yield* openSession({}).pipe(Effect.provide(unset.layer));
      expect(query(unset).options.permissionMode).toBe("default");
      expect(yield* take(session, 3)).toEqual([
        { type: "notice", level: "warning", message: "version skew" },
        {
          type: "identity",
          agentSessionId: "id-1",
          model: "haiku",
          tools: [],
          commands: [{ name: "review", description: "Review a PR" }],
        },
        { type: "status", status: "idle" },
      ]);
    }),
  );

  it.effect("asks for Claude Code's prompt unsnapshotted, with role instructions appended", () =>
    Effect.gen(function* () {
      // Omitting `systemPrompt` would make the SDK send an empty custom prompt instead.
      const plain = harness();
      yield* openSession().pipe(Effect.provide(plain.layer));
      expect(query(plain).options.systemPrompt).toEqual({
        type: "preset",
        preset: "claude_code",
        snapshot: false,
      });

      const role = harness();
      yield* openSession({ instructions: "You dispatch; workers do.", resumeId: "sess-1" }).pipe(
        Effect.provide(role.layer),
      );
      // On a resume too: with the default snapshot the first open's text would be replayed.
      expect(query(role).options.systemPrompt).toEqual({
        type: "preset",
        preset: "claude_code",
        append: "You dispatch; workers do.",
        snapshot: false,
      });
    }),
  );

  it.effect("resumes in place, or forks under a new session id", () =>
    Effect.gen(function* () {
      const resumed = harness();
      const resumedSession = yield* openSession({ resumeId: "r1" }).pipe(
        Effect.provide(resumed.layer),
      );
      expect(query(resumed).options).toMatchObject({ resume: "r1" });
      expect(query(resumed).options).not.toHaveProperty("sessionId");
      expect((yield* take(resumedSession, 1))[0]).toMatchObject({ agentSessionId: "r1" });

      const forked = harness();
      const forkedSession = yield* openSession({ resumeId: "r1", fork: true }).pipe(
        Effect.provide(forked.layer),
      );
      expect(query(forked).options).toMatchObject({
        resume: "r1",
        forkSession: true,
        sessionId: "id-1",
      });
      expect((yield* take(forkedSession, 1))[0]).toMatchObject({ agentSessionId: "id-1" });
    }),
  );

  it.effect("counts a resumed session's cost from zero, off the total its transcript saved", () =>
    Effect.gen(function* () {
      const reads: Array<string> = [];
      const transcript: NonNullable<ClaudeSdkShape["importSessionToStore"]> = async (
        sessionId,
        store,
        options,
      ) => {
        reads.push(`${sessionId} in ${options?.dir}`);
        // As the SDK does for a directory that isn't the session's project.
        if (options?.dir === "/other") throw new Error(`Session ${sessionId} not found`);
        const key = { projectKey: "-repo", sessionId };
        await store.append(key, [{ type: "cost-state", sessionId, totalCostUSD: 1 }]);
        await store.append(key, [
          { type: "user", uuid: "u1" },
          { type: "cost-state", sessionId: "other", totalCostUSD: 9 },
          { type: "cost-state", sessionId, totalCostUSD: 1.25 },
        ]);
      };
      const costOf = (h: ReturnType<typeof harness>, open: Partial<OpenSessionOptions>) =>
        Effect.gen(function* () {
          const session = yield* openSession(open).pipe(Effect.provide(h.layer));
          yield* take(session, 2);
          const q = query(h);
          q.output.push({
            type: "result",
            subtype: "success",
            is_error: false,
            result: "",
            errors: [],
            usage: { input_tokens: 1, output_tokens: 2 },
            modelUsage: {},
            total_cost_usd: 1.5,
            permission_denials: [],
            session_id: "r1",
            uuid: "u",
          } as unknown as SDKMessage);
          q.close();
          const events = yield* Stream.runCollect(session.events);
          return events.flatMap((e) => (e.type === "usage" ? [e.costUsd] : []));
        });

      expect(yield* costOf(harness({ transcript }), { resumeId: "r1" })).toEqual([0.25]);
      expect(yield* costOf(harness({ transcript }), { resumeId: "r1", fork: true })).toEqual([
        0.25,
      ]);
      expect(reads).toEqual(["r1 in /repo", "r1 in /repo"]);
      // A fork into another worktree finds the source's transcript under its own checkout.
      const elsewhere = { resumeId: "r1", fork: true, cwd: "/other" } as const;
      expect(yield* costOf(harness({ transcript }), elsewhere)).toEqual([0.25]);
      expect(reads.slice(2)).toEqual(["r1 in /other", "r1 in undefined"]);
      reads.length = 2;
      // Claude Code before 2.1.277 counts a resumed session from zero itself.
      const old = harness({ transcript, cliVersion: "2.1.276" });
      expect(yield* costOf(old, { resumeId: "r1" })).toEqual([1.5]);
      expect(yield* costOf(harness({ transcript }), {})).toEqual([1.5]);
      expect(reads).toHaveLength(2);
    }),
  );

  it.effect("keeps a given session id for a fresh open and for a fork", () =>
    Effect.gen(function* () {
      const fresh = harness();
      const freshSession = yield* openSession({ sessionId: "kept-1" }).pipe(
        Effect.provide(fresh.layer),
      );
      expect(query(fresh).options).toMatchObject({ sessionId: "kept-1" });
      expect(query(fresh).options).not.toHaveProperty("resume");
      expect((yield* take(freshSession, 1))[0]).toMatchObject({ agentSessionId: "kept-1" });

      const forked = harness();
      yield* openSession({ resumeId: "r1", fork: true, sessionId: "kept-2" }).pipe(
        Effect.provide(forked.layer),
      );
      expect(query(forked).options).toMatchObject({
        resume: "r1",
        forkSession: true,
        sessionId: "kept-2",
      });
    }),
  );

  it.effect("passes explicit setting sources", () =>
    Effect.gen(function* () {
      const h = harness({ config: { settingSources: [] } });
      yield* openSession().pipe(Effect.provide(h.layer));
      expect(query(h).options.settingSources).toEqual([]);
    }),
  );

  it.effect("reports a resume without a transcript as session-not-found", () =>
    Effect.gen(function* () {
      const missing = harness({ startupStderr: "No conversation found with session ID: r1" });
      const error = yield* openSession({ resumeId: "r1" }).pipe(
        Effect.provide(missing.layer),
        Effect.flip,
      );
      expect(error).toMatchObject({ _tag: "AgentUnavailable", reason: "session-not-found" });

      const other = harness({ startupStderr: "Segmentation fault" });
      const failed = yield* openSession({ resumeId: "r1" }).pipe(
        Effect.provide(other.layer),
        Effect.flip,
      );
      expect(failed).toMatchObject({ _tag: "AgentUnavailable", reason: "startup-failed" });
    }),
  );

  it.effect("names a thread folder that is gone rather than the SDK's binary", () =>
    Effect.gen(function* () {
      const h = harness({
        startupError: "Claude Code native binary at /bin/claude exists but failed to launch.",
      });
      const error = yield* openSession({ cwd: "/no/such/worktree" }).pipe(
        Effect.provide(h.layer),
        Effect.flip,
      );
      expect(error).toMatchObject({
        reason: "startup-failed",
        message:
          "Claude Code didn't start: the thread's folder no longer exists: /no/such/worktree",
      });
    }),
  );

  it.effect("fails before spawning when auth isn't a subscription login", () =>
    Effect.gen(function* () {
      const h = harness({
        auth: Effect.fail(new AgentUnavailable({ agent: "claude", message: "api-key-auth: nope" })),
      });
      const error = yield* Effect.flip(openSession().pipe(Effect.provide(h.layer)));
      expect(error).toBeInstanceOf(AgentUnavailable);
      expect(error.message).toBe("api-key-auth: nope");
      expect(h.queries).toEqual([]);
    }),
  );
});

describe("ClaudeHost on a gateway profile", () => {
  const KEY = "sk-gateway-session-key";
  const profileId = "litellm" as NonNullable<NonNullable<OpenSessionOptions["model"]>["profileId"]>;
  const provider: GatewayKeyProviderShape = {
    credentials: (id, agent) =>
      id === profileId
        ? Effect.succeed({
            profile: {
              id: profileId,
              name: "LiteLLM",
              baseURL: "http://litellm:4000/v1",
              keyRef: "profile:litellm",
              models: [
                { id: "opus-latest", name: "opus-latest" },
                { id: "sonnet-latest", name: "sonnet-latest" },
                { id: "a-claude-haiku-4.5", name: "a-claude-haiku-4.5" },
                { id: "claude-opus-5.5-eu", name: "EU Opus", info: { webSearch: false } },
                { id: "claude-opus-5.5", name: "Bedrock Opus", info: { webSearch: false } },
                { id: "claude-haiku-4.5-eu", name: "EU Haiku", info: { webSearch: false } },
              ],
            },
            key: Redacted.make(KEY),
          })
        : Effect.fail(
            new AgentUnavailable({ agent, message: `Gateway profile ${id} isn't configured.` }),
          ),
  };
  const gatewayModel = { agent: "claude", model: "claude-opus-4-8", profileId } as const;
  const subscriptionLock = Effect.fail(
    new AgentUnavailable({
      agent: "claude",
      reason: "api-key-auth",
      message: "not a subscription",
    }),
  );

  it.effect("keeps the subscription guard and strip for a thread without a profile", () =>
    Effect.gen(function* () {
      const h = harness({ gateway: provider });
      yield* openSession({ model: { agent: "claude", model: "haiku" } }).pipe(
        Effect.provide(h.layer),
      );
      expect(h.authChecks.count).toBe(1);
      const env = query(h).options.env ?? {};
      for (const name of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
        expect(env).not.toHaveProperty(name);
      }
    }),
  );

  it.effect("runs `claude` against the gateway with the key only in the child env", () =>
    Effect.gen(function* () {
      // A failing subscription guard must not stop a gateway thread.
      const h = harness({ gateway: provider, auth: subscriptionLock });
      yield* openSession({ model: gatewayModel }).pipe(Effect.provide(h.layer));
      expect(h.authChecks.count).toBe(0);
      const q = query(h);
      expect(q.options.env).toEqual({
        PATH: "/bin",
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
        ANTHROPIC_BASE_URL: "http://litellm:4000",
        ANTHROPIC_AUTH_TOKEN: KEY,
        ANTHROPIC_API_KEY: KEY,
        // Subagents and background jobs ask for these aliases; the gateway has no fable route.
        ANTHROPIC_DEFAULT_OPUS_MODEL: "opus-latest",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet-latest",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "a-claude-haiku-4.5",
        ANTHROPIC_DEFAULT_FABLE_MODEL: "claude-opus-4-8",
        ANTHROPIC_SMALL_FAST_MODEL: "a-claude-haiku-4.5",
      });
      expect(q.options.model).toBe("claude-opus-4-8");
      expect(q.options).not.toHaveProperty("disallowedTools");
      const { env: _env, ...rest } = q.options;
      expect(JSON.stringify(rest)).not.toContain(KEY);
    }),
  );

  it.effect("gives an orchestrator listing none every server only where tool search is on", () =>
    Effect.gen(function* () {
      const lean = { audience: "orchestrator", mcpNoneWithoutToolSearch: true } as const;
      // The gateway's base URL turns tool search off, so it takes none of the user's servers.
      const onGateway = harness({ gateway: provider });
      const gatewaySession = yield* openSession({
        ...lean,
        model: gatewayModel,
        mcpDenylist: ["parse"],
      }).pipe(Effect.provide(onGateway.layer));
      expect(query(onGateway).options.settings).toEqual({
        ...REFUSE_PEER_MESSAGES,
        allowedMcpServers: [],
        deniedMcpServers: [{ serverName: "parse" }],
      });
      expect(gatewaySession.connectors?.allowlist).toEqual([]);

      // On the subscription it searches, so only the workspace's lists hold it.
      const own = harness();
      const ownSession = yield* openSession(lean).pipe(Effect.provide(own.layer));
      expect(query(own).options.settings).toEqual(REFUSE_PEER_MESSAGES);
      expect(ownSession.connectors).not.toHaveProperty("allowlist");
      const narrowed = harness();
      yield* openSession({ ...lean, mcpAllowlist: ["parse"] }).pipe(Effect.provide(narrowed.layer));
      expect(query(narrowed).options.settings).toEqual({
        ...REFUSE_PEER_MESSAGES,
        allowedMcpServers: [{ serverName: "parse" }],
      });

      // Search forced off in the user's env makes a subscription session as lean as a gateway's.
      const forcedOff = harness({ env: { ENABLE_TOOL_SEARCH: "false" } });
      yield* openSession(lean).pipe(Effect.provide(forcedOff.layer));
      expect(query(forcedOff).options.settings).toEqual({
        ...REFUSE_PEER_MESSAGES,
        allowedMcpServers: [],
      });
      // Forced on, a gateway session searches and keeps the user's servers.
      const forcedOn = harness({ gateway: provider, env: { ENABLE_TOOL_SEARCH: "true" } });
      yield* openSession({ ...lean, model: gatewayModel }).pipe(Effect.provide(forcedOn.layer));
      expect(query(forcedOn).options.settings).toEqual(REFUSE_PEER_MESSAGES);
    }),
  );

  it.effect("reopens rather than switch live across the EU data-zone boundary", () =>
    Effect.gen(function* () {
      const h = harness({ gateway: provider });
      const session = yield* openSession({ model: { ...gatewayModel, model: "opus-latest" } }).pipe(
        Effect.provide(h.layer),
      );
      expect(session.needsReopenFor?.("claude-opus-5.5-eu")).toBe(true);
      expect(session.needsReopenFor?.("sonnet-latest")).toBe(false);
      // Same zone, but Bedrock has no hosted web search, so the WebSearch setting has to change.
      expect(session.needsReopenFor?.("claude-opus-5.5")).toBe(true);

      const own = harness();
      const subscription = yield* openSession({ model: { agent: "claude", model: "opus" } }).pipe(
        Effect.provide(own.layer),
      );
      expect(subscription.needsReopenFor?.("claude-opus-5.5-eu")).toBe(false);
      // The gateway key keeps claude.ai connectors out, and the panel says why.
      expect(session.connectors?.claudeAiUnavailable).toBe(GATEWAY_CLAUDE_AI_NOTE);
      expect(subscription.connectors).not.toHaveProperty("claudeAiUnavailable");
    }),
  );

  it.effect("keeps an EU thread's subagents on EU routes, without hosted web search", () =>
    Effect.gen(function* () {
      const h = harness({ gateway: provider });
      yield* openSession({ model: { ...gatewayModel, model: "claude-opus-5.5-eu" } }).pipe(
        Effect.provide(h.layer),
      );
      const q = query(h);
      expect(q.options.env).toMatchObject({
        ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5.5-eu",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-opus-5.5-eu",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4.5-eu",
        ANTHROPIC_SMALL_FAST_MODEL: "claude-haiku-4.5-eu",
      });
      expect(q.options.disallowedTools).toEqual(["WebSearch"]);
    }),
  );

  it.effect("stays open when the gateway thread's init reports its API key", () =>
    Effect.gen(function* () {
      const h = harness({ gateway: provider });
      const session = yield* openSession({ model: gatewayModel }).pipe(Effect.provide(h.layer));
      yield* take(session, 2);
      const q = query(h);
      // A real recorded turn, with the CLI reporting the gateway key it was handed.
      for (const message of fixtureMessages("p03-session-state-with")) {
        q.output.push(
          message.type === "system" && message.subtype === "init"
            ? ({ ...message, apiKeySource: "ANTHROPIC_API_KEY" } as SDKMessage)
            : message,
        );
      }
      q.output.end();
      const events = yield* Stream.runCollect(session.events);
      expect(events.some((e) => e.type === "turnEnd")).toBe(true);
      expect(events.some((e) => e.type === "notice" && e.level === "error")).toBe(false);
      expect(events.at(-1)).toEqual({ type: "ended", reason: "exited" });
      expect(JSON.stringify(events)).not.toContain(KEY);
    }),
  );

  it.effect("fails without a provider or for a profile the provider refuses", () =>
    Effect.gen(function* () {
      const none = harness();
      const unavailable = yield* Effect.flip(
        openSession({ model: gatewayModel }).pipe(Effect.provide(none.layer)),
      );
      expect(unavailable).toBeInstanceOf(AgentUnavailable);
      expect(unavailable.message).toContain("Gateway profiles aren't available");
      expect(none.queries).toEqual([]);

      const refused = harness({ gateway: provider });
      const other = { ...gatewayModel, profileId: "other" as typeof profileId };
      const error = yield* Effect.flip(
        openSession({ model: other }).pipe(Effect.provide(refused.layer)),
      );
      expect(error.message).toBe("Gateway profile other isn't configured.");
      expect(refused.queries).toEqual([]);

      const noModel = harness({ gateway: provider });
      const empty = yield* Effect.flip(
        openSession({ model: { ...gatewayModel, model: "" } }).pipe(Effect.provide(noModel.layer)),
      );
      expect(empty).toBeInstanceOf(AgentUnavailable);
      expect(empty.message).toContain("Pick a model for LiteLLM");
      expect(noModel.queries).toEqual([]);
    }),
  );

  it.effect("masks the key in startup errors built from the CLI's stderr", () =>
    Effect.gen(function* () {
      const h = harness({
        gateway: provider,
        startupStderr: `401 Unauthorized: invalid key ${KEY}`,
      });
      const error = yield* Effect.flip(
        openSession({ model: gatewayModel }).pipe(Effect.provide(h.layer)),
      );
      expect(error.message).toContain("401 Unauthorized: invalid key [redacted]");
      expect(error.message).not.toContain(KEY);
    }),
  );
});

const ids = (models: ReadonlyArray<{ readonly id: string }>) => models.map((m) => m.id);

describe("ClaudeHost resumeAt and listModels", () => {
  it.effect("passes resumeAt through as resumeSessionAt, with or without fork", () =>
    Effect.gen(function* () {
      const resumed = harness();
      yield* openSession({ resumeId: "r1", resumeAt: "msg-uuid" }).pipe(
        Effect.provide(resumed.layer),
      );
      expect(query(resumed).options).toMatchObject({ resume: "r1", resumeSessionAt: "msg-uuid" });

      const forked = harness();
      yield* openSession({ resumeId: "r1", fork: true, resumeAt: "msg-uuid" }).pipe(
        Effect.provide(forked.layer),
      );
      expect(query(forked).options).toMatchObject({
        resume: "r1",
        forkSession: true,
        resumeSessionAt: "msg-uuid",
      });

      const fresh = harness();
      yield* openSession({ resumeAt: "msg-uuid" }).pipe(Effect.provide(fresh.layer));
      expect(query(fresh).options).not.toHaveProperty("resumeSessionAt");
    }),
  );

  it.effect("lists models from a short-lived query and caches the result", () =>
    Effect.gen(function* () {
      const h = harness();
      const [first, second] = yield* Effect.gen(function* () {
        const host = yield* ClaudeHost;
        return [yield* host.listModels(), yield* host.listModels()] as const;
      }).pipe(Effect.provide(h.layer));
      expect(first).toEqual([
        {
          id: "default",
          displayName: "Default (recommended)",
          description: "Opus 5",
          supportsEffort: true,
          efforts: ["low", "high", "max"],
          isDefault: true,
        },
        { id: "haiku", displayName: "Haiku", supportsEffort: false },
      ]);
      expect(second).toBe(first);
      expect(h.queries).toHaveLength(1);
      const q = query(h);
      expect(q.calls).toEqual(["supportedModels"]);
      expect(q.closed).toBe(true);
      expect(q.options).toMatchObject({ pathToClaudeCodeExecutable: "/bin/claude" });
      // It connects no MCP server: not the user's, a project's, nor a claude.ai connector.
      expect(q.options).toMatchObject({
        strictMcpConfig: true,
        env: expect.objectContaining({ ENABLE_CLAUDEAI_MCP_SERVERS: "false" }),
      });
      expect(q.options).not.toHaveProperty("mcpServers");
    }),
  );

  it.effect(
    "does not offer an old account's models after subscription authentication is withdrawn",
    () =>
      Effect.gen(function* () {
        let signedOut = false;
        const h = harness({
          auth: Effect.suspend(() =>
            signedOut
              ? Effect.fail(
                  new AgentUnavailable({
                    agent: "claude",
                    reason: "not-logged-in",
                    message: "Sign in again",
                  }),
                )
              : Effect.void,
          ),
        });
        yield* Effect.gen(function* () {
          const host = yield* ClaudeHost;
          expect(yield* host.listModels()).toHaveLength(2);
          signedOut = true;
          yield* TestClock.adjust(MODELS_TTL_MS);
          const error = yield* Effect.flip(host.listModels());
          expect(error.reason).toBe("not-logged-in");
          expect(h.queries).toHaveLength(1);
        }).pipe(Effect.provide(h.layer));
      }),
  );

  it.effect("asks the account again once its listing is stale, keeping it if that fails", () =>
    Effect.gen(function* () {
      const mythos = {
        value: "claude-mythos-5-1",
        displayName: "Mythos",
        description: "Mythos 5.1",
      };
      const opus = { value: "opus", displayName: "Opus", description: "" };
      const h = harness({
        supportedModels: (index) =>
          index === 0
            ? Promise.resolve([opus])
            : index === 1
              ? Promise.resolve([opus, mythos])
              : Promise.reject(new Error("offline")),
      });
      yield* Effect.gen(function* () {
        const host = yield* ClaudeHost;
        expect(ids(yield* host.listModels())).toEqual(["opus"]);
        yield* TestClock.adjust(MODELS_TTL_MS - 1);
        expect(ids(yield* host.listModels())).toEqual(["opus"]);
        expect(h.queries).toHaveLength(1);
        // The account was granted Mythos meanwhile.
        yield* TestClock.adjust(1);
        expect(ids(yield* host.listModels())).toEqual(["opus", "claude-mythos-5-1"]);
        // A failed refresh serves the last list the account gave, not a guess.
        yield* TestClock.adjust(MODELS_TTL_MS);
        expect(ids(yield* host.listModels())).toEqual(["opus", "claude-mythos-5-1"]);
        expect(h.queries).toHaveLength(3);
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect("fails a first listing that fails, and asks afresh after a CLI update or restart", () =>
    Effect.gen(function* () {
      const h = harness({
        supportedModels: (index) =>
          index === 0
            ? Promise.reject(new Error("offline"))
            : Promise.resolve([{ value: "opus", displayName: "Opus", description: "" }]),
      });
      yield* Effect.gen(function* () {
        const host = yield* ClaudeHost;
        // No list to fall back on: the UI falls back to its aliases, never to an invented model.
        const error = yield* Effect.flip(host.listModels());
        expect(error.message).toContain("Couldn't list Claude models");
        yield* host.listModels();
        yield* host.invalidateRuntime ?? Effect.void;
        yield* host.listModels();
        expect(h.queries).toHaveLength(3);
        // So does a session restart that re-reads the settings.
        yield* host.reloadConfig?.(undefined) ?? Effect.void;
        yield* host.listModels();
        expect(h.queries).toHaveLength(4);
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect("doesn't keep a listing that was under way when the CLI changed", () =>
    Effect.gen(function* () {
      let answer: ((models: ReadonlyArray<ModelInfo>) => void) | undefined;
      const h = harness({
        supportedModels: (index) =>
          index === 0
            ? new Promise((resolve) => {
                answer = resolve;
              })
            : Promise.resolve([{ value: "sonnet", displayName: "Sonnet", description: "" }]),
      });
      yield* Effect.gen(function* () {
        const host = yield* ClaudeHost;
        const stale = yield* Effect.forkScoped(host.listModels());
        yield* Effect.yieldNow;
        yield* host.invalidateRuntime ?? Effect.void;
        answer?.([{ value: "opus", displayName: "Opus", description: "" }]);
        expect(ids(yield* Fiber.join(stale))).toEqual(["opus"]);
        expect(ids(yield* host.listModels())).toEqual(["sonnet"]);
        expect(h.queries).toHaveLength(2);
      }).pipe(Effect.scoped, Effect.provide(h.layer));
    }),
  );

  it.effect("guards model listing with the auth check", () =>
    Effect.gen(function* () {
      const h = harness({
        auth: Effect.fail(
          new AgentUnavailable({ agent: "claude", reason: "api-key-auth", message: "nope" }),
        ),
      });
      const error = yield* Effect.flip(
        Effect.gen(function* () {
          const host = yield* ClaudeHost;
          return yield* host.listModels();
        }).pipe(Effect.provide(h.layer)),
      );
      expect(error.reason).toBe("api-key-auth");
      expect(h.queries).toEqual([]);
    }),
  );
});

describe("AgentSession", () => {
  it.effect("sends a caller-provided message id as the SDK uuid", () =>
    Effect.gen(function* () {
      const h = harness();
      const session = yield* openSession().pipe(Effect.provide(h.layer));
      const messageId = "3cb155ca-47ff-428f-aabd-c2e739639053";
      yield* session.send({ text: "hi" }, { messageId });
      yield* settle;
      expect(query(h).inputs).toEqual([
        {
          type: "user",
          message: { role: "user", content: "hi" },
          parent_tool_use_id: null,
          uuid: messageId,
        },
      ]);
      const exit = yield* Effect.exit(session.send({ text: "hi" }, { messageId: "user-turn-1" }));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("sends turns and steers with priority now", () =>
    Effect.gen(function* () {
      const h = harness();
      const session = yield* openSession().pipe(Effect.provide(h.layer));
      yield* session.send({ text: "hi", attachments: [{ path: "/a.png" }, { path: "/b c.txt" }] });
      yield* session.steer({ text: "stop and do this" });
      yield* settle;
      expect(query(h).inputs).toEqual([
        {
          type: "user",
          message: { role: "user", content: 'hi\n\n@/a.png @"/b c.txt"' },
          parent_tool_use_id: null,
        },
        {
          type: "user",
          message: { role: "user", content: "stop and do this" },
          parent_tool_use_id: null,
          priority: "now",
        },
      ]);
    }),
  );

  it.effect("maps SDK messages into events and ends when the query does", () =>
    Effect.gen(function* () {
      const h = harness();
      const session = yield* openSession().pipe(Effect.provide(h.layer));
      yield* take(session, 2);
      const q = query(h);
      for (const message of fixtureMessages("p03-session-state-with")) q.output.push(message);
      q.output.end();
      const events = yield* Stream.runCollect(session.events);
      // Two usage reports: the turn's one request as it lands, then the result's total.
      expect(
        events
          .filter((e) => e.type !== "chunk")
          .map((e) => (e.type === "status" ? `status:${e.status}` : e.type)),
      ).toEqual([
        "status:running",
        "speed",
        "identity",
        "mode",
        "usage",
        "speed",
        "usage",
        "turnEnd",
        "status:idle",
        "ended",
      ]);
      expect(events.at(-1)).toEqual({ type: "ended", reason: "exited" });
    }),
  );

  it.effect("keeps a priority-now abort and its continuation in one logical turn", () =>
    Effect.gen(function* () {
      const h = harness();
      const session = yield* openSession().pipe(Effect.provide(h.layer));
      yield* take(session, 2);
      yield* session.send({ text: "work" });
      yield* session.steer({ text: "updated context" });
      const q = query(h);
      const messages = fixtureMessages("p03-session-state-with");
      const result = messages.find((m) => m.type === "result")!;
      q.output.push({ ...result, terminal_reason: "aborted_tools" } as SDKMessage);
      q.output.push(task("session_state_changed", "idle-1", { state: "idle" }));
      // A second update during the continuation also aborts only the SDK iteration.
      yield* settle;
      yield* session.steer({ text: "one more update" });
      q.output.push({ ...result, terminal_reason: "aborted_streaming" } as SDKMessage);
      for (const message of messages) q.output.push(message);
      q.output.end();
      const events = yield* Stream.runCollect(session.events);
      expect(events.filter((e) => e.type === "turnEnd")).toEqual([
        { type: "turnEnd", reason: "completed" },
      ]);
      expect(events.filter((e) => e.type === "status" && e.status === "idle")).toHaveLength(1);
      expect(events.filter((e) => e.type === "usage").at(-1)).toMatchObject({
        tokens: { inputTokens: 30, outputTokens: 114, cacheReadTokens: 42990 },
      });
    }),
  );

  it.effect("an explicit stop still ends a steered turn", () =>
    Effect.gen(function* () {
      const h = harness();
      const session = yield* openSession().pipe(Effect.provide(h.layer));
      yield* take(session, 2);
      yield* session.steer({ text: "context" });
      yield* session.interrupt;
      const q = query(h);
      const result = fixtureMessages("p03-session-state-with").find((m) => m.type === "result")!;
      q.output.push({ ...result, terminal_reason: "aborted_tools" } as SDKMessage);
      q.output.end();
      expect(
        (yield* Stream.runCollect(session.events)).filter((e) => e.type === "turnEnd"),
      ).toEqual([{ type: "turnEnd", reason: "interrupted" }]);
    }),
  );

  it.effect("accumulates steering usage across results and result-less idles, then resets", () =>
    Effect.gen(function* () {
      const h = harness();
      const session = yield* openSession().pipe(Effect.provide(h.layer));
      yield* take(session, 2);
      const q = query(h);
      const messages = fixtureMessages("p03-session-state-with");
      const assistant = messages.find((m) => m.type === "assistant")!;
      const result = messages.find((m) => m.type === "result")!;
      if (assistant.type !== "assistant" || result.type !== "result") return;
      const reply = (id: string, input: number, output: number) =>
        ({
          ...assistant,
          message: {
            ...assistant.message,
            id,
            usage: {
              input_tokens: input,
              output_tokens: output,
              cache_read_input_tokens: 7,
              cache_creation_input_tokens: 2,
            },
          },
        }) as SDKMessage;
      const end = (input: number, output: number, cost: number, aborted = false) =>
        ({
          ...result,
          terminal_reason: aborted ? "aborted_tools" : "completed",
          total_cost_usd: cost,
          usage: {
            input_tokens: input,
            output_tokens: output,
            cache_read_input_tokens: 7,
            cache_creation_input_tokens: 2,
          },
        }) as SDKMessage;
      const events: AgentEvent[] = [];
      const collecting = yield* Effect.forkScoped(
        Stream.runForEach(session.events, (event) => Effect.sync(() => void events.push(event))),
      );
      yield* session.send({ text: "work" });
      yield* session.steer({ text: "update" });
      q.output.push(reply("a", 2, 3));
      q.output.push(end(4, 5, 0.1, true));
      q.output.push(reply("b", 10, 11));
      yield* settle;
      yield* session.steer({ text: "update again" });
      q.output.push(task("session_state_changed", "idle", { state: "idle" }));
      q.output.push(reply("c", 20, 21));
      q.output.push(end(22, 23, 0.3));
      yield* settle;
      const usage = events.filter((e) => e.type === "usage");
      expect(usage.map((e) => [e.tokens.inputTokens, e.tokens.outputTokens])).toEqual([
        [2, 3],
        [4, 5],
        [14, 16],
        [34, 37],
        [36, 39],
      ]);
      expect(usage.at(-1)).toMatchObject({
        tokens: { cacheReadTokens: 21, cacheWriteTokens: 6 },
        costUsd: 0.3,
        contextTokens: 29,
      });
      yield* session.send({ text: "next turn" });
      q.output.push(reply("d", 1, 2));
      q.output.push(end(1, 2, 0.4));
      q.output.end();
      yield* Fiber.join(collecting);
      expect(events.filter((e) => e.type === "usage").at(-1)).toMatchObject({
        tokens: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 7, cacheWriteTokens: 2 },
        costUsd: 0.4,
      });
      expect(events.filter((e) => e.type === "turnEnd")).toHaveLength(2);
    }),
  );

  it.effect(
    "bounds a result-less steering idle despite unrelated events and tracks a late reply",
    () =>
      Effect.gen(function* () {
        const h = harness();
        const session = yield* openSession().pipe(Effect.provide(h.layer));
        yield* take(session, 2);
        const q = query(h);
        const messages = fixtureMessages("p03-session-state-with");
        const events: AgentEvent[] = [];
        const collecting = yield* Effect.forkScoped(
          Stream.runForEach(session.events, (event) => Effect.sync(() => void events.push(event))),
        );
        yield* session.send({ text: "work" });
        for (const message of messages.filter((m) => m.type === "assistant"))
          q.output.push(message);
        yield* settle;
        yield* session.steer({ text: "context" });
        q.output.push(task("session_state_changed", "idle", { state: "idle" }));
        yield* settle;
        yield* TestClock.adjust("30 seconds");
        q.output.push(task("thinking_tokens", "tokens", { estimated_tokens: 1 }));
        yield* settle;
        expect(events.filter((e) => e.type === "turnEnd")).toHaveLength(0);
        yield* TestClock.adjust("30 seconds");
        yield* settle;
        expect(events.filter((e) => e.type === "turnEnd")).toEqual([
          { type: "turnEnd", reason: "interrupted" },
        ]);
        for (const message of messages) q.output.push(message);
        q.output.end();
        yield* Fiber.join(collecting);
        expect(
          events.filter((e) => e.type === "chunk" && e.chunk.type === "start").at(-1),
        ).toMatchObject({ chunk: { messageMetadata: { initiator: "agent" } } });
        expect(events.filter((e) => e.type === "turnEnd")).toHaveLength(2);
        const usage = events.filter((e) => e.type === "usage");
        expect(usage.at(-1)?.tokens).toEqual({
          inputTokens: 10,
          outputTokens: 38,
          cacheReadTokens: 14330,
          cacheWriteTokens: 0,
          reasoningTokens: 32,
        });
      }),
  );

  it.effect(
    "ends a dropped steering continuation, and consumes a late reply without losing it",
    () =>
      Effect.gen(function* () {
        const h = harness();
        const session = yield* openSession().pipe(Effect.provide(h.layer));
        yield* take(session, 2);
        yield* session.steer({ text: "context" });
        const q = query(h);
        const messages = fixtureMessages("p03-session-state-with");
        const result = messages.find((m) => m.type === "result")!;
        q.output.push({ ...result, terminal_reason: "aborted_tools" } as SDKMessage);
        yield* settle;
        const events: AgentEvent[] = [];
        const collecting = yield* Effect.forkScoped(
          Stream.runForEach(session.events, (event) => Effect.sync(() => void events.push(event))),
        );
        yield* TestClock.adjust("1 minute");
        yield* settle;
        expect(events.filter((e) => e.type === "turnEnd")).toEqual([
          { type: "turnEnd", reason: "interrupted" },
        ]);
        for (const message of messages) q.output.push(message);
        q.output.end();
        yield* Fiber.join(collecting);
        expect(events.filter((e) => e.type === "turnEnd")).toHaveLength(2);
        expect(events.some((e) => e.type === "chunk")).toBe(true);
        expect(events.find((e) => e.type === "chunk" && e.chunk.type === "start")).toMatchObject({
          chunk: { messageMetadata: { initiator: "agent" } },
        });
      }),
  );

  it.effect("gives the main agent's compaction marker its PostCompact summary", () =>
    Effect.gen(function* () {
      const h = harness();
      const session = yield* openSession().pipe(Effect.provide(h.layer));
      yield* take(session, 2);
      const q = query(h);
      const postCompact = q.options.hooks!.PostCompact![0]!.hooks[0]!;
      const compacted = (summary: string, extra: object = {}) =>
        Effect.promise(() =>
          postCompact(
            {
              hook_event_name: "PostCompact",
              session_id: "s",
              transcript_path: "/t",
              cwd: "/repo",
              trigger: "auto",
              compact_summary: summary,
              ...extra,
            } as HookInput,
            undefined,
            { signal: signal() },
          ),
        );
      // A subagent compacting its own conversation isn't the thread's.
      yield* compacted("<summary>The subagent's.</summary>", {
        agent_id: "a1",
        agent_type: "general",
      });
      yield* compacted("<analysis>notes</analysis><summary>The thread's.</summary>");
      q.output.push({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 150_000, post_tokens: 20_000 },
        uuid: "c1",
        session_id: "s",
      } as unknown as SDKMessage);
      const [, marker] = yield* take(session, 2);
      expect(marker).toMatchObject({
        type: "chunk",
        chunk: {
          type: "data-compaction",
          data: {
            trigger: "auto",
            preTokens: 150_000,
            postTokens: 20_000,
            summary: "The thread's.",
          },
        },
      });
    }),
  );

  it.effect("names who started the main agent's compaction from its PreCompact hook", () =>
    Effect.gen(function* () {
      const h = harness();
      const session = yield* openSession().pipe(Effect.provide(h.layer));
      yield* take(session, 2);
      const q = query(h);
      const preCompact = q.options.hooks!.PreCompact![0]!.hooks[0]!;
      const compacting = (extra: object = {}) =>
        Effect.promise(() =>
          preCompact(
            {
              hook_event_name: "PreCompact",
              session_id: "s",
              transcript_path: "/t",
              cwd: "/repo",
              trigger: "manual",
              custom_instructions: null,
              ...extra,
            } as HookInput,
            undefined,
            { signal: signal() },
          ),
        );
      q.output.push({
        type: "system",
        subtype: "status",
        status: "compacting",
        uuid: "st1",
        session_id: "s",
      } as unknown as SDKMessage);
      const [started] = yield* take(session, 1);
      expect(started).toMatchObject({ type: "status", status: "compacting" });
      expect(started).not.toHaveProperty("compaction.trigger");
      // A subagent compacting its own conversation isn't the thread's.
      yield* compacting({ agent_id: "a1", agent_type: "general" });
      yield* compacting();
      const [named] = yield* take(session, 1);
      expect(named).toMatchObject({
        type: "status",
        status: "compacting",
        compaction: { trigger: "manual" },
      });
    }),
  );

  it.effect("tells which claude.ai connectors lapsed from one system/init to the next", () =>
    Effect.gen(function* () {
      const envs: Array<Readonly<Record<string, string>>> = [];
      let remembered: ((names: ReadonlyArray<string>) => void) | undefined;
      const h = harness({
        config: {
          readEverConnected: (env) => {
            envs.push(env);
            return new Promise((resolve) => (remembered = resolve));
          },
        },
      });
      const session = yield* openSession().pipe(Effect.provide(h.layer));
      yield* take(session, 2);
      const lapsed = Stream.filter(session.events, (e) => e.type === "connectorsLapsed");
      const init = (servers: ReadonlyArray<Record<string, string>>) =>
        query(h).output.push({
          type: "system",
          subtype: "init",
          apiKeySource: "none",
          model: "m",
          tools: [],
          slash_commands: [],
          permissionMode: "default",
          mcp_servers: servers,
          session_id: "s",
          uuid: "u",
        } as unknown as SDKMessage);
      init([
        { name: "claude.ai Atlassian", status: "connected", source: "claudeai" },
        { name: "claude.ai Snowflake", status: "needs-auth", source: "claudeai" },
        { name: "claude.ai Gmail", status: "needs-auth", source: "claudeai" },
      ]);
      // The config is read after that first init came: the listing is judged again.
      yield* settle;
      remembered!(["claude.ai Snowflake"]);
      expect(yield* Stream.runCollect(Stream.take(lapsed, 1))).toEqual([
        { type: "connectorsLapsed", names: ["claude.ai Snowflake"] },
      ]);
      expect(envs[0]).toMatchObject({ PATH: "/bin" });
      init([
        { name: "claude.ai Atlassian", status: "needs-auth", source: "claudeai" },
        { name: "claude.ai Snowflake", status: "connected", source: "claudeai" },
      ]);
      expect(yield* Stream.runCollect(Stream.take(lapsed, 1))).toEqual([
        { type: "connectorsLapsed", names: ["claude.ai Atlassian"] },
      ]);
    }),
  );

  it.effect("closes the session when system/init reports API-key auth", () =>
    Effect.gen(function* () {
      const h = harness();
      const session = yield* openSession().pipe(Effect.provide(h.layer));
      yield* take(session, 2);
      const q = query(h);
      q.output.push({
        type: "system",
        subtype: "init",
        apiKeySource: "ANTHROPIC_API_KEY",
        session_id: "s",
        uuid: "u",
      } as unknown as SDKMessage);
      const events = yield* Stream.runCollect(session.events);
      expect(events).toEqual([
        { type: "status", status: "error" },
        {
          type: "notice",
          level: "error",
          message:
            "Claude Code is using API-key auth (ANTHROPIC_API_KEY); Gram requires your subscription login.",
        },
        { type: "ended", reason: "api-key-auth" },
      ]);
      expect(q.closed).toBe(true);
    }),
  );

  it.effect("reports each turn's servers, and whether the session was given all of them", () =>
    Effect.gen(function* () {
      const init = {
        type: "system",
        subtype: "init",
        apiKeySource: "none",
        session_id: "s",
        uuid: "u",
        model: "claude-opus-5-5",
        tools: [],
        skills: [],
        slash_commands: [],
        permissionMode: "default",
        mcp_servers: [
          { name: "claude.ai Teams", status: "connected", source: "claudeai" },
          { name: "files", status: "aNewerState", source: "user" },
        ],
      } as unknown as SDKMessage;
      const reportsOf = (options: Partial<OpenSessionOptions>) =>
        Effect.gen(function* () {
          const h = harness();
          const reports: Array<ConnectorsSeen> = [];
          const session = yield* openSession({
            ...options,
            onConnectorsSeen: (seen) => void reports.push(seen),
          }).pipe(Effect.provide(h.layer));
          yield* take(session, 2);
          query(h).output.push(init);
          yield* take(session, 1);
          return reports;
        });

      // A state this build doesn't know is left out rather than guessed.
      expect(yield* reportsOf({})).toEqual([
        {
          detailed: false,
          whole: true,
          connectors: [{ name: "claude.ai Teams", status: "connected", scope: "claudeai" }],
        },
      ]);
      // An orchestrator's allowlist leaves connectors out without saying.
      expect(
        (yield* reportsOf({ mcpAllowlist: ["https://organization.example.invalid/*"] })).map(
          (r) => r.whole,
        ),
      ).toEqual([false]);
      expect((yield* reportsOf({ confineWrites: true })).map((r) => r.whole)).toEqual([false]);
      // So does a workspace's denylist.
      expect((yield* reportsOf({ mcpDenylist: ["claude.ai Gmail"] })).map((r) => r.whole)).toEqual([
        false,
      ]);
    }),
  );

  it.effect("round-trips an approval; always adds session copies without local settings", () =>
    Effect.gen(function* () {
      const h = harness({ config: { settingSources: [] } });
      const session = yield* openSession().pipe(Effect.provide(h.layer));
      yield* take(session, 2);
      const suggestion = {
        type: "addRules" as const,
        rules: [{ toolName: "Bash", ruleContent: "echo hello *" }],
        behavior: "allow" as const,
        destination: "localSettings" as const,
      };
      const result = query(h).canUseTool(
        "Bash",
        { command: "echo hello" },
        {
          signal: signal(),
          suggestions: [suggestion],
          displayName: "Bash",
          toolUseID: "toolu_1",
          requestId: "req-1",
        },
      );
      expect(yield* take(session, 2)).toEqual([
        {
          type: "request",
          request: {
            kind: "approval",
            id: "req-1",
            toolUseId: "toolu_1",
            toolName: "Bash",
            displayName: "Bash",
            input: { command: "echo hello" },
            suggestions: [suggestion],
            scopes: ["once", "session", "always"],
          },
        },
        { type: "status", status: "awaitingApproval" },
      ]);
      yield* session.respond(RequestId.make("req-1"), {
        kind: "approval",
        decision: "allow",
        scope: "always",
      });
      expect(yield* Effect.promise(() => result)).toEqual({
        behavior: "allow",
        updatedInput: { command: "echo hello" },
        updatedPermissions: [suggestion, { ...suggestion, destination: "session" }],
        toolUseID: "toolu_1",
      });
      expect(yield* take(session, 1)).toEqual([{ type: "requestResolved", requestId: "req-1" }]);
    }),
  );

  it.effect("gates outward commands with a PreToolUse hook only when asked to", () =>
    Effect.gen(function* () {
      const plain = harness();
      yield* openSession().pipe(Effect.provide(plain.layer));
      expect(Object.keys(query(plain).options.hooks ?? {})).toEqual([
        "PostToolUse",
        "Stop",
        "PostModelSwitch",
        "PreCompact",
        "PostCompact",
      ]);

      const off = harness();
      yield* openSession({ outwardGate: false }).pipe(Effect.provide(off.layer));
      expect(Object.keys(query(off).options.hooks ?? {})).not.toContain("PreToolUse");

      const gateFor = (outwardGate: NonNullable<OpenSessionOptions["outwardGate"]>) =>
        Effect.gen(function* () {
          const h = harness();
          yield* openSession({ outwardGate, permissionMode: "bypassPermissions" }).pipe(
            Effect.provide(h.layer),
          );
          const hooks = query(h).options.hooks ?? {};
          expect(Object.keys(hooks)).toEqual([
            "PreToolUse",
            "PostToolUse",
            "PostToolUseFailure",
            "PermissionDenied",
            "Stop",
            "PostModelSwitch",
            "PreCompact",
            "PostCompact",
          ]);
          expect(hooks.PreToolUse).toHaveLength(1);
          expect(hooks.PreToolUse![0]).not.toHaveProperty("matcher");
          const gate = hooks.PreToolUse![0]!.hooks[0]!;
          return (tool_name: string, tool_input: unknown, extra: object = {}) =>
            Effect.promise((): Promise<HookJSONOutput> =>
              gate(
                {
                  hook_event_name: "PreToolUse",
                  session_id: "s",
                  transcript_path: "/t",
                  cwd: "/repo",
                  tool_name,
                  tool_input,
                  tool_use_id: "toolu_1",
                  ...extra,
                } as HookInput,
                "toolu_1",
                { signal: signal() },
              ),
            );
        });
      // `true` is the older spelling of `all`.
      for (const outwardGate of [true, "all"] as const) {
        const ask = yield* gateFor(outwardGate);
        const asks = asksWith(OUTWARD_GATE_REASON);
        expect(yield* ask("Bash", { command: "git -C ../x push origin main" })).toEqual(asks);
        expect(yield* ask("Bash", { command: "git add . && gh pr create --fill" })).toEqual(asks);
        expect(yield* ask("Bash", { command: "gh pr merge 3 --squash" })).toEqual(asks);
        expect(yield* ask("Bash", { command: "git push --force" })).toEqual(asks);
        // A subagent's push is a push.
        expect(
          yield* ask("Bash", { command: "git push" }, { agent_id: "a1", agent_type: "general" }),
        ).toEqual(asks);
        expect(yield* ask("Bash", { command: 'git commit -m "push it"' })).toEqual({});
        expect(yield* ask("Bash", { command: "gh pr view 3" })).toEqual({});
        expect(yield* ask("Bash", {})).toEqual({});
        expect(yield* ask("Write", { command: "git push" })).toEqual({});
      }

      const ask = yield* gateFor("irreversible");
      const asks = asksWith(IRREVERSIBLE_GATE_REASON);
      expect(yield* ask("Bash", { command: "git push -u origin feature" })).toEqual({});
      expect(yield* ask("Bash", { command: "git add . && gh pr create --fill" })).toEqual({});
      expect(yield* ask("Bash", { command: "gh pr merge 3 --squash" })).toEqual(asks);
      expect(yield* ask("Bash", { command: "gh pr close 3" })).toEqual(asks);
      expect(yield* ask("Bash", { command: "git push --force" })).toEqual(asks);
      expect(yield* ask("Bash", { command: "git push origin +feature" })).toEqual(asks);
      expect(yield* ask("Bash", { command: "git push && gh pr merge 3" })).toEqual(asks);
      expect(
        yield* ask("Bash", { command: "git push -f" }, { agent_id: "a1", agent_type: "general" }),
      ).toEqual(asks);
      expect(yield* ask("Bash", { command: "git status" })).toEqual({});
    }),
  );

  it.effect("refuses reaching another session, and every send once the CLI's switch fails", () =>
    Effect.gen(function* () {
      const peerHook = (options: Partial<OpenSessionOptions>) =>
        Effect.gen(function* () {
          // As `buildChildEnv` prepares it, and `withPeerMessaging` takes it back out.
          const h = harness({ cliVersion: "2.1.301", env: { [PEER_MESSAGING_SWITCH]: "0" } });
          const session = yield* openSession({ outwardGate: "irreversible", ...options }).pipe(
            Effect.provide(h.layer),
          );
          const pre = query(h).options.hooks!.PreToolUse![0]!.hooks[0]!;
          const call = (tool_name: string, tool_input: unknown) =>
            Effect.promise((): Promise<HookJSONOutput> =>
              pre(
                {
                  hook_event_name: "PreToolUse",
                  session_id: "s",
                  transcript_path: "/t",
                  cwd: "/repo",
                  tool_name,
                  tool_input,
                  tool_use_id: "toolu_p",
                } as HookInput,
                "toolu_p",
                { signal: signal() },
              ),
            );
          return { h, session, call };
        });
      const denied = expect.objectContaining({
        hookSpecificOutput: expect.objectContaining({ permissionDecision: "deny" }),
      });

      const worker = yield* peerHook({ audience: "worker" });
      expect(yield* worker.call("ListAgents", {})).toEqual(denied);
      expect(yield* worker.call("SendMessage", { to: "uds:/tmp/cc-socks/1.sock" })).toEqual(denied);
      // Its own subagents stay reachable while the switch holds.
      expect(yield* worker.call("SendMessage", { to: "helper", message: "go" })).toEqual({});

      // A CLI that still offers `ListAgents` ignored the switch: say so, and refuse every send.
      yield* take(worker.session, 2);
      query(worker.h).output.push({
        type: "system",
        subtype: "init",
        apiKeySource: "none",
        tools: ["SendMessage", "ListAgents"],
        session_id: "s",
        uuid: "u",
      } as unknown as SDKMessage);
      const [notice] = yield* Stream.runCollect(
        Stream.take(
          Stream.filter(worker.session.events, (e) => e.type === "notice"),
          1,
        ),
      );
      expect(notice).toMatchObject({ level: "warning" });
      expect(notice).toHaveProperty("message", expect.stringContaining("2.1.301"));
      expect(yield* worker.call("SendMessage", { to: "helper", message: "go" })).toEqual(denied);

      // An orchestrator the user lets send keeps both tools.
      const allowed = yield* peerHook({ audience: "orchestrator", peerMessaging: true });
      expect(yield* allowed.call("ListAgents", {})).toEqual({});
      expect(yield* allowed.call("SendMessage", { to: "uds:/tmp/cc-socks/1.sock" })).toEqual({});
    }).pipe(Effect.scoped),
  );

  it.effect("a closed tool gate refuses every call, and lets one admitted before finish", () =>
    Effect.gen(function* () {
      const h = harness();
      const session = yield* openSession({ outwardGate: "all" }).pipe(Effect.provide(h.layer));
      const hooks = query(h).options.hooks ?? {};
      const pre = hooks.PreToolUse![0]!.hooks[0]!;
      const post = hooks.PostToolUse![0]!.hooks.at(-1)!;
      const call = (hook: typeof pre, event: "PreToolUse" | "PostToolUse", id: string) =>
        Effect.promise((): Promise<HookJSONOutput> =>
          hook(
            {
              hook_event_name: event,
              session_id: "s",
              transcript_path: "/t",
              cwd: "/repo",
              tool_name: "Bash",
              tool_input: { command: "bun run build" },
              tool_use_id: id,
              ...(event === "PostToolUse" ? { tool_response: "" } : {}),
            } as HookInput,
            id,
            { signal: signal() },
          ),
        );
      expect(yield* call(pre, "PreToolUse", "toolu_a")).toEqual({});
      // Closed at once, with no interrupt: toolu_a runs on, and every later call is refused.
      yield* session.closeToolGate!;
      expect(yield* call(pre, "PreToolUse", "toolu_b")).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: TOOL_GATE_REASON,
        },
      });
      yield* call(post, "PostToolUse", "toolu_a");
      expect(yield* call(pre, "PreToolUse", "toolu_c")).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
    }),
  );

  it.effect("offers an outward command once only, in a gated session alone", () =>
    Effect.gen(function* () {
      const suggestion = {
        type: "addRules" as const,
        rules: [{ toolName: "Bash", ruleContent: "git push:*" }],
        behavior: "allow" as const,
        destination: "localSettings" as const,
      };
      const card = (overrides: Partial<OpenSessionOptions>, command: string) =>
        Effect.gen(function* () {
          const h = harness();
          const session = yield* openSession(overrides).pipe(Effect.provide(h.layer));
          yield* take(session, 2);
          void query(h).canUseTool(
            "Bash",
            { command },
            {
              signal: signal(),
              suggestions: [suggestion],
              decisionReason: OUTWARD_GATE_REASON,
              toolUseID: "toolu_1",
              requestId: "req-1",
            },
          );
          const [event] = yield* take(session, 1);
          return event;
        });

      // The hook's "ask" is what brings the call here in `bypassPermissions`; the card it gets
      // can't promise an "always" the hook would override.
      expect(
        yield* card({ outwardGate: true, permissionMode: "bypassPermissions" }, "git push"),
      ).toMatchObject({
        type: "request",
        request: {
          kind: "approval",
          toolName: "Bash",
          decisionReason: OUTWARD_GATE_REASON,
          suggestions: [],
          scopes: ["once"],
        },
      });
      expect(yield* card({ outwardGate: "all" }, "gh pr create --fill")).toMatchObject({
        request: { suggestions: [], scopes: ["once"] },
      });
      expect(yield* card({ outwardGate: "irreversible" }, "git push -f")).toMatchObject({
        request: { suggestions: [], scopes: ["once"] },
      });
      // At `irreversible` a push isn't the gate's to ask about, so a card the mode raised for it
      // is an ordinary one.
      expect(yield* card({ outwardGate: "irreversible" }, "git push")).toMatchObject({
        request: { suggestions: [suggestion], scopes: ["once", "session", "always"] },
      });
      expect(yield* card({ outwardGate: true }, "git status")).toMatchObject({
        request: { suggestions: [suggestion], scopes: ["once", "session", "always"] },
      });
      expect(yield* card({ outwardGate: false }, "git push")).toMatchObject({
        request: { suggestions: [suggestion], scopes: ["once", "session", "always"] },
      });
      expect(yield* card({}, "git push")).toMatchObject({
        request: { suggestions: [suggestion], scopes: ["once", "session", "always"] },
      });
    }),
  );

  it.effect("switches permission mode before approving a plan", () =>
    Effect.gen(function* () {
      const h = harness();
      const session = yield* openSession().pipe(Effect.provide(h.layer));
      const q = query(h);
      const result = q.canUseTool(
        "ExitPlanMode",
        { plan: "# Plan" },
        { signal: signal(), toolUseID: "t", requestId: "req-plan" },
      );
      void result.then(() => q.calls.push("resolved"));
      yield* take(session, 4);
      yield* session.respond(RequestId.make("req-plan"), { kind: "plan", decision: "approve" });
      yield* Effect.promise(() => result);
      yield* settle;
      expect(q.calls).toEqual(["setPermissionMode:acceptEdits", "resolved"]);
    }),
  );

  it.effect("approves a plan whose mode the CLI refuses, and says so", () =>
    Effect.gen(function* () {
      const h = harness();
      const session = yield* openSession().pipe(Effect.provide(h.layer));
      const q = query(h);
      q.refusedModes = ["bypassPermissions"];
      const result = q.canUseTool(
        "ExitPlanMode",
        { plan: "# Plan" },
        { signal: signal(), toolUseID: "t", requestId: "req-plan" },
      );
      yield* take(session, 4);
      yield* session.respond(RequestId.make("req-plan"), {
        kind: "plan",
        decision: "approve",
        mode: "bypassPermissions",
      });
      expect(yield* Effect.promise(() => result)).toMatchObject({ behavior: "allow" });
      expect(yield* take(session, 1)).toEqual([
        {
          type: "notice",
          level: "warning",
          message:
            "Claude Code didn't switch to bypassPermissions mode: Cannot set permission mode to bypassPermissions",
        },
      ]);
    }),
  );

  it.effect("fails setMode with the CLI's reason when it refuses the mode", () =>
    Effect.gen(function* () {
      const h = harness();
      const session = yield* openSession().pipe(Effect.provide(h.layer));
      query(h).refusedModes = ["bypassPermissions"];
      const refused = yield* Effect.flip(session.setMode("bypassPermissions"));
      expect(refused).toMatchObject({
        _tag: "ModeRefused",
        mode: "bypassPermissions",
        message: "Cannot set permission mode to bypassPermissions",
      });
    }),
  );

  it.effect("answers questions via updatedInput.answers", () =>
    Effect.gen(function* () {
      const h = harness();
      const session = yield* openSession().pipe(Effect.provide(h.layer));
      const input = {
        questions: [
          {
            question: "Which?",
            header: "Pick",
            multiSelect: true,
            options: [
              { label: "a", description: "" },
              { label: "b", description: "" },
            ],
          },
        ],
      };
      const result = query(h).canUseTool("AskUserQuestion", input, {
        signal: signal(),
        toolUseID: "t",
        requestId: "req-q",
      });
      const [, , request, status] = yield* take(session, 4);
      expect(request).toMatchObject({ type: "request", request: { kind: "question" } });
      expect(status).toEqual({ type: "status", status: "awaitingInput" });
      yield* session.respond(RequestId.make("req-q"), {
        kind: "question",
        answers: { "Which?": ["a", "b"] },
      });
      expect(yield* Effect.promise(() => result)).toMatchObject({
        behavior: "allow",
        updatedInput: { ...input, answers: { "Which?": "a, b" } },
      });
    }),
  );

  it.effect("resolves a request when the SDK aborts it", () =>
    Effect.gen(function* () {
      const h = harness();
      const session = yield* openSession().pipe(Effect.provide(h.layer));
      const controller = new AbortController();
      const result = query(h).canUseTool(
        "Bash",
        {},
        { signal: controller.signal, toolUseID: "t", requestId: "req-a" },
      );
      yield* take(session, 4);
      controller.abort();
      expect(yield* Effect.promise(() => result)).toEqual({
        behavior: "deny",
        message: "The request was cancelled.",
      });
      expect(yield* take(session, 1)).toEqual([{ type: "requestResolved", requestId: "req-a" }]);
      yield* session.respond(RequestId.make("req-a"), {
        kind: "approval",
        decision: "allow",
        scope: "once",
      });
    }),
  );

  it.effect("interrupts, and fails with InterruptHung after the watchdog", () =>
    Effect.gen(function* () {
      const h = harness();
      const session = yield* openSession().pipe(Effect.provide(h.layer));
      const q = query(h);
      yield* session.interrupt;
      expect(q.calls).toEqual(["interrupt"]);

      q.interruptResult = new Promise<undefined>(() => {});
      const fiber = yield* Effect.forkScoped(Effect.flip(session.interrupt));
      yield* TestClock.adjust("5 seconds");
      const error = yield* Fiber.join(fiber);
      expect(error).toEqual(expect.objectContaining({ _tag: "InterruptHung", timeoutMs: 5000 }));
    }),
  );

  it.effect("stops the background tasks still running, and only those", () =>
    Effect.gen(function* () {
      const h = harness();
      const session = yield* openSession().pipe(Effect.provide(h.layer));
      const q = query(h);
      q.output.push(task("task_started", "bg-1", { is_backgrounded: true, tool_use_id: "t1" }));
      q.output.push(task("task_started", "gone", { is_backgrounded: true, tool_use_id: "t2" }));
      q.output.push(task("task_started", "fg-1", { tool_use_id: "t3" }));
      q.output.push(task("task_started", "bg-2", { is_backgrounded: true, tool_use_id: "t4" }));
      q.output.push(task("task_notification", "bg-2", { tool_use_id: "t4", status: "completed" }));
      // Let the pump take them.
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow;

      expect(yield* session.stopBackgroundTasks!).toBe(2);
      expect(q.calls.toSorted()).toEqual(["stopTask:bg-1", "stopTask:gone"]);
    }),
  );

  // CLI 2.1.272's recorded `sleep 6 && echo FIRST_DONE`; the reads answer as CLI 2.1.296 did for
  // a local mock API run.
  it.effect("reads a running foreground Bash's output back and sends it until its result", () =>
    Effect.gen(function* () {
      const TASK = "00000000-0000-4000-8000-000000000142";
      let written = "";
      const h = harness({
        taskOutput: (taskId) =>
          taskId === TASK
            ? Promise.resolve({ output: written, total_bytes: written.length, truncated: false })
            : Promise.reject(new Error("get_task_output: no shell or Monitor task")),
      });
      const session = yield* openSession().pipe(Effect.provide(h.layer));
      const q = query(h);
      const events: AgentEvent[] = [];
      yield* Effect.forkScoped(
        Stream.runForEach(session.events, (event) => Effect.sync(() => void events.push(event))),
      );
      const messages = fixtureMessages("p04-streaming-input-default");
      const at = messages.findIndex((m) => m.type === "system" && m.subtype === "task_started");
      const reads = () => q.calls.filter((c) => c.startsWith("getTaskOutput"));
      const snapshots = () =>
        events.flatMap((e) =>
          e.type === "chunk" &&
          e.chunk.type === "tool-output-available" &&
          e.chunk.preliminary === true
            ? [e.chunk.output]
            : [],
        );
      const tick = Effect.gen(function* () {
        yield* TestClock.adjust(SHELL_OUTPUT_POLL_MS);
        yield* settle;
        yield* settle;
      });

      for (const message of messages.slice(0, at)) q.output.push(message);
      yield* settle;
      yield* tick;
      // Not a task yet: nothing to read.
      expect(reads()).toEqual([]);

      q.output.push(messages[at]!);
      yield* settle;
      yield* tick;
      // Written nothing yet: no snapshot.
      expect(snapshots()).toEqual([]);
      written = "FIRST";
      yield* tick;
      yield* tick;
      expect(snapshots()).toEqual([{ stdout: "FIRST", stderr: "", interrupted: false }]);
      expect(reads()).toEqual([
        `getTaskOutput:${TASK}`,
        `getTaskOutput:${TASK}`,
        `getTaskOutput:${TASK}`,
      ]);

      for (const message of messages.slice(at + 1)) q.output.push(message);
      yield* settle;
      yield* tick;
      expect(reads()).toHaveLength(3);
      expect(snapshots()).toHaveLength(1);
      // Reading sends the agent nothing.
      expect(q.inputs).toEqual([]);
    }),
  );

  // CLI 2.1.296's recorded `run_in_background` shells: the long one is stopped, the short one ends
  // between turns. The reads answer as CLI 2.1.296 did for a backgrounded call against a local
  // mock API.
  it.effect("reads a background shell's output beside its call until its task ends", () =>
    Effect.gen(function* () {
      const written = new Map<string, string>();
      const h = harness({ taskOutput: (taskId) => answerWith(written.get(taskId) ?? "") });
      const session = yield* openSession().pipe(Effect.provide(h.layer));
      const q = query(h);
      const events: AgentEvent[] = [];
      yield* Effect.forkScoped(
        Stream.runForEach(session.events, (event) => Effect.sync(() => void events.push(event))),
      );
      const messages = fixtureMessages("p14-background-shells");
      const index = (subtype: string, taskId: string) =>
        messages.findIndex(
          (m) =>
            m.type === "system" && m.subtype === subtype && Reflect.get(m, "task_id") === taskId,
        );
      const reads = (taskId: string) =>
        q.calls.filter((c) => c === `getTaskOutput:${taskId}`).length;
      const outputs = () =>
        events.flatMap((e) => (e.type === "backgroundOutput" ? [`${e.taskId} ${e.output}`] : []));
      const tick = Effect.gen(function* () {
        yield* TestClock.adjust(SHELL_OUTPUT_POLL_MS);
        yield* settle;
        yield* settle;
      });
      const pushTo = (end: number, from: number) => {
        for (const message of messages.slice(from, end + 1)) q.output.push(message);
      };

      const longEnd = index("task_notification", "fixture-shell-long");
      const shortEnd = index("task_notification", "fixture-shell-short");
      pushTo(longEnd - 3, 0);
      yield* settle;
      written.set("fixture-shell-long", "waiting\n");
      written.set("fixture-shell-short", "");
      yield* tick;
      expect(outputs()).toEqual(["fixture-shell-long waiting\n"]);
      // The long one is stopped; the turn ends with the short one still running.
      pushTo(shortEnd - 4, longEnd - 2);
      yield* settle;
      const longReads = reads("fixture-shell-long");
      written.set("fixture-shell-short", "SHORT_DONE\n");
      yield* tick;
      yield* tick;
      expect(reads("fixture-shell-long")).toBe(longReads);
      expect(outputs()).toEqual([
        "fixture-shell-long waiting\n",
        "fixture-shell-short SHORT_DONE\n",
      ]);
      // Its call had its result long ago: no interim output reopens it.
      expect(snapshotsIn(events)).toEqual([]);
      const shortReads = reads("fixture-shell-short");
      expect(shortReads).toBeGreaterThanOrEqual(3);
      pushTo(shortEnd, shortEnd - 3);
      yield* settle;
      yield* tick;
      expect(reads("fixture-shell-short")).toBe(shortReads);
      // Reading sends the agent nothing.
      expect(q.inputs).toEqual([]);
    }),
  );

  it.effect("stops reading background shells when the query ends", () =>
    Effect.gen(function* () {
      const h = harness({ taskOutput: () => answerWith("serving\n") });
      const session = yield* openSession().pipe(Effect.provide(h.layer));
      const q = query(h);
      yield* Effect.forkScoped(Stream.runDrain(session.events));
      const messages = fixtureMessages("p14-background-shells");
      const started = messages.findIndex(
        (m) => m.type === "system" && m.subtype === "task_started",
      );
      for (const message of messages.slice(0, started + 2)) q.output.push(message);
      yield* settle;
      yield* TestClock.adjust(SHELL_OUTPUT_POLL_MS);
      yield* settle;
      const reads = () => q.calls.filter((c) => c.startsWith("getTaskOutput")).length;
      expect(reads()).toBe(1);
      q.close();
      yield* settle;
      for (let i = 0; i < 3; i++) {
        yield* TestClock.adjust(SHELL_OUTPUT_POLL_MS);
        yield* settle;
      }
      expect(reads()).toBe(1);
    }),
  );

  it.effect("stops reading a task the CLI won't read back", () =>
    Effect.gen(function* () {
      const h = harness({
        taskOutput: () => Promise.reject(new Error("get_task_output is not available")),
      });
      const session = yield* openSession().pipe(Effect.provide(h.layer));
      const q = query(h);
      const events: AgentEvent[] = [];
      yield* Effect.forkScoped(
        Stream.runForEach(session.events, (event) => Effect.sync(() => void events.push(event))),
      );
      const messages = fixtureMessages("p04-streaming-input-default");
      const at = messages.findIndex((m) => m.type === "system" && m.subtype === "task_started");
      for (const message of messages.slice(0, at + 1)) q.output.push(message);
      yield* settle;
      for (let i = 0; i < 3; i++) {
        yield* TestClock.adjust(SHELL_OUTPUT_POLL_MS);
        yield* settle;
      }
      expect(q.calls.filter((c) => c.startsWith("getTaskOutput"))).toHaveLength(1);
      expect(events.some((e) => e.type === "notice" || e.type === "ended")).toBe(false);
    }),
  );

  it.effect("reads running shells side by side, so a hung read holds up no other", () =>
    Effect.gen(function* () {
      let b2 = "";
      const h = harness({ taskOutput: (taskId) => (taskId === "b1" ? never() : answerWith(b2)) });
      const session = yield* openSession().pipe(Effect.provide(h.layer));
      const q = query(h);
      const events: AgentEvent[] = [];
      yield* Effect.forkScoped(
        Stream.runForEach(session.events, (event) => Effect.sync(() => void events.push(event))),
      );
      for (const message of twoRunningShells()) q.output.push(message);
      yield* settle;
      b2 = "built\n";
      yield* TestClock.adjust(SHELL_OUTPUT_POLL_MS);
      yield* settle;
      yield* settle;
      expect(snapshotsIn(events)).toEqual([
        `t2 ${JSON.stringify({ stdout: "built\n", stderr: "", interrupted: false })}`,
      ]);
    }),
  );

  it.effect("keeps reading after a read times out, and gives up after three in a row", () =>
    Effect.gen(function* () {
      // b1 answers its third read; b2 never answers.
      let b1Reads = 0;
      const h = harness({
        taskOutput: (taskId) =>
          taskId === "b1" && ++b1Reads >= 3 ? answerWith("late but real\n") : never(),
      });
      const session = yield* openSession().pipe(Effect.provide(h.layer));
      const q = query(h);
      const events: AgentEvent[] = [];
      yield* Effect.forkScoped(
        Stream.runForEach(session.events, (event) => Effect.sync(() => void events.push(event))),
      );
      for (const message of twoRunningShells()) q.output.push(message);
      yield* settle;
      const cycle = Effect.gen(function* () {
        yield* TestClock.adjust(SHELL_OUTPUT_POLL_MS);
        yield* settle;
        yield* TestClock.adjust(SHELL_OUTPUT_READ_TIMEOUT_MS);
        yield* settle;
        yield* settle;
      });
      for (let i = 0; i < 5; i++) yield* cycle;
      const reads = (taskId: string) =>
        q.calls.filter((c) => c === `getTaskOutput:${taskId}`).length;
      expect(snapshotsIn(events)).toEqual([
        `t1 ${JSON.stringify({ stdout: "late but real\n", stderr: "", interrupted: false })}`,
      ]);
      expect(reads("b2")).toBe(SHELL_OUTPUT_TIMEOUTS);
      expect(reads("b1")).toBeGreaterThan(SHELL_OUTPUT_TIMEOUTS);
    }),
  );

  it.effect("stops one listed background task by id, including a shell the CLI moved there", () =>
    Effect.gen(function* () {
      const h = harness();
      const session = yield* openSession().pipe(Effect.provide(h.layer));
      const q = query(h);
      q.output.push(task("task_started", "moved", { is_backgrounded: false, tool_use_id: "t1" }));
      q.output.push(listed("moved"));
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow;

      expect(yield* session.stopTask!("moved")).toBe(true);
      expect(yield* session.stopTask!("never-listed")).toBe(false);
      q.output.push(listed());
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
      expect(yield* session.stopTask!("moved")).toBe(false);
      expect(q.calls).toEqual(["stopTask:moved"]);
    }),
  );

  it.effect("changes mode and model", () =>
    Effect.gen(function* () {
      const h = harness();
      const session = yield* openSession().pipe(Effect.provide(h.layer));
      yield* session.setMode("acceptEdits");
      yield* session.setModel({ agent: "claude", model: "opus" });
      expect(query(h).calls).toEqual(["setPermissionMode:acceptEdits", "setModel:opus"]);
    }),
  );

  it.effect("sends the reasoning variant as effort on open, omitting none", () =>
    Effect.gen(function* () {
      const high = harness();
      yield* openSession({ model: { agent: "claude", model: "opus", variant: "high" } }).pipe(
        Effect.provide(high.layer),
      );
      expect(query(high).options).toMatchObject({ model: "opus", effort: "high" });

      const none = harness();
      yield* openSession({ model: { agent: "claude", model: "opus", variant: "none" } }).pipe(
        Effect.provide(none.layer),
      );
      expect(query(none).options).not.toHaveProperty("effort");
    }),
  );

  it.effect("applies a changed variant mid-session through setModel", () =>
    Effect.gen(function* () {
      const h = harness();
      const session = yield* openSession({
        model: { agent: "claude", model: "opus", variant: "low" },
      }).pipe(Effect.provide(h.layer));
      yield* session.setModel({ agent: "claude", model: "opus", variant: "low" });
      yield* session.setModel({ agent: "claude", model: "opus", variant: "xhigh" });
      yield* session.setModel({ agent: "claude", model: "sonnet", variant: "none" });
      expect(query(h).calls).toEqual([
        "setModel:opus",
        "setModel:opus",
        'applyFlagSettings:{"effortLevel":"xhigh"}',
        "setModel:sonnet",
        'applyFlagSettings:{"effortLevel":null}',
      ]);
    }),
  );

  it.effect("closes the query and denies pending requests when the scope closes", () =>
    Effect.gen(function* () {
      const h = harness();
      const { session, result } = yield* Effect.scoped(
        Effect.gen(function* () {
          const s = yield* openSession();
          const r = query(h).canUseTool(
            "Bash",
            {},
            { signal: signal(), toolUseID: "t", requestId: "req-c" },
          );
          return { session: s, result: r };
        }),
      ).pipe(Effect.provide(h.layer));
      expect(query(h).closed).toBe(true);
      expect(yield* Effect.promise(() => result)).toEqual({
        behavior: "deny",
        message: "The session was closed.",
      });
      const events: ReadonlyArray<AgentEvent> = yield* Stream.runCollect(session.events);
      expect(events.at(-1)).toEqual({ type: "requestResolved", requestId: "req-c" });
    }),
  );
});

const appTool = (
  name: string,
  klass: AppTool["descriptor"]["class"],
  run: AppTool["run"],
  describeTool?: AppTool["describe"],
): AppTool => ({
  descriptor: { name, class: klass, description: `${name} tool` },
  input: Schema.Struct({ title: Schema.String }) as unknown as AppTool["input"],
  run,
  ...(describeTool === undefined ? {} : { describe: describeTool }),
});

/** A registry whose gated binding holds the tools; its ungated one is never Claude's. */
const registry = (calls: Array<string>, tools?: () => ReadonlyArray<AppTool>) => ({
  forThread: (): ReadonlyArray<AppTool> => {
    throw new Error("Claude binds the gated tools");
  },
  forSession: (threadId: string) => {
    calls.push(threadId);
    return (
      tools?.() ?? [
        appTool("set_title", "self", (input) => Effect.succeed({ ok: true, input })),
        appTool("list_threads", "read", () =>
          Effect.fail(new AppToolError({ tool: "list_threads", message: "db down" })),
        ),
        appTool(
          "delete_thread",
          "outward",
          () => Effect.succeed("deleted"),
          () => Effect.succeed("Delete “Worker”"),
        ),
      ]
    );
  },
});

const allowed = (input: Record<string, unknown>) => ({ behavior: "allow", updatedInput: input });

/** The session's `PreToolUse` hook, called as the SDK would for `tool_name`. */
const preToolUse = (q: FakeQuery) => {
  const gate = q.options.hooks?.PreToolUse?.[0]?.hooks[0];
  if (gate === undefined) throw new Error("no PreToolUse hook");
  return (tool_name: string, tool_input: unknown, extra: object = {}) =>
    Effect.promise((): Promise<HookJSONOutput> =>
      gate(
        {
          hook_event_name: "PreToolUse",
          session_id: "s",
          transcript_path: "/t",
          cwd: "/repo",
          tool_name,
          tool_input,
          tool_use_id: "toolu_1",
          ...extra,
        } as HookInput,
        "toolu_1",
        { signal: signal() },
      ),
    );
};

describe("app tools bridge", () => {
  it.effect("keeps wrap_up for the main agent: a subagent's call is denied, others pass", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* openSession({
        appTools: registry([], () => [
          appTool("wrap_up", "self", (input) => Effect.succeed({ ok: true, input })),
          appTool("set_title", "self", (input) => Effect.succeed({ ok: true, input })),
        ]),
      }).pipe(Effect.provide(h.layer));
      const hook = preToolUse(query(h));
      const subagent = { agent_id: "a1", agent_type: "general-purpose" };
      expect(yield* hook("mcp__gram__wrap_up", { recap: "r" })).toMatchObject({
        hookSpecificOutput: { permissionDecision: "allow" },
      });
      expect(yield* hook("mcp__gram__wrap_up", { recap: "r" }, subagent)).toMatchObject({
        hookSpecificOutput: {
          permissionDecision: "deny",
          permissionDecisionReason: expect.stringContaining("Only the main agent"),
        },
      });
      // Only the tools that speak for the turn: a subagent's other Gram tools still pass.
      expect(yield* hook("mcp__gram__set_title", { title: "x" }, subagent)).toMatchObject({
        hookSpecificOutput: { permissionDecision: "allow" },
      });
    }),
  );

  it.effect("file-only Dream removes every native tool and rejects native permission calls", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* openSession({
        dreamFilesOnly: true,
        confineWrites: true,
        appTools: registry([]),
        audience: "dream",
      }).pipe(Effect.provide(h.layer));
      const q = query(h);
      expect(q.options.tools).toEqual([]);
      expect(q.options.settingSources).toEqual([]);
      const abort = new AbortController();
      expect(
        yield* Effect.promise(() =>
          q.options.canUseTool!(
            "Read",
            { file_path: "/outside" },
            { signal: abort.signal, toolUseID: "x", requestId: "request-x" },
          ),
        ),
      ).toMatchObject({ behavior: "deny" });
    }),
  );

  it.effect("takes the shell, the network and subagents from a confined session only", () =>
    Effect.gen(function* () {
      const confined = harness();
      yield* openSession({ confineWrites: true, permissionMode: "acceptEdits" }).pipe(
        Effect.provide(confined.layer),
      );
      expect(query(confined).options.disallowedTools).toEqual([...CONFINED_DISALLOWED]);
      expect(CONFINED_DISALLOWED).toEqual(
        expect.arrayContaining(["Bash", "WebFetch", "WebSearch", "Task"]),
      );
      // The file tools are what a dream works with.
      for (const kept of ["Read", "Write", "Edit", "Glob", "Grep"]) {
        expect(CONFINED_DISALLOWED).not.toContain(kept);
      }

      const plain = harness();
      yield* openSession({ permissionMode: "acceptEdits" }).pipe(Effect.provide(plain.layer));
      expect(query(plain).options).not.toHaveProperty("disallowedTools");
    }).pipe(Effect.scoped),
  );

  it.effect("refuses peer messages in every session and lets only an allowed one send", () =>
    Effect.gen(function* () {
      // As `buildChildEnv` prepares it: Claude Code's cross-session messaging off.
      const env = { [PEER_MESSAGING_SWITCH]: "0" };
      const worker = harness({ env });
      yield* openSession({ audience: "worker", permissionMode: "bypassPermissions" }).pipe(
        Effect.provide(worker.layer),
      );
      expect(query(worker).options.env?.[PEER_MESSAGING_SWITCH]).toBe("0");
      expect(query(worker).options.settings).toEqual({ crossSessionInbound: "refuse" });

      const permitted = harness({ env });
      yield* openSession({ audience: "orchestrator", peerMessaging: true }).pipe(
        Effect.provide(permitted.layer),
      );
      expect(query(permitted).options.env).not.toHaveProperty(PEER_MESSAGING_SWITCH);
      // It may send, but nothing comes in past Gram, so a reply never arrives either.
      expect(query(permitted).options.settings).toEqual({ crossSessionInbound: "refuse" });
    }).pipe(Effect.scoped),
  );

  it.effect("gives a confined session no MCP server but Gram's own", () =>
    Effect.gen(function* () {
      const confined = harness();
      yield* openSession({
        confineWrites: true,
        permissionMode: "acceptEdits",
        appTools: registry([]),
      }).pipe(Effect.provide(confined.layer));
      const options = query(confined).options;
      expect(options.strictMcpConfig).toBe(true);
      expect(options.settings).toEqual({ ...REFUSE_PEER_MESSAGES, allowedMcpServers: [] });
      expect(options.env?.["ENABLE_CLAUDEAI_MCP_SERVERS"]).toBe("false");
      expect(Object.keys(options.mcpServers ?? {})).toEqual(["gram"]);
      expect(CONFINED_MCP.allowedMcpServers).toEqual([]);

      // What the dream is meant to have still works: served, let through by the hook and the
      // permission callback, and callable.
      expect(confined.tools.map((t) => t.name)).toEqual([
        "set_title",
        "list_threads",
        "delete_thread",
      ]);
      expect(options.disallowedTools).not.toContain("mcp__gram__set_title");
      const q = query(confined);
      expect(yield* preToolUse(q)("mcp__gram__set_title", { title: "x" })).toMatchObject({
        hookSpecificOutput: { permissionDecision: "allow" },
      });
      expect(
        yield* Effect.promise(() =>
          q.canUseTool(
            "mcp__gram__set_title",
            { title: "x" },
            { signal: signal(), toolUseID: "t", requestId: "r" },
          ),
        ),
      ).toEqual(allowed({ title: "x" }));
      expect(yield* Effect.promise(() => confined.tools[0]!.handler({ title: "x" }, {}))).toEqual({
        content: [{ type: "text", text: '{"ok":true,"input":{"title":"x"}}' }],
      });

      // An allowlist doesn't widen a confined session; an exception would be its own option.
      const allowlisted = harness();
      yield* openSession({ confineWrites: true, mcpAllowlist: ["parse"] }).pipe(
        Effect.provide(allowlisted.layer),
      );
      expect(query(allowlisted).options.strictMcpConfig).toBe(true);
      expect(query(allowlisted).options.settings).toEqual({
        ...REFUSE_PEER_MESSAGES,
        allowedMcpServers: [],
      });
      const denylisted = harness();
      yield* openSession({ confineWrites: true, mcpDenylist: ["parse"] }).pipe(
        Effect.provide(denylisted.layer),
      );
      expect(query(denylisted).options.settings).toEqual({
        ...REFUSE_PEER_MESSAGES,
        allowedMcpServers: [],
      });

      const plain = harness();
      yield* openSession({ permissionMode: "acceptEdits" }).pipe(Effect.provide(plain.layer));
      expect(query(plain).options).not.toHaveProperty("strictMcpConfig");
      expect(query(plain).options.settings).toEqual(REFUSE_PEER_MESSAGES);
      expect(query(plain).options.env).not.toHaveProperty("ENABLE_CLAUDEAI_MCP_SERVERS");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "pins an orchestrator's shell, narrows its MCP servers, and drops the blocking ask",
    () =>
      Effect.gen(function* () {
        const role = harness();
        yield* openSession({
          pinCwd: true,
          noBlockingAsk: true,
          mcpAllowlist: ["parse", "https://mcp.example.invalid/teams"],
        }).pipe(Effect.provide(role.layer));
        const options = query(role).options;
        expect(options.env?.["CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR"]).toBe("1");
        expect(options.disallowedTools).toEqual([BLOCKING_ASK_TOOL]);
        expect(options).not.toHaveProperty("strictMcpConfig");
        expect(options.settings).toEqual({
          ...REFUSE_PEER_MESSAGES,
          allowedMcpServers: [
            { serverName: "parse" },
            { serverUrl: "https://mcp.example.invalid/teams" },
          ],
        });
        // An empty list still narrows: Gram's own server alone.
        const none = harness();
        yield* openSession({ mcpAllowlist: [] }).pipe(Effect.provide(none.layer));
        expect(query(none).options.settings).toEqual({
          ...REFUSE_PEER_MESSAGES,
          allowedMcpServers: [],
        });

        // A workspace's denylist goes beside it, by name or URL, and the view hears of both.
        const denied = harness();
        const narrowed = yield* openSession({
          mcpAllowlist: ["parse"],
          mcpDenylist: ["claude.ai Gmail", "https://mcp.example.invalid/*"],
        }).pipe(Effect.provide(denied.layer));
        expect(query(denied).options.settings).toEqual({
          ...REFUSE_PEER_MESSAGES,
          allowedMcpServers: [{ serverName: "parse" }],
          deniedMcpServers: [
            { serverName: "claude.ai Gmail" },
            { serverUrl: "https://mcp.example.invalid/*" },
          ],
        });
        expect(narrowed.connectors?.allowlist).toEqual(["parse"]);
        expect(narrowed.connectors?.denylist).toEqual([
          "claude.ai Gmail",
          "https://mcp.example.invalid/*",
        ]);
        const denyOnly = harness();
        yield* openSession({ mcpDenylist: ["parse"] }).pipe(Effect.provide(denyOnly.layer));
        expect(query(denyOnly).options.settings).toEqual({
          ...REFUSE_PEER_MESSAGES,
          deniedMcpServers: [{ serverName: "parse" }],
        });
        // A repo's own allowlist would widen the session's; what it adds is denied instead.
        const repo = mkdtempSync(join(tmpdir(), "gram-claude-lists-"));
        mkdirSync(join(repo, ".claude"));
        writeFileSync(
          join(repo, ".claude", "settings.json"),
          JSON.stringify({
            allowedMcpServers: [
              { serverName: "parse" },
              { serverName: "beta" },
              { serverUrl: "https://*" },
            ],
          }),
        );
        // The user's own settings, in the session's config dir, would widen it the same way.
        const userDir = mkdtempSync(join(tmpdir(), "gram-claude-user-"));
        writeFileSync(
          join(userDir, "settings.json"),
          JSON.stringify({ allowedMcpServers: [{ serverName: "gamma" }] }),
        );
        const widened = harness({ env: { CLAUDE_CONFIG_DIR: userDir } });
        yield* openSession({ cwd: repo, mcpAllowlist: ["parse"] }).pipe(
          Effect.provide(widened.layer),
        );
        expect(query(widened).options.settings).toEqual({
          ...REFUSE_PEER_MESSAGES,
          allowedMcpServers: [{ serverName: "parse" }],
          deniedMcpServers: [
            { serverName: "gamma" },
            { serverName: "beta" },
            { serverUrl: "https://*" },
          ],
        });
        expect(claudeSettingsDir({ HOME: "/h" })).toBe(join("/h", ".claude"));
        expect(claudeSettingsDir({ USERPROFILE: "C:\\Users\\me" })).toBe(
          join("C:\\Users\\me", ".claude"),
        );
        expect(claudeSettingsDir({})).toBeUndefined();
        expect(
          widenedEntries(
            ["https://mcp.example.invalid/*"],
            [
              { serverUrl: "https://mcp.example.invalid/teams" },
              { serverCommand: ["evil"] },
              "junk",
            ],
          ),
        ).toEqual([{ serverCommand: ["evil"] }]);
        const emptyDeny = harness();
        yield* openSession({ mcpDenylist: [] }).pipe(Effect.provide(emptyDeny.layer));
        expect(query(emptyDeny).options.settings).toEqual(REFUSE_PEER_MESSAGES);

        const plain = harness();
        yield* openSession({}).pipe(Effect.provide(plain.layer));
        expect(query(plain).options.env).not.toHaveProperty(
          "CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR",
        );
        expect(query(plain).options.settings).toEqual(REFUSE_PEER_MESSAGES);
      }).pipe(Effect.scoped),
  );

  it.effect("keeps an orchestrator's MCP flags and app server on resume without confinement", () =>
    Effect.gen(function* () {
      for (const resume of [{}, { resumeId: "week-old-session" }]) {
        const h = harness();
        const session = yield* openSession({
          audience: "orchestrator",
          mcpAllowlist: [],
          appTools: registry([]),
          ...resume,
        }).pipe(Effect.provide(h.layer));
        const options = query(h).options;
        expect(options.settings).toEqual({ ...REFUSE_PEER_MESSAGES, allowedMcpServers: [] });
        expect(Object.keys(options.mcpServers ?? {})).toEqual([APP_TOOL_SERVER]);
        expect(options).not.toHaveProperty("strictMcpConfig");
        expect(options.env).not.toHaveProperty("ENABLE_CLAUDEAI_MCP_SERVERS");
        expect(session.connectors?.allowlist).toEqual([]);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("serves the registry's gated tools as the gram MCP server", () =>
    Effect.gen(function* () {
      const h = harness();
      const calls: Array<string> = [];
      const session = yield* openSession({ appTools: registry(calls) }).pipe(
        Effect.provide(h.layer),
      );
      const q = query(h);
      expect(calls).toEqual(["t1"]);
      expect(q.options.mcpServers).toEqual({
        gram: { type: "sdk", name: "gram", instance: {} },
      });
      expect(q.options).not.toHaveProperty("allowedTools");
      expect(
        h.tools.map((t) => [
          t.name,
          t.extras?.alwaysLoad,
          Object.keys((t.inputSchema as unknown as { readonly shape: object }).shape),
        ]),
      ).toEqual([
        ["set_title", true, ["title"]],
        ["list_threads", false, ["title"]],
        ["delete_thread", false, ["title"]],
      ]);

      const [setTitle, listThreads] = h.tools;
      expect(yield* Effect.promise(() => setTitle!.handler({ title: "x" }, {}))).toEqual({
        content: [{ type: "text", text: '{"ok":true,"input":{"title":"x"}}' }],
      });
      // The arguments reach `run` as sent, which decodes them; zod guards the MCP boundary.
      expect(yield* Effect.promise(() => setTitle!.handler({ title: "x", pr: 1 }, {}))).toEqual({
        content: [{ type: "text", text: '{"ok":true,"input":{"title":"x","pr":1}}' }],
      });
      expect(yield* Effect.promise(() => listThreads!.handler({ title: "x" }, {}))).toEqual({
        isError: true,
        content: [{ type: "text", text: "db down" }],
      });

      // A bare name is not an app tool, so it gets a normal card.
      void q.canUseTool(
        "set_title",
        { title: "x" },
        { signal: signal(), toolUseID: "t", requestId: "req-b" },
      );
      const [, , bare] = yield* take(session, 3);
      expect(bare).toMatchObject({
        type: "request",
        request: { kind: "approval", toolName: "set_title", scopes: ["once", "session", "always"] },
      });
    }),
  );

  it.effect("binds the tools of the thread's audience", () =>
    Effect.gen(function* () {
      const h = harness();
      const seen: Array<unknown> = [];
      yield* openSession({
        audience: "orchestrator",
        appTools: {
          forThread: () => [],
          forSession: (...args) => {
            seen.push(args);
            return [appTool("set_title", "self", () => Effect.succeed("ok"))];
          },
        },
      }).pipe(Effect.provide(h.layer));
      expect(seen).toEqual([["t1", "orchestrator"]]);
    }),
  );

  it.effect("leaves every app tool's card to the tool's own gate, in every mode", () =>
    Effect.gen(function* () {
      const modes = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"] as const;
      for (const permissionMode of modes) {
        const h = harness();
        const ran: Array<string> = [];
        const tool = (name: string, klass: AppTool["descriptor"]["class"]): AppTool => ({
          ...appTool(name, klass, () => Effect.sync(() => ran.push(name))),
          // What a bound tool carries, which the host no longer reads.
          needsApproval: () => Effect.succeed(true),
        });
        const session = yield* openSession({
          permissionMode,
          outwardGate: "all",
          appTools: registry([], () => [
            tool("set_auto_merge", "outward"),
            tool("move_to_worktree", "crossThread"),
            tool("spawn_worker", "self"),
          ]),
        }).pipe(Effect.provide(h.layer));
        yield* take(session, 2);
        const q = query(h);
        const hook = preToolUse(q);
        // The SDK's mode, rules and classifier don't decide about them, and nothing asks twice.
        for (const name of ["set_auto_merge", "move_to_worktree", "spawn_worker"]) {
          const full = `mcp__gram__${name}`;
          expect(yield* hook(full, { title: "x" })).toEqual({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "allow",
              permissionDecisionReason: expect.any(String),
            },
          });
          expect(
            yield* Effect.promise(() =>
              q.canUseTool(
                full,
                { title: "x" },
                { signal: signal(), toolUseID: "t", requestId: "r" },
              ),
            ),
          ).toEqual(allowed({ title: "x" }));
        }
        // The outward gate still asks about the shell beside them.
        expect(yield* hook("Bash", { command: "git push" })).toEqual(asksWith(OUTWARD_GATE_REASON));
        // The handler is the bound tool's `run`, which is where the gate asks.
        for (const t of h.tools) yield* Effect.promise(() => t.handler({ title: "x" }, {}));
        expect(ran).toEqual(["set_auto_merge", "move_to_worktree", "spawn_worker"]);
      }
    }),
  );

  it.effect("withdraws a waiting gate when the SDK aborts the call", () =>
    Effect.gen(function* () {
      const h = harness();
      let interrupted = false;
      yield* openSession({
        appTools: registry([], () => [
          appTool("send_message", "crossThread", () =>
            Effect.never.pipe(
              Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true))),
            ),
          ),
        ]),
      }).pipe(Effect.provide(h.layer));
      const controller = new AbortController();
      const call = h.tools[0]!.handler({ title: "x" }, { signal: controller.signal });
      yield* settle;
      controller.abort();
      yield* Effect.promise(() =>
        call.then(
          () => undefined,
          () => undefined,
        ),
      );
      expect(interrupted).toBe(true);
    }),
  );
});

describe("ClaudeHost.readSession", () => {
  it.effect("reads one folder's session with system messages, and passes the limit on", () =>
    Effect.gen(function* () {
      const calls: Array<unknown> = [];
      const h = harness({
        sessionMessages: (sessionId, options) => {
          calls.push([sessionId, options]);
          return Promise.resolve(
            sessionId === "s-1"
              ? [
                  {
                    type: "user",
                    uuid: "u1",
                    session_id: "s-1",
                    message: { role: "user", content: "Fix the build" },
                    parent_tool_use_id: null,
                    parent_agent_id: null,
                  },
                ]
              : [],
          );
        },
      });
      const host = yield* ClaudeHost.pipe(Effect.provide(h.layer));
      expect(yield* host.readSession!({ cwd: "/repo", agentSessionId: "s-1" })).toEqual({
        agentSessionId: "s-1",
        cwd: "/repo",
        messages: [{ role: "user", text: "Fix the build" }],
      });
      yield* host.readSession!({ cwd: "/repo", agentSessionId: "s-1", limit: 5 });
      expect(calls).toEqual([
        ["s-1", { dir: "/repo", includeSystemMessages: true }],
        ["s-1", { dir: "/repo", includeSystemMessages: true, limit: 5 }],
      ]);
      // The SDK reports another folder's id as an empty transcript.
      const missing = yield* Effect.flip(
        host.readSession!({ cwd: "/repo", agentSessionId: "s-2" }),
      );
      expect(missing).toMatchObject({ _tag: "NotFound", entity: "session", id: "s-2" });
    }),
  );

  it.effect("fails as unavailable when the SDK can't read, and is absent without a reader", () =>
    Effect.gen(function* () {
      const broken = harness({ sessionMessages: () => Promise.reject(new Error("EACCES")) });
      const host = yield* ClaudeHost.pipe(Effect.provide(broken.layer));
      const error = yield* Effect.flip(host.readSession!({ cwd: "/repo", agentSessionId: "s-1" }));
      expect(error).toMatchObject({ _tag: "AgentUnavailable", agent: "claude" });
      const bare = yield* ClaudeHost.pipe(Effect.provide(harness().layer));
      expect(bare.readSession).toBeUndefined();
    }),
  );
});

/** Just the control calls `makeConnectors` makes, with the servers and sign-ins a test wants. */
const fakeQuery = (
  servers: Array<McpServerStatus>,
  mcpAuthenticate?: (name: string) => Promise<unknown>,
) => {
  const calls: Array<string> = [];
  const q = {
    mcpServerStatus: () => Promise.resolve(servers),
    reconnectMcpServer: (name: string) => {
      calls.push(`reconnect:${name}`);
      return Promise.resolve();
    },
    toggleMcpServer: () => Promise.resolve(),
    ...(mcpAuthenticate === undefined
      ? {}
      : {
          mcpAuthenticate: (name: string) => {
            calls.push(`authenticate:${name}`);
            return mcpAuthenticate(name);
          },
        }),
  };
  return { q, calls, servers };
};

/** A claude.ai connector as a listing has it. */
const hostedServer = (
  name: string,
  status: string,
  extra: Partial<SeenServer> = {},
): SeenServer => ({
  name: `claude.ai ${name}`,
  status,
  source: "claudeai",
  ...extra,
});

/** What each listing in turn leaves lapsed. */
const lapsedAfter = (
  listings: ReadonlyArray<ReadonlyArray<SeenServer>>,
  everConnected: ReadonlyArray<string> = [],
) => {
  let state = NO_LAPSED_CONNECTORS;
  return listings.map(
    (servers) => (state = nextLapsedConnectors(state, servers, new Set(everConnected))).lapsed,
  );
};

describe("nextLapsedConnectors", () => {
  it("flags a connector that worked earlier in the session and is signed out now", () => {
    expect(
      lapsedAfter([
        [hostedServer("Atlassian", "connected"), hostedServer("Gmail", "needs-auth")],
        [hostedServer("Atlassian", "pending"), hostedServer("Gmail", "needs-auth")],
        [hostedServer("Atlassian", "needs-auth"), hostedServer("Gmail", "needs-auth")],
        // A sign-in's reconnect under way: still lapsed until it connects.
        [hostedServer("Atlassian", "pending")],
        [hostedServer("Atlassian", "connected")],
      ]),
    ).toEqual([[], [], ["claude.ai Atlassian"], ["claude.ai Atlassian"], []]);
  });

  it("flags one Claude Code remembers connecting, from the first listing on", () => {
    expect(
      lapsedAfter(
        [[hostedServer("Snowflake", "needs-auth"), hostedServer("Outlook", "disabled")], []],
        ["claude.ai Snowflake", "claude.ai Outlook"],
      ),
    ).toEqual([["claude.ai Snowflake"], []]);
  });

  it("counts a failure only when a status read says the sign-in failed", () => {
    expect(
      lapsedAfter([
        [hostedServer("Teams", "connected"), hostedServer("Jira", "connected")],
        [
          hostedServer("Teams", "failed"),
          hostedServer("Jira", "failed", { error: "connect ECONNREFUSED" }),
        ],
        [hostedServer("Teams", "failed", { error: "HTTP 401 Unauthorized" })],
      ]),
    ).toEqual([[], [], ["claude.ai Teams"]]);
  });

  it("leaves out Claude's own sign-in refused, and servers that aren't claude.ai's", () => {
    const rejected = { errorCode: CLAUDEAI_BEARER_REJECTED };
    expect(
      lapsedAfter(
        [
          [
            { name: "sentry", status: "connected", scope: "user" },
            hostedServer("Teams", "connected"),
          ],
          [
            { name: "sentry", status: "needs-auth", scope: "user" },
            hostedServer("Teams", "needs-auth", rejected),
            hostedServer("Snowflake", "failed", { ...rejected, error: "401" }),
          ],
        ],
        ["claude.ai Snowflake"],
      ),
    ).toEqual([[], []]);
  });

  it("reads a status read's untyped error_code", () => {
    const status = {
      name: "claude.ai Teams",
      status: "needs-auth",
      scope: "claudeai",
      error_code: CLAUDEAI_BEARER_REJECTED,
    } as McpServerStatus;
    expect(seenServer(status)).toMatchObject({ errorCode: CLAUDEAI_BEARER_REJECTED });
  });
});

describe("makeConnectors", () => {
  it.effect("names Gram's allowlist when reconnect is blocked or the connector is missing", () =>
    Effect.gen(function* () {
      const { q, calls } = fakeQuery([]);
      const blocked = {
        ...q,
        reconnectMcpServer: (name: string) => {
          calls.push(`reconnect:${name}`);
          return Promise.reject(
            new Error(
              name === "teams"
                ? "MCP server teams is blocked by enterprise managed policy"
                : `Server not found: ${name}`,
            ),
          );
        },
      };
      const connectors = makeConnectors(blocked, { audience: "orchestrator", mcpAllowlist: [] });
      const teams = yield* Effect.flip(connectors.reconnect("teams"));
      expect(teams.message).toContain(
        "Gram's orchestrator connector allowlist doesn't include teams",
      );
      expect(teams.message).toContain("add it to Settings → Workspaces → Orchestrator connectors");
      expect(teams.message).toContain("then restart the session");
      const notes = yield* Effect.flip(connectors.reconnect("claude.ai Notes"));
      expect(notes.message).toContain("allowlist doesn't include claude.ai Notes");
      expect(notes.message).toContain("upstream URL");
      expect(teams.message).not.toContain("enterprise managed policy");
      expect(calls).toEqual(["reconnect:teams", "reconnect:claude.ai Notes"]);

      const confined = makeConnectors(blocked, { confineWrites: true, mcpAllowlist: ["teams"] });
      expect((yield* Effect.flip(confined.reconnect("teams"))).message).toContain(
        "confined session",
      );
      const urlGrant = makeConnectors(blocked, {
        audience: "orchestrator",
        mcpAllowlist: ["https://mcp.example.test/*"],
      });
      expect((yield* Effect.flip(urlGrant.reconnect("claude.ai Notes"))).message).toContain(
        "Check Gram's orchestrator connector allowlist",
      );

      // A worker's lists are its workspace's, which reopen the session by themselves.
      const worker = makeConnectors(blocked, { audience: "worker", mcpAllowlist: ["parse"] });
      const workerTeams = (yield* Effect.flip(worker.reconnect("teams"))).message;
      expect(workerTeams).toContain("workspace connector allowlist doesn't include teams");
      expect(workerTeams).toContain("picks the change up once it is idle");
      const denied = makeConnectors(blocked, { audience: "worker", mcpDenylist: ["teams"] });
      expect((yield* Effect.flip(denied.reconnect("teams"))).message).toContain(
        "This workspace's connectors leave out teams",
      );
      // An orchestrator listing none is held only by its workspace where tool search is on,
      // and gets none of the user's servers where it isn't.
      const byWorkspace = makeConnectors(blocked, {
        audience: "orchestrator",
        mcpNoneWithoutToolSearch: true,
        mcpAllowlist: ["parse"],
      });
      expect((yield* Effect.flip(byWorkspace.reconnect("teams"))).message).toContain(
        "workspace connector allowlist doesn't include teams",
      );
      const lean = makeConnectors(
        blocked,
        { audience: "orchestrator", mcpNoneWithoutToolSearch: true, mcpAllowlist: [] },
        { noToolSearch: true },
      );
      const leanTeams = (yield* Effect.flip(lean.reconnect("teams"))).message;
      expect(leanTeams).toContain("without tool search, as on a gateway key");
      expect(leanTeams).toContain("add it to Settings → Workspaces → Orchestrator connectors");
      expect(leanTeams).toContain("then restart the session");
      const deniedByUrl = makeConnectors(blocked, {
        audience: "worker",
        mcpDenylist: ["https://mcp.example.test/*"],
      });
      expect((yield* Effect.flip(deniedByUrl.reconnect("claude.ai Notes"))).message).toContain(
        "Check this workspace's connectors for claude.ai Notes",
      );
    }),
  );

  it.effect("keeps upstream errors when Gram hasn't excluded the connector", () =>
    Effect.gen(function* () {
      const { q } = fakeQuery([]);
      for (const message of [
        "MCP server teams is blocked by enterprise managed policy",
        "Connection timed out",
      ]) {
        const blocked = { ...q, reconnectMcpServer: () => Promise.reject(new Error(message)) };
        for (const policy of [{}, { mcpAllowlist: ["teams"] }]) {
          expect(
            (yield* Effect.flip(makeConnectors(blocked, policy).reconnect("teams"))).message,
          ).toBe(`Claude Code couldn't change its connectors: ${message}`);
        }
        if (message === "Connection timed out") {
          expect(
            (yield* Effect.flip(makeConnectors(blocked, { mcpAllowlist: [] }).reconnect("teams")))
              .message,
          ).toBe(`Claude Code couldn't change its connectors: ${message}`);
        }
      }
    }),
  );

  it.effect("starts Claude Code's own sign-in and hands back the page to open", () =>
    Effect.gen(function* () {
      const page = {
        authUrl: "https://auth.sentry.dev/authorize?state=s",
        requiresUserAction: true,
        callbackExpected: true,
        callbackPort: 53111,
      };
      const sentry: McpServerStatus = { name: "sentry", status: "needs-auth", scope: "user" };
      const { q, calls } = fakeQuery([sentry], () => Promise.resolve(page));
      const connectors = makeConnectors(q);
      expect(yield* connectors.status).toEqual([
        { name: "sentry", status: "needs-auth", scope: "user" },
      ]);
      expect(yield* connectors.authenticate!("sentry")).toEqual({
        authorizationUrl: "https://auth.sentry.dev/authorize?state=s",
      });
      // Claude Code takes the callback and reconnects the server itself.
      yield* TestClock.adjust("1 minute");
      yield* connectors.status;
      expect(calls).toEqual(["authenticate:sentry"]);
    }),
  );

  it.effect("says so when already signed in, and refuses a page that isn't a web address", () =>
    Effect.gen(function* () {
      const answers: Array<unknown> = [
        { requiresUserAction: false, callbackExpected: false },
        { authUrl: "file:///etc/passwd", callbackExpected: true },
        "garbled",
      ];
      const { q } = fakeQuery([], () => Promise.resolve(answers.shift()));
      const connectors = makeConnectors(q);
      expect(yield* connectors.authenticate!("sentry")).toBe("started");
      const notWeb = yield* Effect.flip(connectors.authenticate!("sentry"));
      expect(notWeb).toMatchObject({ _tag: "AgentUnavailable", agent: "claude" });
      expect(notWeb.message).toContain("isn't a web address");
      const garbled = yield* Effect.flip(connectors.authenticate!("sentry"));
      expect(garbled.message).toContain("its answer wasn't a sign-in page");
      const own = yield* Effect.flip(connectors.authenticate!(APP_TOOL_SERVER));
      expect(own.message).toContain("don't need a sign-in");
    }),
  );

  it.effect("passes on why Claude Code couldn't start one", () =>
    Effect.gen(function* () {
      const { q } = fakeQuery([], () =>
        Promise.reject(new Error('Server type "stdio" does not support OAuth authentication')),
      );
      const error = yield* Effect.flip(makeConnectors(q).authenticate!("files"));
      expect(error.message).toContain("signing in to files: Server type");
      expect(error.message).toContain("does not support OAuth authentication");
    }),
  );

  it.effect("reconnects a claude.ai connector now and then until the user has finished", () =>
    Effect.gen(function* () {
      // claude.ai's own page, which calls nobody back.
      const page = {
        authUrl: "https://claude.ai/api/organizations/o/mcp/start-auth/s",
        requiresUserAction: true,
        callbackExpected: false,
      };
      const linear: McpServerStatus = { name: "linear", status: "needs-auth", scope: "claudeai" };
      const refused: McpServerStatus = { ...linear, status: "failed", error: "HTTP 401" };
      const { q, calls, servers } = fakeQuery([linear], () => Promise.resolve(page));
      const connectors = makeConnectors(q);
      yield* connectors.authenticate!("linear");
      yield* connectors.status;
      expect(calls).toEqual(["authenticate:linear"]);
      yield* TestClock.adjust("5 seconds");
      yield* connectors.status;
      yield* connectors.status;
      expect(calls).toEqual(["authenticate:linear", "reconnect:linear"]);
      // A sign-in refused on the way is still one to wait for.
      servers[0] = refused;
      yield* TestClock.adjust("5 seconds");
      yield* connectors.status;
      expect(calls).toEqual(["authenticate:linear", "reconnect:linear", "reconnect:linear"]);
      servers[0] = { ...linear, status: "connected" };
      yield* TestClock.adjust("5 seconds");
      yield* connectors.status;
      servers[0] = linear;
      yield* TestClock.adjust("5 seconds");
      yield* connectors.status;
      expect(calls).toEqual(["authenticate:linear", "reconnect:linear", "reconnect:linear"]);
    }),
  );

  it.effect("keeps a claude.ai connector's address, tools and what claude.ai says of it", () =>
    Effect.gen(function* () {
      const kb = {
        name: "claude.ai Internal KB",
        status: "connected",
        scope: "claudeai",
        source: "claudeai",
        config: {
          type: "claudeai-proxy",
          url: "https://mcp.example.invalid/internal-kb",
          id: "mcpsrv_1",
        },
        tools: [
          { name: "search", description: "Search", annotations: { readOnly: true } },
          { name: "purge", annotations: { destructive: true, readOnly: false } },
          { name: "plain", _meta: { ui: { resourceUri: "ui://x" } } },
        ],
      } satisfies McpServerStatus;
      // Fields Claude Code sends beyond its typings: the catalogue's word, and why it failed.
      const blocked = {
        name: "claude.ai Gmail",
        status: "failed",
        scope: "claudeai",
        config: {
          type: "claudeai-proxy",
          url: "https://gmail.example/mcp?key=hunter2hunter2",
          id: "mcpsrv_2",
          eligible: false,
          ineligibleReason: "Not allowed for your seat",
          enterpriseManaged: true,
        },
      } as McpServerStatus;
      const rejected = {
        name: "claude.ai Teams",
        status: "needs-auth",
        scope: "claudeai",
        config: { type: "claudeai-proxy", url: "https://teams.example/mcp", id: "mcpsrv_3" },
        error_code: "CLAUDEAI_BEARER_REJECTED",
      } as McpServerStatus;
      const local: McpServerStatus = {
        name: "files",
        status: "connected",
        scope: "local",
        config: { type: "stdio", command: "npx" },
      };
      const { q } = fakeQuery([kb, blocked, rejected, local], () => Promise.resolve({}));
      const [hosted, policy, signIn, stdio] = yield* makeConnectors(q).status;
      expect(hosted).toEqual({
        name: "claude.ai Internal KB",
        status: "connected",
        scope: "claudeai",
        source: "claudeai",
        url: "https://mcp.example.invalid/internal-kb",
        tools: [
          { name: "search", readOnly: true },
          { name: "purge", readOnly: false, destructive: true },
          { name: "plain" },
        ],
        claudeAi: { id: "mcpsrv_1" },
      });
      expect(policy).toMatchObject({
        url: "https://gmail.example/mcp?key=••••",
        claudeAi: { id: "mcpsrv_2", blocked: "Not allowed for your seat", orgManaged: true },
      });
      // A connector sign-in can't fix Claude's own, so it isn't offered.
      expect(signIn).toMatchObject({
        claudeAi: { claudeSignInRejected: true },
        signInUnavailable: CLAUDE_SIGN_IN_AGAIN,
      });
      expect(stdio).toEqual({ name: "files", status: "connected", scope: "local" });
      expect(makeConnectors(q)).not.toHaveProperty("claudeAiUnavailable");
      expect(makeConnectors(q, {}, { gateway: true }).claudeAiUnavailable).toBe(
        GATEWAY_CLAUDE_AI_NOTE,
      );
    }),
  );

  it.effect("points to /mcp when the SDK has no way to start a sign-in", () =>
    Effect.gen(function* () {
      const { q } = fakeQuery([{ name: "linear", status: "needs-auth", scope: "claudeai" }]);
      const connectors = makeConnectors(q);
      expect(connectors.authenticate).toBeUndefined();
      expect(yield* connectors.status).toEqual([
        {
          name: "linear",
          status: "needs-auth",
          scope: "claudeai",
          signInUnavailable: CLAUDE_SIGN_IN_HINT,
        },
      ]);
    }),
  );
});

it.effect(
  "a failed switch with no child closes its spawn capability before releasing proof",
  () => {
    const h = harness({ startupError: "Synthetic initialization refusal" });
    return Effect.scoped(
      Effect.gen(function* () {
        const host = yield* ClaudeHost;
        yield* host
          .open({
            threadId: ThreadId.make("switch-no-child"),
            cwd: "/synthetic",
            switchStartup: "synthetic-no-child",
          })
          .pipe(Effect.flip);
        expect(yield* host.switchAttemptReceipt!("synthetic-no-child")).toBe("notStarted");
        // A late SDK callback is rejected before Node spawn, including after scope disposal.
        expect(() =>
          h.queries[0]!.options.spawnClaudeCodeProcess!({
            command: "/synthetic/not-a-cli",
            args: [],
            cwd: "/synthetic",
            env: {},
            signal: new AbortController().signal,
          }),
        ).toThrow("no longer permits a child");
        expect(yield* host.switchAttemptReceipt!("unregistered")).toBeUndefined();
      }),
    ).pipe(Effect.provide(h.layer));
  },
);

describe("Claude subscription limits", () => {
  it.effect("queries without inference, history scanning, hooks or MCP, and closes the CLI", () =>
    Effect.gen(function* () {
      const h = harness({ usage: async () => claudeUsage });
      const host = yield* ClaudeHost.pipe(Effect.provide(h.layer));
      expect(yield* host.readSubscriptionLimits!).toMatchObject([
        { window: "five_hour", utilization: 0.44 },
        { window: "seven_day", utilization: 0.96 },
      ]);
      const q = query(h);
      expect(q.calls).toEqual(['get_usage:{"skipBehaviors":true}']);
      expect(q.inputs).toEqual([]);
      expect(q.closed).toBe(true);
      expect(q.options).toMatchObject({
        strictMcpConfig: true,
        settingSources: [],
        tools: [],
        persistSession: false,
        extraArgs: { "safe-mode": null },
        env: { ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
      });
      expect(h.authChecks.count).toBe(1);
    }),
  );
  it.effect("closes a timed-out metadata query", () =>
    Effect.gen(function* () {
      const h = harness({ config: { startupTimeoutMs: 1000 }, usage: () => new Promise(() => {}) });
      const host = yield* ClaudeHost.pipe(Effect.provide(h.layer));
      const fiber = yield* Effect.flip(host.readSubscriptionLimits!).pipe(Effect.forkScoped);
      yield* TestClock.adjust(1001);
      expect((yield* Fiber.join(fiber)).reason).toBe("startup-failed");
      expect(query(h).closed).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("never starts a query when signed out", () =>
    Effect.gen(function* () {
      const h = harness({
        auth: Effect.fail(
          new AgentUnavailable({
            agent: "claude",
            reason: "not-logged-in",
            message: "synthetic signed-out",
          }),
        ),
      });
      const host = yield* ClaudeHost.pipe(Effect.provide(h.layer));
      expect((yield* Effect.flip(host.readSubscriptionLimits!)).reason).toBe("not-logged-in");
      expect(h.queries).toEqual([]);
    }),
  );
  it.effect("closes the query on a failed usage read without leaking the provider error", () =>
    Effect.gen(function* () {
      const h = harness({
        usage: async () => {
          throw new Error("synthetic private response");
        },
      });
      const host = yield* ClaudeHost.pipe(Effect.provide(h.layer));
      expect((yield* Effect.flip(host.readSubscriptionLimits!)).message).toBe(
        "Claude Code could not read subscription limits.",
      );
      expect(query(h).closed).toBe(true);
    }),
  );
});
