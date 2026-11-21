import type { AgentCapabilities, AgentModel, ReasoningVariant } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";

import type { AgentHost } from "../host.ts";
import { messageOf, SIGN_IN_PATTERN, type AcpAgentSpec, type AcpHostConfig } from "../acp/agent.ts";
import { commandsOf } from "../acp/content.ts";
import type { AcpConnection } from "../acp/connection.ts";
import { makeAcpHost, withAcpAgent } from "../acp/host.ts";
import { record, text } from "../acp/json.ts";
import { makeAcpMapper } from "../acp/mapper.ts";
import {
  antigravityMode,
  antigravityModels,
  antigravityToolName,
  autoAnswer,
  configOption,
  outputText,
  promptUsage,
  toolFor,
} from "./extensions.ts";
import { refuseCustomizations } from "./workspace.ts";

export const ANTIGRAVITY_CAPABILITIES: AgentCapabilities = {
  fork: false,
  rewind: "none",
  steer: false,
  steerInterrupt: true,
  planMode: true,
  approvalScopes: ["once"],
  userQuestions: false,
  costReporting: false,
  perTurnModel: true,
  reasoningEffort: true,
  listSessions: true,
  subagentStreams: false,
  stopTasks: false,
};

/** The arguments every Antigravity agent starts with: its ACP server over stdio. */
export const ANTIGRAVITY_AGENT_ARGS = ["acp"] as const;

/** What a failed start or session says when the CLI has no usable sign-in. */
export const SIGN_IN_MESSAGE =
  "Not signed in. Run `agy` in a terminal and sign in, then start the thread again.";

/** Antigravity's errors when it has no sign-in, as Grok's say it and "not logged into Antigravity". */
const SIGNED_OUT = new RegExp(`${SIGN_IN_PATTERN.source}|logged in`, "i");

/** Methods that need a sign-in, and are tried again once after a headless one. */
const SIGNED_METHODS: ReadonlySet<string> = new Set([
  "session/new",
  "session/load",
  "session/resume",
  "session/list",
]);

/** What the thread says when it falls back on the Gemini API key. */
export const API_KEY_NOTICE =
  "Signed out of Google: this thread runs on your GEMINI_API_KEY and is billed to it.";

/**
 * `connection` signing in headless on the Gemini API key its environment holds (`GEMINI_API_KEY`),
 * as a sandbox's does, but only once a request that needs a sign-in has failed for want of one:
 * on a desktop the CLI's own keyring sign-in comes first, and a key the person keeps for other tools
 * never takes its place. When the key does, `notice` says so (`API_KEY_NOTICE`).
 */
export const withHeadlessSignIn = (
  connection: AcpConnection,
  env: Readonly<Record<string, string | undefined>>,
  notice: (message: string) => void = () => {},
): AcpConnection => {
  const key = env["GEMINI_API_KEY"];
  if (key === undefined || key.trim() === "") return connection;
  let signedIn = false;
  return {
    ...connection,
    request: async <T>(method: string, params: Record<string, unknown>) => {
      try {
        return await connection.request<T>(method, params);
      } catch (error) {
        if (signedIn || !SIGNED_METHODS.has(method) || !SIGNED_OUT.test(messageOf(error)))
          throw error;
        await connection.request("authenticate", { methodId: "gemini-api-key" });
        signedIn = true;
        notice(API_KEY_NOTICE);
        return connection.request<T>(method, params);
      }
    },
  };
};

const ANTIGRAVITY: AcpAgentSpec = {
  kind: "antigravity",
  name: "Antigravity",
  capabilities: ANTIGRAVITY_CAPABILITIES,
  args: ANTIGRAVITY_AGENT_ARGS,
  signInMessage: SIGN_IN_MESSAGE,
  signInPattern: SIGNED_OUT,
  signIn: withHeadlessSignIn,
  refuses: refuseCustomizations,
  updateMethods: ["session/update"],
  commandsOf,
  appToolsServer: () => `gram${randomBytes(4).toString("hex")}`,
  mapper: (sessionId, newMessageId, server) =>
    makeAcpMapper({
      agent: "antigravity",
      sessionId,
      newMessageId,
      toolOf: (update) => toolFor(antigravityToolName(update), record(update["rawInput"]), server),
      outputOf: outputText,
      refusal: "Antigravity declined to continue.",
      extension: (update, turn) => {
        if (update["sessionUpdate"] !== "usage_update") return;
        const used = update["used"];
        const size = update["size"];
        if (typeof used === "number") turn.setContextTokens(used);
        if (typeof size === "number") turn.setContextWindow(size);
      },
      promptUsage,
    }),
  autoAnswer,
  sessionParams: (options) => {
    const instructions = options.instructions?.trim();
    const extra = options.additionalDirectories ?? [];
    return {
      ...(extra.length === 0 ? {} : { additionalDirectories: extra }),
      ...(instructions === undefined || instructions === ""
        ? {}
        : { _meta: { antigravity: { systemPrompt: { append: instructions } } } }),
    };
  },
  transcriptToolName: (update) => toolFor(antigravityToolName(update), {}, "").name,
  loadAnswersAnyId: true,
  setUp: ({ connection, sessionId: id, opened, options, mode, gate, call }) =>
    Effect.gen(function* () {
      const models = antigravityModels(opened);
      yield* call("Antigravity didn't take Gram's mode", "session/set_mode", {
        sessionId: id,
        modeId: antigravityMode(mode, gate),
      });

      let model = text(configOption(opened, "model")["currentValue"]) ?? "";
      const applyModel = (wanted: string | undefined, effort: ReasoningVariant | undefined) =>
        Effect.gen(function* () {
          if (wanted !== undefined && wanted !== "" && wanted !== "default" && wanted !== model) {
            yield* call("Antigravity didn't change model", "session/set_config_option", {
              sessionId: id,
              configId: "model",
              value: wanted,
            });
            model = wanted;
          }
          const efforts = models.find((each) => each.id === model)?.efforts ?? [];
          if (effort !== undefined && efforts.includes(effort))
            yield* call("Antigravity didn't change thinking level", "session/set_config_option", {
              sessionId: id,
              configId: "thought_level",
              value: effort,
            });
        });
      yield* applyModel(options.model?.model, options.model?.variant);
      return {
        model,
        setMode: async (next) => {
          await connection.request("session/set_mode", {
            sessionId: id,
            modeId: antigravityMode(next, gate),
          });
        },
        setModel: (next) => applyModel(next.model, next.variant),
      };
    }),
};

/** The models Antigravity lists, read from a session it opens in the home folder and closes. */
const listedModels = async (connection: AcpConnection): Promise<ReadonlyArray<AgentModel>> => {
  const opened = record(
    await connection.request("session/new", { cwd: homedir(), mcpServers: [] }),
  );
  const id = text(opened["sessionId"]);
  if (id !== undefined)
    await connection.request("session/close", { sessionId: id }).catch(() => {});
  return antigravityModels(opened);
};

/**
 * The Antigravity host: one `agy acp` per session, on the user's own sign-in (or the Gemini API
 * key of a sandbox), driven over the Agent Client Protocol. Antigravity keeps the session; Gram
 * resumes it by id.
 */
export const makeAntigravityHost = (config: AcpHostConfig): Effect.Effect<AgentHost> =>
  Effect.succeed(
    makeAcpHost(config, ANTIGRAVITY, {
      listModels: withAcpAgent(
        config,
        ANTIGRAVITY,
        homedir(),
        "Couldn't list Antigravity's models",
        listedModels,
      ),
    }),
  );
