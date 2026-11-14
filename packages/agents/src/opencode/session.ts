import {
  AgentUnavailable,
  AnswerUndelivered,
  ModeRefused,
  GATEWAY_PROVIDER_ID,
  gatewayModelForAgent,
  gatewayModelUsable,
  type AgentCapabilities,
  type AgentEvent,
  type AgentModel,
  type MessageId,
  type ModelRef,
  type PermissionMode,
  type ProfileId,
  type ReasoningVariant,
  type RequestAnswer,
  type UserInput,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { homedir } from "node:os";

import type { GatewayCredentials } from "../gateway.ts";
import type { AgentHost, AgentSession, OpenSessionOptions, OutwardGate } from "../host.ts";
import { gateAsks, gateLevel, outwardKind } from "../outward.ts";
import type { OpenCodeClient } from "./client.ts";
import { makeOpenCodeMapper } from "./mapper.ts";
import { permissionOf } from "./protocol.ts";
import type {
  OpenCodeModel,
  OpenCodePermission,
  OpenCodeModelRef,
  OpenCodePermissionReply,
  OpenCodePermissionRule,
} from "./protocol.ts";
import type { OpenCodeServer, StartOpenCodeServer } from "./server.ts";

export const OPENCODE_CAPABILITIES: AgentCapabilities = {
  fork: false,
  rewind: "none",
  steer: true,
  steerInterrupt: true,
  planMode: true,
  // OpenCode saves an `always` for the project; it has no session-long grant.
  approvalScopes: ["once", "always"],
  userQuestions: false,
  costReporting: true,
  perTurnModel: true,
  reasoningEffort: false,
  listSessions: true,
  subagentStreams: false,
  stopTasks: false,
};

/** The env var a gateway profile's key reaches OpenCode by; the config names it, never the key. */
export const GATEWAY_KEY_ENV = "GRAM_OPENCODE_GATEWAY_KEY";

const unavailable = (message: string) => new AgentUnavailable({ agent: "opencode", message });

/** A call to the server, failing as the agent being unavailable, with `what` and the reason. */
const attempt = <A>(what: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      unavailable(`${what}: ${error instanceof Error ? error.message : String(error)}`),
  });

const rule = (
  action: string,
  effect: OpenCodePermissionRule["effect"],
): OpenCodePermissionRule => ({ action, resource: "*", effect });

const READS = ["read", "glob", "grep", "skill", "websearch"];
const ACTS = ["edit", "write", "shell", "webfetch", "subagent", "external_directory"];

/**
 * The permission rules for a Gram mode, which the session holds and OpenCode's own `deny`
 * policies still outrank: the last matching rule wins, and no match asks. OpenCode runs no
 * sandbox, so only `bypassPermissions` runs commands unasked: `auto` asks as `default` does, and
 * `dontAsk` refuses whatever isn't a read, as Claude Code's does with nothing allowed beforehand.
 * `plan` reads and proposes; it can't edit, write or run anything.
 */
export const rulesFor = (mode: PermissionMode): ReadonlyArray<OpenCodePermissionRule> => {
  const reads = READS.map((action) => rule(action, "allow"));
  switch (mode) {
    case "bypassPermissions":
      return [...reads, ...ACTS.map((action) => rule(action, "allow"))];
    case "dontAsk":
      return [...reads, ...ACTS.map((action) => rule(action, "deny"))];
    case "plan":
      return [
        ...reads,
        ...["edit", "write", "shell", "subagent"].map((action) => rule(action, "deny")),
        rule("webfetch", "ask"),
        rule("external_directory", "ask"),
      ];
    case "acceptEdits":
      return [
        ...reads,
        rule("edit", "allow"),
        rule("write", "allow"),
        ...["shell", "webfetch", "subagent", "external_directory"].map((action) =>
          rule(action, "ask"),
        ),
      ];
    case "auto":
    case "default":
      return [...reads, ...ACTS.map((action) => rule(action, "ask"))];
  }
};

/**
 * The rules a session holds: its mode's, with the shell asking where the mode would run it unasked
 * while an outward gate is on, so that the adapter sees each command and lets through the ones the
 * gate doesn't ask about (`gateAllows`).
 */
export const sessionRules = (
  mode: PermissionMode,
  gate: OutwardGate | undefined,
): ReadonlyArray<OpenCodePermissionRule> => {
  const rules = rulesFor(mode);
  if (gate === undefined) return rules;
  return rules.map((each) =>
    each.action === "shell" && each.effect === "allow" ? rule("shell", "ask") : each,
  );
};

/**
 * Whether the adapter answers a shell request itself: the mode would have run the command unasked,
 * and the gate doesn't ask about it.
 */
export const gateAllows = (
  mode: PermissionMode,
  gate: OutwardGate | undefined,
  permission: Pick<OpenCodePermission, "action" | "resources">,
): boolean => {
  if (gate === undefined || permission.action !== "shell") return false;
  if (!rulesFor(mode).some((each) => each.action === "shell" && each.effect === "allow"))
    return false;
  const commands = permission.resources;
  return commands.length > 0 && commands.every((command) => !gateAsks(gate, outwardKind(command)));
};

/** OpenCode's own agents: `plan` reads and proposes, `build` does the work. */
export const agentFor = (mode: PermissionMode): string => (mode === "plan" ? "plan" : "build");

/** A Gram model id as OpenCode's model reference: `provider/model`, or the gateway's model. */
export const modelRefFor = (model: ModelRef | undefined): OpenCodeModelRef | undefined => {
  if (model === undefined || model.model === "") return undefined;
  if (model.profileId !== undefined) return { providerID: GATEWAY_PROVIDER_ID, id: model.model };
  const slash = model.model.indexOf("/");
  if (slash <= 0) return undefined;
  return { providerID: model.model.slice(0, slash), id: model.model.slice(slash + 1) };
};

/** Anthropic's models stay with Claude Code: OpenCode is offered every other maker's. */
export const isAnthropic = (model: Pick<OpenCodeModel, "id" | "providerID">): boolean =>
  model.providerID === "anthropic" ||
  /(^|[/.])(anthropic|claude)/i.test(model.id) ||
  model.id.toLowerCase().startsWith("claude");

const EFFORTS: ReadonlySet<string> = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

/** What OpenCode lists that an agent can work with, as the pickers show it. */
export const agentModels = (models: ReadonlyArray<OpenCodeModel>): ReadonlyArray<AgentModel> =>
  models
    .filter(
      (model) =>
        model.capabilities?.tools !== false &&
        model.enabled !== false &&
        model.status !== "deprecated" &&
        !isAnthropic(model),
    )
    .map((model) => {
      const efforts = (model.variants ?? [])
        .map((variant) => variant.id)
        .filter((id): id is ReasoningVariant => EFFORTS.has(id));
      return {
        id: `${model.providerID}/${model.id}`,
        displayName: model.name,
        supportsEffort: efforts.length > 0,
        ...(efforts.length > 0 ? { efforts } : {}),
      };
    });

/**
 * OpenCode's config for a gateway profile: one OpenAI-compatible provider named like Codex's
 * (`gram`), on the profile's URL, with the key read from `GATEWAY_KEY_ENV`, and only the models
 * OpenCode is offered there.
 */
export const gatewayConfig = (credentials: GatewayCredentials): string => {
  const { profile } = credentials;
  const models = profile.models.filter(
    (model) => gatewayModelUsable(model) && gatewayModelForAgent(profile, model, "opencode"),
  );
  return JSON.stringify({
    ...(models[0] === undefined ? {} : { model: `${GATEWAY_PROVIDER_ID}/${models[0].id}` }),
    providers: {
      [GATEWAY_PROVIDER_ID]: {
        name: profile.name,
        env: [GATEWAY_KEY_ENV],
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: profile.baseURL },
        models: Object.fromEntries(
          models.map((model) => [
            model.id,
            {
              name: model.name,
              ...(model.contextWindow === undefined
                ? {}
                : { limit: { context: model.contextWindow } }),
            },
          ]),
        ),
      },
    },
  });
};

export interface OpenCodeHostConfig {
  /** The `opencode` executable; fails when it isn't installed. */
  readonly binary: Effect.Effect<string, AgentUnavailable>;
  /** The user's login-shell environment, which the server runs in. */
  readonly env: Effect.Effect<Readonly<Record<string, string | undefined>>>;
  /** A gateway profile and its key, for a thread on one. */
  readonly credentials: (
    profileId: ProfileId,
  ) => Effect.Effect<GatewayCredentials, AgentUnavailable>;
  /** Starts a server; tests stand one in. */
  readonly start: (input: StartOpenCodeServer) => Promise<OpenCodeServer>;
  readonly newMessageId: () => MessageId;
}

const textOf = (input: UserInput): string => {
  const names = (input.attachments ?? []).map((attachment) => attachment.name);
  // OpenCode takes files by URI; until Gram hands them over, the agent is told what was attached.
  return names.length === 0 ? input.text : `${input.text}\n\n(Attached: ${names.join(", ")})`;
};

const replyFor = (answer: RequestAnswer): OpenCodePermissionReply | undefined => {
  if (answer.kind !== "approval") return undefined;
  if (answer.decision === "deny") return "reject";
  // OpenCode's `always` is saved for the project; only an answer that says so gets it.
  return answer.scope === "always" ? "always" : "once";
};

/** A server's start: its binary, env and key, then the process, read only once a key. */
const startFor = (config: OpenCodeHostConfig, profileId: ProfileId | undefined) =>
  Effect.gen(function* () {
    const binary = yield* config.binary;
    const base = yield* config.env;
    let env: Record<string, string | undefined> = { ...base };
    if (profileId !== undefined) {
      const credentials = yield* config.credentials(profileId);
      env = {
        ...env,
        OPENCODE_CONFIG_CONTENT: gatewayConfig(credentials),
        [GATEWAY_KEY_ENV]: Redacted.value(credentials.key),
      };
    }
    return yield* Effect.tryPromise({
      try: () => config.start({ binary, env }),
      catch: (error) =>
        unavailable(
          `OpenCode didn't start: ${error instanceof Error ? error.message : String(error)}`,
        ),
    });
  });

/**
 * The OpenCode host: one `opencode serve` per gateway profile (and one on the user's own
 * configuration), started when first needed and stopped with the host, each session an OpenCode
 * session on it with its own event stream.
 */
export const makeOpenCodeHost = (
  config: OpenCodeHostConfig,
): Effect.Effect<AgentHost, never, Scope.Scope> =>
  Effect.gen(function* () {
    const servers = new Map<string, Promise<OpenCodeServer>>();
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        const all = [...servers.values()];
        servers.clear();
        await Promise.all(
          all.map((server) => server.then((running) => running.stop()).catch(() => undefined)),
        );
      }),
    );

    /**
     * The server for a profile, started once: the start is kept before it runs, so two opens at
     * once share it, and a profile invalidated while it starts stops what it started.
     */
    const serverFor = (profileId: ProfileId | undefined) =>
      Effect.gen(function* () {
        const key = profileId ?? "";
        const existing = servers.get(key);
        if (existing !== undefined) {
          const running = yield* Effect.promise(() => existing.catch(() => undefined));
          if (running?.alive() === true) return running;
          if (servers.get(key) === existing) servers.delete(key);
        }
        let starting = servers.get(key);
        if (starting === undefined) {
          starting = Effect.runPromise(startFor(config, profileId));
          servers.set(key, starting);
        }
        const current = starting;
        return yield* Effect.tryPromise({
          try: () => current,
          catch: (error) => {
            if (servers.get(key) === current) servers.delete(key);
            return error instanceof AgentUnavailable
              ? error
              : unavailable(
                  `OpenCode didn't start: ${error instanceof Error ? error.message : String(error)}`,
                );
          },
        });
      });

    const open = (options: OpenSessionOptions) =>
      Effect.gen(function* () {
        if (options.dreamFilesOnly === true || options.confineWrites === true)
          return yield* Effect.fail(
            unavailable("OpenCode can't keep a session's writes, shell and network bounded."),
          );
        const server = yield* serverFor(options.model?.profileId);
        const client: OpenCodeClient = server.client;
        let mode = options.permissionMode ?? "default";
        const gate = gateLevel(options.outwardGate);
        const model = modelRefFor(options.model);
        const resumed =
          options.resumeId === undefined
            ? undefined
            : yield* attempt("Couldn't read the OpenCode session", () =>
                client.getSession(options.resumeId!),
              );
        const session =
          resumed ??
          (yield* attempt("Couldn't start an OpenCode session", () =>
            client.createSession({
              directory: options.cwd,
              agent: agentFor(mode),
              permissions: sessionRules(mode, gate),
              ...(model === undefined ? {} : { model }),
            }),
          ));
        if (resumed !== undefined) {
          yield* attempt("Couldn't set the session's permissions", () =>
            client.setPermissions(session.id, sessionRules(mode, gate)),
          );
          if (model !== undefined)
            yield* attempt("Couldn't set the session's model", () =>
              client.setModel(session.id, model),
            );
        }

        const events = yield* Queue.unbounded<AgentEvent>();
        const mapper = makeOpenCodeMapper({
          sessionId: session.id,
          newMessageId: config.newMessageId,
        });
        Queue.offerUnsafe(events, {
          type: "identity",
          agentSessionId: session.id,
          model: options.model?.model ?? "",
          tools: [],
          commands: [],
        });
        const abort = new AbortController();
        const ready = Promise.withResolvers<void>();
        const subscribed = client
          .subscribe((event) => {
            if (event.type === "server.connected") ready.resolve();
            if (event.type === "permission.asked") {
              const permission = permissionOf(event.data);
              // A command the mode runs unasked and the gate doesn't ask about: let it through.
              if (permission?.sessionID === session.id && gateAllows(mode, gate, permission)) {
                void client.reply(session.id, permission.id, "once").catch((error: unknown) => {
                  Queue.offerUnsafe(events, {
                    type: "notice",
                    level: "error",
                    message: `OpenCode didn't take Gram's answer: ${error instanceof Error ? error.message : String(error)}`,
                  });
                });
                return;
              }
            }
            for (const out of mapper.map(event)) Queue.offerUnsafe(events, out);
          }, abort.signal)
          .then(
            () => {
              if (abort.signal.aborted) return;
              for (const out of mapper.interrupted()) Queue.offerUnsafe(events, out);
              Queue.offerUnsafe(events, {
                type: "ended",
                reason: "OpenCode closed its event stream",
              });
            },
            (error: unknown) => {
              ready.resolve();
              for (const out of mapper.interrupted()) Queue.offerUnsafe(events, out);
              Queue.offerUnsafe(events, {
                type: "ended",
                reason: `OpenCode's events stopped: ${error instanceof Error ? error.message : String(error)}`,
              });
            },
          );
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            abort.abort();
            await subscribed;
          }),
        );
        // Nothing is sent before the stream is open, so no event of the turn is missed.
        yield* Effect.promise(() =>
          Promise.race([ready.promise, new Promise((resolve) => setTimeout(resolve, 5_000))]),
        );
        // A request the session already had waiting (a resumed one) is shown again.
        const waiting = yield* attempt("Couldn't read the session's requests", () =>
          client.permissions(session.id),
        ).pipe(Effect.orElseSucceed(() => []));
        for (const permission of waiting) {
          if (gateAllows(mode, gate, permission)) {
            yield* Effect.promise(() =>
              client.reply(session.id, permission.id, "once").catch(() => undefined),
            );
            continue;
          }
          for (const out of mapper.map({ type: "permission.asked", data: { ...permission } }))
            Queue.offerUnsafe(events, out);
        }

        const quietly = (what: string, run: () => Promise<unknown>) =>
          Effect.promise(() =>
            run().then(
              () => undefined,
              (error: unknown) => {
                Queue.offerUnsafe(events, {
                  type: "notice",
                  level: "error",
                  message: `${what}: ${error instanceof Error ? error.message : String(error)}`,
                });
              },
            ),
          );

        const agentSession: AgentSession = {
          events: Stream.fromQueue(events),
          send: (input) =>
            quietly("OpenCode didn't take the message", () =>
              client.prompt(session.id, textOf(input)),
            ),
          steer: (input, steerOptions) =>
            steerOptions?.interrupt === true
              ? quietly("OpenCode didn't stop for the message", async () => {
                  await client.interrupt(session.id);
                  await client.prompt(session.id, textOf(input));
                })
              : quietly("OpenCode didn't take the message", () =>
                  client.prompt(session.id, textOf(input), "steer"),
                ),
          interrupt: quietly("OpenCode didn't stop", () => client.interrupt(session.id)),
          respond: (requestId, answer) => {
            const decision = replyFor(answer);
            if (decision === undefined)
              return Effect.fail(
                new AnswerUndelivered({ message: "OpenCode only asks for approvals." }),
              );
            const message =
              answer.kind === "approval" && answer.decision === "deny" ? answer.message : undefined;
            return Effect.tryPromise({
              try: () => client.reply(session.id, requestId, decision, message),
              catch: (error) =>
                new AnswerUndelivered({
                  message: error instanceof Error ? error.message : String(error),
                }),
            });
          },
          // The mode is reported only once OpenCode holds its rules, never on a failed change.
          setMode: (next) =>
            Effect.tryPromise({
              try: async () => {
                await client.setPermissions(session.id, sessionRules(next, gate));
                await client.setAgent(session.id, agentFor(next));
              },
              catch: (error) =>
                new ModeRefused({
                  mode: next,
                  message: `OpenCode didn't change mode: ${error instanceof Error ? error.message : String(error)}`,
                }),
            }).pipe(
              Effect.tap(() => {
                mode = next;
                return Queue.offer(events, { type: "mode", mode: next });
              }),
            ),
          setModel: (next) => {
            const ref = modelRefFor(next);
            return ref === undefined
              ? Effect.void
              : quietly("OpenCode didn't change model", () => client.setModel(session.id, ref));
          },
          processId: Effect.succeed(server.pid),
        };
        return agentSession;
      });

    const host: AgentHost = {
      kind: "opencode",
      capabilities: OPENCODE_CAPABILITIES,
      open,
      listModels: (options) =>
        options?.profileId !== undefined
          ? Effect.succeed([])
          : Effect.gen(function* () {
              const server = yield* serverFor(undefined);
              const models = yield* attempt("Couldn't list OpenCode's models", () =>
                server.client.models(homedir()),
              );
              return agentModels(models);
            }),
      listSessions: ({ cwd, limit }) =>
        Effect.gen(function* () {
          const server = yield* serverFor(undefined);
          const sessions = yield* attempt("Couldn't list OpenCode's sessions", () =>
            server.client.listSessions(cwd, limit ?? 50),
          );
          return sessions.map((each) => ({
            agentSessionId: each.id,
            title: each.title ?? "OpenCode session",
            updatedAt: each.updated ?? each.created ?? 0,
            ...(each.directory === undefined ? {} : { cwd: each.directory }),
          }));
        }),
      invalidateProfile: (profileId) =>
        Effect.promise(async () => {
          const server = servers.get(profileId);
          servers.delete(profileId);
          await server?.then((running) => running.stop()).catch(() => undefined);
        }),
    };
    return host;
  });
