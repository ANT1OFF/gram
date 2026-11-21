import {
  AgentUnavailable,
  type AgentCapabilities,
  type MessageId,
  type PermissionMode,
  type ReasoningVariant,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { homedir } from "node:os";

import { APP_TOOLS_SERVER_NAME } from "../app-tools.ts";
import {
  BUILT_IN_TOGGLE_REASON,
  type AgentConnectors,
  type AgentHost,
  type OutwardGate,
} from "../host.ts";
import { listsLeaveOut, narrowsMcp, reportedLists } from "../mcp-lists.ts";
import {
  acpFailure,
  baseMessageOf,
  INITIALIZE_PARAMS,
  signInProblem,
  type AcpAgentSpec,
} from "../acp/agent.ts";
import { AcpError, type AcpConnection, type StartAcpAgent } from "../acp/connection.ts";
import { makeAcpHost, withAcpAgent } from "../acp/host.ts";
import { record, records, text } from "../acp/json.ts";
import { launchAcp } from "../acp/session.ts";
import {
  autoAnswer,
  billingLimits,
  connectorOf,
  contextWindowOf,
  grokCommands,
  grokModels,
  grokPermission,
  permissionParams,
} from "./extensions.ts";
import { grokToolName, makeGrokMapper, toolFor } from "./mapper.ts";

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

/** What a failed start or session says when the CLI has no usable sign-in. */
export const SIGN_IN_MESSAGE =
  "Not signed in. Run `grok login` in a terminal, then start the thread again.";

export interface GrokHostConfig {
  /** The `grok` executable; fails when it isn't installed. */
  readonly binary: Effect.Effect<string, AgentUnavailable>;
  /** The user's login-shell environment, which the CLI runs in. */
  readonly env: Effect.Effect<Readonly<Record<string, string | undefined>>>;
  /** Starts an agent process; tests stand one in. */
  readonly start: (input: StartAcpAgent) => AcpConnection;
  readonly newMessageId: () => MessageId;
}

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

const failure = (what: string, error: unknown) => acpFailure(GROK, what, error);

const switchPermission = (
  connection: AcpConnection,
  mode: PermissionMode,
  gate: OutwardGate | undefined,
) =>
  connection.notify("_x.ai/yolo_mode_changed", {
    ...permissionParams(grokPermission(mode, gate)),
  });

const GROK: AcpAgentSpec = {
  kind: "grok",
  name: "Grok Build",
  capabilities: GROK_CAPABILITIES,
  args: GROK_AGENT_ARGS,
  signInMessage: SIGN_IN_MESSAGE,
  signIn: withHeadlessSignIn,
  updateMethods: ["session/update", "_x.ai/session_notification"],
  commandsOf: grokCommands,
  mapper: (sessionId, newMessageId) => makeGrokMapper({ sessionId, newMessageId }),
  appToolsServer: () => APP_TOOLS_SERVER_NAME,
  autoAnswer: (mode, gate, call, roots) => autoAnswer(mode, gate, call, roots),
  sessionParams: (options) => {
    const instructions = options.instructions?.trim();
    return instructions === undefined || instructions === ""
      ? {}
      : { _meta: { rules: instructions } };
  },
  transcriptToolName: (update) => toolFor(grokToolName(update), {}).name,
  setUp: ({ connection, sessionId: id, opened, options, mode, gate, mapper, call }) =>
    Effect.gen(function* () {
      const modelState = record(opened["models"]);
      switchPermission(connection, mode, gate);
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
          mapper.setContextWindow(contextWindowOf(modelState, model));
        });
      yield* applyModel(options.model?.model, options.model?.variant);

      const servers = Effect.tryPromise({
        try: async () => {
          const answer = record(
            await connection.request("_x.ai/mcp/list", { sessionId: id, cache: true }),
          );
          return records(record(answer["result"] ?? answer)["servers"]);
        },
        catch: (error) => failure("Grok Build couldn't list its connectors", error),
      });
      const toggle = (name: string, enabled: boolean) =>
        Effect.tryPromise({
          try: () =>
            connection.request("_x.ai/mcp/toggle", { sessionId: id, serverName: name, enabled }),
          catch: (error) => failure(`Grok Build didn't switch ${name}`, error),
        });
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
            ? Effect.fail(new AgentUnavailable({ agent: "grok", message: BUILT_IN_TOGGLE_REASON }))
            : toggle(name, enabled).pipe(Effect.as("applied" as const)),
        authenticate: (name) =>
          Effect.tryPromise({
            try: () =>
              connection.request("_x.ai/mcp/auth_trigger", { sessionId: id, serverName: name }),
            catch: (error) => failure(`Grok Build couldn't start signing in to ${name}`, error),
          }).pipe(Effect.as("started" as const)),
      };

      return {
        model,
        setMode: async (next, from) => {
          if ((next === "plan") !== (from === "plan"))
            await connection.request("session/set_mode", {
              sessionId: id,
              modeId: next === "plan" ? "plan" : "default",
            });
          switchPermission(connection, next, gate);
        },
        setModel: (next) => applyModel(next.model, next.variant),
        connectors,
        interject: (content, plain) =>
          connection.request("_x.ai/interject", { sessionId: id, text: plain, content }),
      };
    }),
};

const readBilling = (config: GrokHostConfig) =>
  Effect.gen(function* () {
    const connection = yield* launchAcp(config, GROK, homedir(), {
      notification: () => {},
      request: () => Promise.reject(new AcpError(-32601, "Not supported")),
    });
    return yield* Effect.tryPromise({
      try: async () => {
        try {
          await connection.request("initialize", INITIALIZE_PARAMS);
          return billingLimits(record(await connection.request("_x.ai/billing", {})));
        } finally {
          await connection.stop();
        }
      },
      catch: (error) =>
        signInProblem(GROK, baseMessageOf(error))
          ? new AgentUnavailable({
              agent: "grok",
              reason: "not-logged-in",
              message: SIGN_IN_MESSAGE,
            })
          : acpFailure(GROK, "Couldn't read Grok Build's plan usage", error),
    });
  });

/**
 * The Grok Build host: one `grok agent stdio` per session, on the user's own sign-in, driven over
 * the Agent Client Protocol. Grok keeps the session; Gram resumes it by id.
 */
export const makeGrokHost = (config: GrokHostConfig): Effect.Effect<AgentHost> =>
  Effect.succeed(
    makeAcpHost(config, GROK, {
      listModels: withAcpAgent(
        config,
        GROK,
        homedir(),
        "Couldn't list Grok Build's models",
        async (_connection, initialized) =>
          grokModels(record(record(initialized["_meta"])["modelState"])),
      ),
      readSubscriptionLimits: readBilling(config),
    }),
  );
