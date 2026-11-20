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
  type UserInput,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

import { APP_TOOLS_SERVER_NAME } from "../app-tools.ts";
import type { AgentHost, AgentSession, OpenSessionOptions, OutwardGate } from "../host.ts";
import { gateAsks, gateLevel, outwardKind } from "../outward.ts";
import { AcpError, type AcpConnection, type AcpHandlers, type StartAcpAgent } from "./acp.ts";
import { makeGrokMapper, optionFor, type PermissionOption } from "./mapper.ts";

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
 * The answer Gram gives a permission request itself, without a card: `dontAsk` refuses, edits go
 * through in `acceptEdits`, and a mode that would have run the call unasked lets it through when
 * the outward gate doesn't ask about it. `undefined` shows the card.
 */
export const autoAnswer = (
  mode: PermissionMode,
  gate: OutwardGate | undefined,
  call: Json,
): "allow" | "deny" | undefined => {
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

const promptOf = (input: UserInput): ReadonlyArray<Json> => {
  const names = (input.attachments ?? []).map((attachment) => attachment.name);
  return [
    {
      type: "text",
      text: names.length === 0 ? input.text : `${input.text}\n\n(Attached: ${names.join(", ")})`,
    },
  ];
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
const launchWith = (config: GrokHostConfig, cwd: string, handlers: AcpHandlers) =>
  Effect.gen(function* () {
    const binary = yield* config.binary;
    const env = yield* config.env;
    return yield* Effect.try({
      try: () => config.start({ binary, args: GROK_AGENT_ARGS, env, cwd, handlers }),
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

      const onUpdate = (params: Json) => {
        if (mapper === undefined) return;
        if (text(params["sessionId"]) !== sessionId) return;
        emit(mapper.update(record(params["update"])));
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
      const mcpServers =
        options.mcp === undefined
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
            ];
      const base = { cwd: options.cwd, mcpServers };
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

      Queue.offerUnsafe(events, {
        type: "identity",
        agentSessionId: id,
        model,
        tools: [],
        commands: [],
      });

      let turn: Promise<void> | undefined;
      const prompt = (input: UserInput) => {
        emit(current.started());
        const running = connection
          .request("session/prompt", { sessionId: id, prompt: promptOf(input) })
          .then(
            (result) => emit(current.ended(text(record(result)["stopReason"]))),
            (error: unknown) => {
              const message = messageOf(error);
              emit(current.ended(undefined, signInProblem(message) ? SIGN_IN_MESSAGE : message));
            },
          );
        turn = running;
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
            : quietly("Grok Build didn't take the message", () =>
                connection.request("_x.ai/interject", {
                  sessionId: id,
                  text: promptOf(input)[0]!["text"] as string,
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
      };
      return agentSession;
    });

  const host: AgentHost = {
    kind: "grok",
    capabilities: GROK_CAPABILITIES,
    open,
    listModels: (options) => (options?.profileId !== undefined ? Effect.succeed([]) : listModels),
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
