import {
  AgentUnavailable,
  AnswerUndelivered,
  ModeRefused,
  RequestId,
  type AgentCapabilities,
  type AgentEvent,
  type AgentModel,
  type MessageId,
  type PermissionMode,
  type ReasoningVariant,
  type RequestAnswer,
  type SessionPreview,
  type SessionTranscriptMessage,
  type SlashCommand,
  type SubscriptionLimitReport,
  type UserInput,
  NotFound,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

import { APP_TOOLS_SERVER_NAME } from "../app-tools.ts";
import {
  BUILT_IN_TOGGLE_REASON,
  type AgentConnectors,
  type AgentHost,
  type AgentSession,
  type ConnectorStatus,
  type OpenSessionOptions,
  type OutwardGate,
} from "../host.ts";
import { listsLeaveOut, narrowsMcp, reportedLists } from "../mcp-lists.ts";
import { gateAsks, gateLevel, outwardKind } from "../outward.ts";
import { AcpError, type AcpConnection, type AcpHandlers, type StartAcpAgent } from "./acp.ts";
import {
  grokToolName,
  makeGrokMapper,
  optionFor,
  toolFor,
  type PermissionOption,
} from "./mapper.ts";

export const GROK_CAPABILITIES: AgentCapabilities = {
  fork: false,
  rewind: "none",
  steer: true,
  steerInterrupt: true,
  planMode: true,
  approvalScopes: ["once", "session", "always"],
  userQuestions: false,
  costReporting: true,
  perTurnModel: true,
  reasoningEffort: true,
  listSessions: true,
  subagentStreams: false,
  stopTasks: false,
};

/**
 * The arguments every Grok Build agent starts with. The permission mode is always given, so the
 * user's own default (which may approve everything) never applies to a Gram thread; the session's
 * mode is then set over ACP. `--no-leader` keeps each session in a process of its own.
 */
export const GROK_AGENT_ARGS = [
  "--permission-mode",
  "default",
  "agent",
  "--no-leader",
  "stdio",
] as const;

const unavailable = (message: string) => new AgentUnavailable({ agent: "grok", message });

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** What a failed start or session says when the CLI has no usable sign-in. */
export const SIGN_IN_MESSAGE =
  "Not signed in. Run `grok login` in a terminal, then start the thread again.";

const signInProblem = (message: string): boolean =>
  /auth|sign[ -]?in|log ?in|unauthori[sz]ed|credential|token expired/i.test(message);

const failure = (what: string, error: unknown) => {
  const message = messageOf(error);
  return unavailable(signInProblem(message) ? SIGN_IN_MESSAGE : `${what}: ${message}`);
};

type Json = Readonly<Record<string, unknown>>;
const record = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};
const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const EFFORTS: ReadonlySet<string> = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

/** The models an `initialize` or `session/new` lists, as the pickers show them. */
export const grokModels = (state: Json): ReadonlyArray<AgentModel> =>
  (Array.isArray(state["availableModels"]) ? state["availableModels"] : [])
    .map(record)
    .flatMap((model): Array<AgentModel> => {
      const id = text(model["modelId"]);
      if (id === undefined) return [];
      const meta = record(model["_meta"]);
      const efforts = (Array.isArray(meta["reasoningEfforts"]) ? meta["reasoningEfforts"] : [])
        .map((effort) => text(record(effort)["value"]))
        .filter(
          (effort): effort is ReasoningVariant => effort !== undefined && EFFORTS.has(effort),
        );
      const description = text(model["description"]);
      return [
        {
          id,
          displayName: text(model["name"]) ?? id,
          ...(description === undefined ? {} : { description }),
          supportsEffort: meta["supportsReasoningEffort"] === true && efforts.length > 0,
          ...(efforts.length > 0 ? { efforts } : {}),
        },
      ];
    });

/**
 * The plan's credits as `x.ai/billing` reports them, as Gram's subscription windows: a weekly
 * period is the `seven_day` window. A monthly one has no window of Gram's, so it gives nothing.
 * Prepaid credits keep turns going past a used-up allowance.
 */
export const billingLimits = (response: Json): ReadonlyArray<SubscriptionLimitReport> => {
  const config = record(response["config"]);
  const percent = config["creditUsagePercent"];
  const period = record(config["currentPeriod"]);
  if (typeof percent !== "number" || !Number.isFinite(percent)) return [];
  if (text(period["type"]) !== "USAGE_PERIOD_TYPE_WEEKLY") return [];
  const utilization = Math.min(1, Math.max(0, percent / 100));
  const resetsAt = Date.parse(text(period["end"]) ?? "");
  const prepaid = record(config["prepaidBalance"])["val"];
  const credits = typeof prepaid === "number" && prepaid > 0;
  return [
    {
      window: "seven_day",
      utilization,
      status: utilization >= 1 ? "rejected" : "allowed",
      ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
      ...(credits ? { credits: true, creditsAvailable: true } : {}),
    },
  ];
};

/** The context window `state` gives for `model`. */
export const contextWindowOf = (state: Json, model: string | undefined): number | undefined => {
  const entry = (Array.isArray(state["availableModels"]) ? state["availableModels"] : [])
    .map(record)
    .find((each) => text(each["modelId"]) === model);
  const tokens = record(entry?.["_meta"])["totalContextTokens"];
  return typeof tokens === "number" && Number.isInteger(tokens) && tokens > 0 ? tokens : undefined;
};

/**
 * How Grok Build should hold permissions for a Gram mode. `ask` sends every call its own policy
 * doesn't clear to Gram, which answers some itself (`autoAnswer`). Bypass and auto run on Grok's
 * own always-approve and classifier, but not under an outward gate: Gram has to see each command
 * then, so the session asks and Gram lets through what the gate doesn't stop.
 */
export const grokPermission = (
  mode: PermissionMode,
  gate: OutwardGate | undefined,
): "ask" | "auto" | "always-approve" => {
  if (gate !== undefined) return "ask";
  if (mode === "bypassPermissions") return "always-approve";
  if (mode === "auto") return "auto";
  return "ask";
};

/** The `x.ai/yolo_mode_changed` params that put a session in `permission`. */
export const permissionParams = (permission: "ask" | "auto" | "always-approve"): Json => ({
  yolo_mode: permission === "always-approve",
  auto_mode: permission === "auto",
  permission_mode: permission,
});

/**
 * The answer Gram gives a permission request itself, without a card: Gram's own app tools go
 * through, as their registry raises its own card where one is needed; `dontAsk` refuses, edits go
 * through in `acceptEdits`, and a mode that would have run the call unasked lets it through when
 * the outward gate doesn't ask about it. `undefined` shows the card.
 */
export const autoAnswer = (
  mode: PermissionMode,
  gate: OutwardGate | undefined,
  call: Json,
): "allow" | "deny" | undefined => {
  const tool = text(record(call["rawInput"])["tool_name"]);
  if (tool?.startsWith(`${APP_TOOLS_SERVER_NAME}__`) === true) return "allow";
  if (mode === "dontAsk") return "deny";
  const kind = text(call["kind"]);
  if (mode === "acceptEdits" && kind === "edit") return "allow";
  if (mode !== "bypassPermissions" && mode !== "auto") return undefined;
  if (gate === undefined) return "allow";
  if (kind !== "execute") return "allow";
  const command = text(record(call["rawInput"])["command"]);
  if (command === undefined) return undefined;
  return gateAsks(gate, outwardKind(command)) ? undefined : "allow";
};

/** The largest image sent inline; a bigger one goes as a link to its file. */
const IMAGE_INLINE_MAX = 10 * 1024 * 1024;

/**
 * A message as ACP content: its text, each image inline (Grok Build reads images), and every other
 * attachment as a link to its file, which Grok reads with its own tools.
 */
export const promptOf = async (
  input: UserInput,
  read: (path: string) => Promise<Uint8Array> = readFile,
): Promise<ReadonlyArray<Json>> => {
  const blocks: Array<Json> = [{ type: "text", text: input.text }];
  for (const attachment of input.attachments ?? []) {
    const name = attachment.name ?? attachment.path.split(/[\\/]/).at(-1) ?? attachment.path;
    if (attachment.mediaType?.startsWith("image/") === true) {
      const bytes = await read(attachment.path).catch(() => undefined);
      if (bytes !== undefined && bytes.byteLength <= IMAGE_INLINE_MAX) {
        blocks.push({
          type: "image",
          mimeType: attachment.mediaType,
          data: Buffer.from(bytes).toString("base64"),
        });
        continue;
      }
    }
    blocks.push({
      type: "resource_link",
      uri: pathToFileURL(attachment.path).href,
      name,
      ...(attachment.mediaType === undefined ? {} : { mimeType: attachment.mediaType }),
    });
  }
  return blocks;
};

/** Grok Build's `available_commands_update` as Gram's slash commands. */
export const grokCommands = (update: Json): ReadonlyArray<SlashCommand> =>
  (Array.isArray(update["availableCommands"]) ? update["availableCommands"] : [])
    .map(record)
    .flatMap((command): Array<SlashCommand> => {
      const name = text(command["name"]);
      if (name === undefined || name === "") return [];
      const hint = text(record(command["input"])["hint"]);
      return [
        {
          name,
          description: text(command["description"]) ?? "",
          ...(hint === undefined ? {} : { argumentHint: hint }),
        },
      ];
    });

/** A server's state in `x.ai/mcp/list` as Gram's connector status. */
export const connectorOf = (entry: Json): ConnectorStatus | undefined => {
  const name = text(entry["name"]);
  if (name === undefined) return undefined;
  const session = record(entry["session"]);
  const builtIn = name === APP_TOOLS_SERVER_NAME;
  const status: ConnectorStatus["status"] =
    session["enabled"] === false
      ? "disabled"
      : session["authRequired"] === true || session["status"] === "setupRequired"
        ? "needs-auth"
        : session["status"] === "ready"
          ? "connected"
          : session["status"] === "unavailable"
            ? "failed"
            : "pending";
  const tools = (Array.isArray(session["tools"]) ? session["tools"] : [])
    .map(record)
    .flatMap((tool) => {
      const toolName = text(tool["name"]);
      return toolName === undefined ? [] : [{ name: toolName }];
    });
  const blocked = text(session["blockedReason"]);
  const source = text(entry["source"]);
  return {
    name,
    status,
    ...(blocked === undefined ? {} : { error: blocked }),
    ...(source === undefined ? {} : { source }),
    ...(tools.length > 0 ? { tools } : {}),
    ...(builtIn ? { builtIn: true, toggleUnavailable: BUILT_IN_TOGGLE_REASON } : {}),
  };
};

/**
 * A past session's main conversation from the updates `session/load` replays: each user message,
 * and each reply with the calls it made, in order.
 */
export const transcriptOf = (updates: ReadonlyArray<Json>): Array<SessionTranscriptMessage> => {
  const messages: Array<SessionTranscriptMessage> = [];
  let last:
    | { role: "user" | "assistant"; text: string; tools: Array<{ name: string }>; at?: number }
    | undefined;
  const flush = () => {
    if (last === undefined) return;
    if (last.text.trim() !== "" || last.tools.length > 0)
      messages.push({
        role: last.role,
        text: last.text.trim(),
        ...(last.tools.length > 0 ? { tools: last.tools } : {}),
        ...(last.at === undefined ? {} : { at: last.at }),
      });
    last = undefined;
  };
  for (const params of updates) {
    const update = record(params["update"]);
    const kind = update["sessionUpdate"];
    const stamp = record(params["_meta"])["agentTimestampMs"];
    const at = typeof stamp === "number" ? stamp : undefined;
    const role =
      kind === "user_message_chunk"
        ? "user"
        : kind === "agent_message_chunk" || kind === "tool_call"
          ? "assistant"
          : undefined;
    if (role === undefined) continue;
    if (last?.role !== role) {
      flush();
      last = { role, text: "", tools: [], ...(at === undefined ? {} : { at }) };
    }
    if (kind === "tool_call") last.tools.push({ name: toolFor(grokToolName(update), {}).name });
    else last.text += text(record(update["content"])["text"]) ?? "";
  }
  flush();
  return messages;
};

export interface GrokHostConfig {
  /** The `grok` executable; fails when it isn't installed. */
  readonly binary: Effect.Effect<string, AgentUnavailable>;
  /** The user's login-shell environment, which the CLI runs in. */
  readonly env: Effect.Effect<Readonly<Record<string, string | undefined>>>;
  /** Starts an agent process; tests stand one in. */
  readonly start: (input: StartAcpAgent) => AcpConnection;
  readonly newMessageId: () => MessageId;
}

const CLIENT_INFO = { name: "gram", version: "1" } as const;

const initializeParams = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: CLIENT_INFO,
};

/** How long a model listing is kept before the CLI is asked again. */
const MODELS_TTL_MS = 5 * 60_000;

/**
 * The Grok Build host: one `grok agent stdio` per session, on the user's own sign-in, driven over
 * the Agent Client Protocol. Grok keeps the session; Gram resumes it by id.
 */
/**
 * `connection` signing in headless right after `initialize` when its environment hands the CLI a
 * token command (`GROK_AUTH_PROVIDER_COMMAND`), as a sandbox's does: there the CLI holds no login of
 * its own and must be told to take the command's token.
 */
export const withHeadlessSignIn = (
  connection: AcpConnection,
  env: Readonly<Record<string, string | undefined>>,
): AcpConnection => {
  const command = env["GROK_AUTH_PROVIDER_COMMAND"];
  if (command === undefined || command.trim() === "") return connection;
  return {
    ...connection,
    request: async <T>(method: string, params: Record<string, unknown>) => {
      const result = await connection.request<T>(method, params);
      if (method === "initialize")
        await connection.request("authenticate", {
          methodId: "grok.com",
          _meta: { headless: true },
        });
      return result;
    },
  };
};

const launchWith = (config: GrokHostConfig, cwd: string, handlers: AcpHandlers) =>
  Effect.gen(function* () {
    const binary = yield* config.binary;
    const env = yield* config.env;
    return yield* Effect.try({
      try: () =>
        withHeadlessSignIn(
          config.start({ binary, args: GROK_AGENT_ARGS, env, cwd, handlers }),
          env,
        ),
      catch: (error) => failure("Grok Build didn't start", error),
    });
  });

export const makeGrokHost = (config: GrokHostConfig): Effect.Effect<AgentHost> => {
  const ignoring: AcpHandlers = {
    notification: () => {},
    request: () => Promise.reject(new AcpError(-32601, "Not supported")),
  };

  let models: { at: number; list: ReadonlyArray<AgentModel> } | undefined;
  const listModels = Effect.gen(function* () {
    if (models !== undefined && Date.now() - models.at < MODELS_TTL_MS) return models.list;
    const connection = yield* launchWith(config, homedir(), ignoring);
    const list = yield* Effect.tryPromise({
      try: async () => {
        try {
          const result = record(await connection.request("initialize", initializeParams));
          return grokModels(record(record(result["_meta"])["modelState"]));
        } finally {
          await connection.stop();
        }
      },
      catch: (error) => failure("Couldn't list Grok Build's models", error),
    });
    models = { at: Date.now(), list };
    return list;
  });

  /** A past session of `cwd`, replayed by `session/load` into a process of its own. */
  const readPast = (cwd: string, agentSessionId: string) =>
    Effect.gen(function* () {
      const replayed: Array<Json> = [];
      const connection = yield* launchWith(config, cwd, {
        notification: (method, params) => {
          if (method === "session/update" && text(params["sessionId"]) === agentSessionId)
            replayed.push(params);
        },
        request: () => Promise.reject(new AcpError(-32601, "Not supported")),
      });
      const loaded = yield* Effect.tryPromise({
        try: async () => {
          try {
            await connection.request("initialize", initializeParams);
            await connection.request("session/load", {
              sessionId: agentSessionId,
              cwd,
              mcpServers: [],
            });
            return true;
          } catch (error) {
            if (error instanceof AcpError && error.code !== -32000) return false;
            throw error;
          } finally {
            await connection.stop();
          }
        },
        catch: (error) => failure("Couldn't read the Grok Build session", error),
      });
      if (!loaded)
        return yield* new NotFound({
          entity: "session",
          id: agentSessionId,
          message: `No Grok Build session ${agentSessionId} in ${cwd}.`,
        });
      return transcriptOf(replayed);
    });

  const open = (options: OpenSessionOptions) =>
    Effect.gen(function* () {
      if (options.dreamFilesOnly === true || options.confineWrites === true)
        return yield* Effect.fail(
          unavailable("Grok Build can't keep a session's writes, shell and network bounded."),
        );
      if (options.model?.profileId !== undefined)
        return yield* Effect.fail(
          unavailable("Grok Build runs on its own sign-in, not a gateway."),
        );

      const events = yield* Queue.unbounded<AgentEvent>();
      const emit = (out: ReadonlyArray<AgentEvent>) => {
        for (const event of out) Queue.offerUnsafe(events, event);
      };
      let sessionId: string | undefined;
      let mapper: ReturnType<typeof makeGrokMapper> | undefined;
      let mode: PermissionMode = options.permissionMode ?? "default";
      const gate = gateLevel(options.outwardGate);
      const pending = new Map<
        RequestId,
        { options: ReadonlyArray<PermissionOption>; answer: (result: Json) => void }
      >();

      let commands: ReadonlyArray<SlashCommand> = [];
      let identity: Extract<AgentEvent, { type: "identity" }> | undefined;
      const onUpdate = (params: Json) => {
        const update = record(params["update"]);
        if (update["sessionUpdate"] === "available_commands_update") {
          commands = grokCommands(update);
          if (identity !== undefined) {
            identity = { ...identity, commands };
            Queue.offerUnsafe(events, identity);
          }
          return;
        }
        if (mapper === undefined) return;
        if (text(params["sessionId"]) !== sessionId) return;
        emit(mapper.update(update));
      };

      const handlers: AcpHandlers = {
        notification: (method, params) => {
          if (method === "session/update" || method === "_x.ai/session_notification")
            onUpdate(params);
        },
        request: (method, params) => {
          if (method !== "session/request_permission")
            return Promise.reject(new AcpError(-32601, `${method} is not supported`));
          const call = record(params["toolCall"]);
          const offered = (Array.isArray(params["options"]) ? params["options"] : [])
            .map(record)
            .flatMap((option): Array<PermissionOption> => {
              const optionId = text(option["optionId"]);
              const kind = text(option["kind"]);
              return optionId === undefined || kind === undefined ? [] : [{ optionId, kind }];
            });
          const own = autoAnswer(mode, gate, call);
          if (own !== undefined) {
            const option = optionFor(offered, own, "once");
            return Promise.resolve(
              option === undefined
                ? { outcome: { outcome: "cancelled" } }
                : { outcome: { outcome: "selected", optionId: option.optionId } },
            );
          }
          return new Promise((resolve) => {
            const requestId = RequestId.make(randomUUID());
            pending.set(requestId, { options: offered, answer: resolve });
            if (mapper !== undefined) emit(mapper.permission(requestId, params));
          });
        },
      };

      const connection = yield* launchWith(config, options.cwd, handlers);
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          for (const each of pending.values()) each.answer({ outcome: { outcome: "cancelled" } });
          pending.clear();
          await connection.stop();
        }),
      );

      const call = <T = unknown>(what: string, method: string, params: Record<string, unknown>) =>
        Effect.tryPromise({
          try: () => connection.request<T>(method, params),
          catch: (error) => failure(what, error),
        });

      const initialized = record(
        yield* call("Grok Build didn't start", "initialize", initializeParams),
      );
      const capabilities = record(initialized["agentCapabilities"]);
      const mcpServers = [
        ...(options.mcp === undefined
          ? []
          : [
              {
                type: "http",
                name: APP_TOOLS_SERVER_NAME,
                url: options.mcp.url,
                headers: Object.entries(options.mcp.headers).map(([name, value]) => ({
                  name,
                  value,
                })),
              },
            ]),
        ...(options.mcpServer === undefined
          ? []
          : [
              {
                type: "http",
                name: options.mcpServer.name,
                url: options.mcpServer.url,
                headers: [],
              },
            ]),
      ];
      // The role's standing instructions join Grok's system prompt; Grok keeps them with the session.
      const instructions = options.instructions?.trim();
      const base = {
        cwd: options.cwd,
        mcpServers,
        ...(instructions === undefined || instructions === ""
          ? {}
          : { _meta: { rules: instructions } }),
      };
      let opened: Json;
      if (options.resumeId !== undefined) {
        const resumable = record(capabilities["sessionCapabilities"])["resume"] !== undefined;
        opened = record(
          yield* call(
            "Couldn't resume the Grok Build session",
            resumable ? "session/resume" : "session/load",
            { ...base, sessionId: options.resumeId },
          ),
        );
        sessionId = options.resumeId;
      } else {
        opened = record(yield* call("Couldn't start a Grok Build session", "session/new", base));
        sessionId = text(opened["sessionId"]);
        if (sessionId === undefined)
          return yield* Effect.fail(unavailable("Grok Build didn't name its session."));
      }
      const id = sessionId;
      const modelState = record(opened["models"]);
      mapper = makeGrokMapper({ sessionId: id, newMessageId: config.newMessageId });
      const current = mapper;

      const setPermission = (next: PermissionMode) =>
        connection.notify("_x.ai/yolo_mode_changed", {
          ...permissionParams(grokPermission(next, gate)),
        });
      const setSessionMode = (next: PermissionMode) =>
        connection.request("session/set_mode", {
          sessionId: id,
          modeId: next === "plan" ? "plan" : "default",
        });
      setPermission(mode);
      if (mode === "plan")
        yield* call("Couldn't put Grok Build in plan mode", "session/set_mode", {
          sessionId: id,
          modeId: "plan",
        });

      let model = text(modelState["currentModelId"]) ?? "";
      const applyModel = (wanted: string | undefined, effort: ReasoningVariant | undefined) =>
        Effect.gen(function* () {
          if (wanted !== undefined && wanted !== "" && wanted !== "default" && wanted !== model) {
            yield* call("Grok Build didn't change model", "session/set_model", {
              sessionId: id,
              modelId: wanted,
            });
            model = wanted;
          }
          if (effort !== undefined)
            yield* call("Grok Build didn't change reasoning effort", "session/set_config_option", {
              sessionId: id,
              configId: "reasoning_effort",
              value: effort,
            });
          current.setContextWindow(contextWindowOf(modelState, model));
        });
      yield* applyModel(options.model?.model, options.model?.variant);

      identity = { type: "identity", agentSessionId: id, model, tools: [], commands };
      Queue.offerUnsafe(events, identity);

      const servers = Effect.tryPromise({
        try: async () => {
          const answer = record(
            await connection.request("_x.ai/mcp/list", { sessionId: id, cache: true }),
          );
          const body = record(answer["result"] ?? answer);
          return (Array.isArray(body["servers"]) ? body["servers"] : []).map(record);
        },
        catch: (error) => failure("Grok Build couldn't list its connectors", error),
      });
      const toggle = (name: string, enabled: boolean) =>
        Effect.tryPromise({
          try: () =>
            connection.request("_x.ai/mcp/toggle", { sessionId: id, serverName: name, enabled }),
          catch: (error) => failure(`Grok Build didn't switch ${name}`, error),
        });
      // The thread's lists leave servers out by switching them off for this session alone.
      if (narrowsMcp(options))
        for (const entry of yield* servers.pipe(Effect.orElseSucceed(() => []))) {
          const name = text(entry["name"]);
          if (name === undefined || name === APP_TOOLS_SERVER_NAME) continue;
          if (record(entry["session"])["enabled"] === false) continue;
          if (listsLeaveOut(options, { name })) yield* toggle(name, false).pipe(Effect.ignore);
        }
      const connectors: AgentConnectors = {
        ...reportedLists(options),
        status: servers.pipe(
          Effect.map((list) =>
            list.flatMap((entry) => {
              const status = connectorOf(entry);
              return status === undefined ? [] : [status];
            }),
          ),
        ),
        reconnect: (name) =>
          toggle(name, false).pipe(Effect.andThen(toggle(name, true)), Effect.asVoid),
        setEnabled: (name, enabled) =>
          name === APP_TOOLS_SERVER_NAME
            ? Effect.fail(unavailable(BUILT_IN_TOGGLE_REASON))
            : toggle(name, enabled).pipe(Effect.as("applied" as const)),
        authenticate: (name) =>
          Effect.tryPromise({
            try: () =>
              connection.request("_x.ai/mcp/auth_trigger", { sessionId: id, serverName: name }),
            catch: (error) => failure(`Grok Build couldn't start signing in to ${name}`, error),
          }).pipe(Effect.as("started" as const)),
      };

      let turn: Promise<void> | undefined;
      const prompt = (input: UserInput) => {
        emit(current.started());
        const running = promptOf(input)
          .then((content) =>
            connection.request("session/prompt", { sessionId: id, prompt: content }),
          )
          .then(
            (result) => emit(current.ended(text(record(result)["stopReason"]))),
            (error: unknown) => {
              const message = messageOf(error);
              emit(current.ended(undefined, signInProblem(message) ? SIGN_IN_MESSAGE : message));
            },
          );
        turn = running;
        void running.finally(() => {
          if (turn === running) turn = undefined;
        });
        return running;
      };

      void connection.ended.then((reason) => {
        for (const each of pending.values()) each.answer({ outcome: { outcome: "cancelled" } });
        pending.clear();
        Queue.offerUnsafe(events, { type: "ended", reason });
      });

      const cancel = () => {
        for (const [requestId, each] of pending) {
          each.answer({ outcome: { outcome: "cancelled" } });
          emit(current.resolved(requestId));
        }
        pending.clear();
        connection.notify("session/cancel", { sessionId: id });
      };

      const quietly = (what: string, run: () => Promise<unknown>) =>
        Effect.promise(() =>
          run().then(
            () => undefined,
            (error: unknown) => {
              Queue.offerUnsafe(events, {
                type: "notice",
                level: "error",
                message: `${what}: ${messageOf(error)}`,
              });
            },
          ),
        );

      const agentSession: AgentSession = {
        events: Stream.fromQueue(events),
        send: (input) =>
          Effect.sync(() => {
            void prompt(input);
          }),
        steer: (input, steerOptions) =>
          steerOptions?.interrupt === true || turn === undefined
            ? quietly("Grok Build didn't stop for the message", async () => {
                if (turn !== undefined) {
                  cancel();
                  await turn;
                }
                void prompt(input);
              })
            : quietly("Grok Build didn't take the message", async () =>
                connection.request("_x.ai/interject", {
                  sessionId: id,
                  text: input.text,
                  content: [...(await promptOf(input))],
                }),
              ),
        interrupt: Effect.sync(cancel),
        respond: (requestId, answer: RequestAnswer) => {
          const waiting = pending.get(requestId);
          if (waiting === undefined)
            return Effect.fail(
              new AnswerUndelivered({ message: "Grok Build isn't asking that now." }),
            );
          if (answer.kind !== "approval")
            return Effect.fail(
              new AnswerUndelivered({ message: "Grok Build only asks for approvals." }),
            );
          const option = optionFor(
            waiting.options,
            answer.decision === "deny" ? "deny" : "allow",
            answer.decision === "deny" ? undefined : answer.scope,
          );
          if (option === undefined)
            return Effect.fail(
              new AnswerUndelivered({ message: "Grok Build offered no option for that answer." }),
            );
          pending.delete(requestId);
          waiting.answer({ outcome: { outcome: "selected", optionId: option.optionId } });
          emit(current.resolved(requestId));
          return Effect.void;
        },
        setMode: (next) =>
          Effect.tryPromise({
            try: async () => {
              if ((next === "plan") !== (mode === "plan")) await setSessionMode(next);
              setPermission(next);
              mode = next;
            },
            catch: (error) =>
              new ModeRefused({
                mode: next,
                message: `Grok Build didn't change mode: ${messageOf(error)}`,
              }),
          }).pipe(Effect.tap(() => Queue.offer(events, { type: "mode", mode: next }))),
        setModel: (next) =>
          applyModel(next.model, next.variant).pipe(
            Effect.catch((error) =>
              Queue.offer(events, { type: "notice", level: "error", message: error.message }),
            ),
            Effect.asVoid,
          ),
        processId: Effect.succeed(connection.pid),
        connectors,
      };
      return agentSession;
    });

  const host: AgentHost = {
    kind: "grok",
    capabilities: GROK_CAPABILITIES,
    open,
    listModels: (options) => (options?.profileId !== undefined ? Effect.succeed([]) : listModels),
    readSubscriptionLimits: Effect.gen(function* () {
      const connection = yield* launchWith(config, homedir(), ignoring);
      return yield* Effect.tryPromise({
        try: async () => {
          try {
            await connection.request("initialize", initializeParams);
            return billingLimits(record(await connection.request("_x.ai/billing", {})));
          } finally {
            await connection.stop();
          }
        },
        catch: (error) => {
          const message = messageOf(error);
          return signInProblem(message)
            ? new AgentUnavailable({
                agent: "grok",
                reason: "not-logged-in",
                message: SIGN_IN_MESSAGE,
              })
            : failure("Couldn't read Grok Build's plan usage", error);
        },
      });
    }),
    readSession: ({ cwd, agentSessionId, limit }) =>
      readPast(cwd, agentSessionId).pipe(
        Effect.map((messages) => ({
          agentSessionId,
          cwd,
          messages: limit === undefined ? messages : messages.slice(0, limit),
        })),
      ),
    previewSession: ({ cwd, agentSessionId }) =>
      readPast(cwd, agentSessionId).pipe(
        Effect.map((messages): SessionPreview => {
          const first = messages.find((message) => message.role === "user")?.text;
          const last = messages.findLast((message) => message.role === "assistant")?.text;
          return {
            ...(first === undefined ? {} : { firstPrompt: first }),
            ...(last === undefined ? {} : { lastReply: last }),
          };
        }),
        Effect.catchTag("NotFound", () => Effect.succeed({})),
      ),
    listSessions: ({ cwd, limit }) =>
      Effect.gen(function* () {
        const connection = yield* launchWith(config, cwd, ignoring);
        const sessions = yield* Effect.tryPromise({
          try: async () => {
            try {
              await connection.request("initialize", initializeParams);
              return record(await connection.request("session/list", { cwd }));
            } finally {
              await connection.stop();
            }
          },
          catch: (error) => failure("Couldn't list Grok Build's sessions", error),
        });
        const list = (Array.isArray(sessions["sessions"]) ? sessions["sessions"] : []).map(record);
        return list
          .flatMap((each) => {
            const agentSessionId = text(each["sessionId"]);
            if (agentSessionId === undefined) return [];
            const updated = Date.parse(text(each["updatedAt"]) ?? "");
            const where = text(each["cwd"]);
            return [
              {
                agentSessionId,
                title: text(each["title"]) ?? "Grok Build session",
                updatedAt: Number.isFinite(updated) ? updated : 0,
                ...(where === undefined ? {} : { cwd: where }),
              },
            ];
          })
          .slice(0, limit ?? 50);
      }),
  };
  return Effect.succeed(host);
};
