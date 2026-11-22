import {
  NotFound,
  type AgentUnavailable,
  type AgentModel,
  type SessionPreview,
  type SubscriptionLimitReport,
} from "@gram/contracts";
import * as Effect from "effect/Effect";

import type { AgentHost } from "../host.ts";
import { acpFailure, INITIALIZE_PARAMS, type AcpAgentSpec, type AcpHostConfig } from "./agent.ts";
import { AcpError, type AcpConnection, type AcpHandlers } from "./connection.ts";
import { transcriptOf } from "./content.ts";
import { type Json, record, records, text } from "./json.ts";
import { launchAcp, openAcpSession } from "./session.ts";

const ignoring: AcpHandlers = {
  notification: () => {},
  request: () => Promise.reject(new AcpError(-32601, "Not supported")),
};

const MODELS_TTL_MS = 5 * 60_000;

/** Runs `run` on a short-lived agent in `cwd`, after `initialize`, and stops it after. */
export const withAcpAgent = <T>(
  config: AcpHostConfig,
  spec: AcpAgentSpec,
  cwd: string,
  what: string,
  run: (connection: AcpConnection, initialized: Json) => Promise<T>,
): Effect.Effect<T, AgentUnavailable> =>
  Effect.gen(function* () {
    const connection = yield* launchAcp(config, spec, cwd, ignoring);
    return yield* Effect.tryPromise({
      try: async () => {
        try {
          return await run(
            connection,
            record(await connection.request("initialize", INITIALIZE_PARAMS)),
          );
        } finally {
          await connection.stop();
        }
      },
      catch: (error) => acpFailure(spec, what, error),
    });
  });

/** What an ACP agent's host does its own way beside its sessions. */
export interface AcpHostParts {
  /** The models, read from an agent started in the home folder. */
  readonly listModels: Effect.Effect<ReadonlyArray<AgentModel>, AgentUnavailable>;
  readonly readSubscriptionLimits?: Effect.Effect<
    ReadonlyArray<SubscriptionLimitReport>,
    AgentUnavailable
  >;
}

/** An `AgentHost` on `spec`'s ACP agent, one agent process per session. */
export const makeAcpHost = (
  config: AcpHostConfig,
  spec: AcpAgentSpec,
  parts: AcpHostParts,
): AgentHost => {
  const name = spec.name;
  let models: { at: number; list: ReadonlyArray<AgentModel> } | undefined;
  const listModels = Effect.gen(function* () {
    if (models !== undefined && Date.now() - models.at < MODELS_TTL_MS) return models.list;
    const list = yield* parts.listModels;
    models = { at: Date.now(), list };
    return list;
  });

  const readPast = (cwd: string, agentSessionId: string) =>
    Effect.gen(function* () {
      const replayed: Array<Json> = [];
      const connection = yield* launchAcp(config, spec, cwd, {
        notification: (method, params) => {
          if (method === "session/update" && text(params["sessionId"]) === agentSessionId)
            replayed.push(params);
        },
        request: () => Promise.reject(new AcpError(-32601, "Not supported")),
      });
      const loaded = yield* Effect.tryPromise({
        try: async () => {
          try {
            await connection.request("initialize", INITIALIZE_PARAMS);
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
        catch: (error) => acpFailure(spec, `Couldn't read the ${name} session`, error),
      });
      const messages = transcriptOf(replayed, spec.transcriptToolName);
      if (!loaded || (spec.loadAnswersAnyId === true && messages.length === 0))
        return yield* new NotFound({
          entity: "session",
          id: agentSessionId,
          message: `No ${name} session ${agentSessionId} in ${cwd}.`,
        });
      return messages;
    });

  return {
    kind: spec.kind,
    capabilities: spec.capabilities,
    open: (options) => openAcpSession(config, spec, options),
    listModels: (options) => (options?.profileId !== undefined ? Effect.succeed([]) : listModels),
    ...(parts.readSubscriptionLimits === undefined
      ? {}
      : { readSubscriptionLimits: parts.readSubscriptionLimits }),
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
      withAcpAgent(config, spec, cwd, `Couldn't list ${name}'s sessions`, async (connection) =>
        record(await connection.request("session/list", { cwd })),
      ).pipe(
        Effect.map((sessions) =>
          records(sessions["sessions"])
            .flatMap((each) => {
              const agentSessionId = text(each["sessionId"]);
              if (agentSessionId === undefined) return [];
              const updated = Date.parse(text(each["updatedAt"]) ?? "");
              const where = text(each["cwd"]);
              return [
                {
                  agentSessionId,
                  title: text(each["title"]) ?? `${name} session`,
                  updatedAt: Number.isFinite(updated) ? updated : 0,
                  ...(where === undefined ? {} : { cwd: where }),
                },
              ];
            })
            .slice(0, limit ?? 50),
        ),
      ),
  };
};
