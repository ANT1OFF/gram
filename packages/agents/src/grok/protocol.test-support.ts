/**
 * UNQUALIFIED, isolated-test-only protocol fixture adapter. Not exported by @gram/agents/grok.
 * It does not establish subscription-only routing and MUST NOT be wired into production.
 * Explicit fixture executable, arguments, environment and synthetic auth path are mandatory.
 */
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  AgentUnavailable,
  AnswerUndelivered,
  InterruptHung,
  MessageId,
  ModeRefused,
  RequestId,
  type AgentCapabilities,
  type AgentEvent,
  type AgentModel,
  type ModelRef,
  type PermissionMode,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type * as Cause from "effect/Cause";
import type { AgentHost, AgentSession, OpenSessionOptions } from "../host.ts";
import { endInputAndWait, isRunning, spawnServe, stopChild } from "../child-process.ts";
import { grokEnvironment, prepareGrokHome } from "./environment.ts";
import { grokRpc, initialization, modelState, record } from "./protocol.ts";

/** Source-qualified protocol/config baseline; not a live-provider or entitlement claim. */
export const GROK_CLI_VERSION = "1.0.45";
export const GROK_CAPABILITIES: AgentCapabilities = {
  fork: false,
  rewind: "none",
  steer: false,
  planMode: false,
  approvalScopes: ["once"],
  userQuestions: false,
  costReporting: false,
  perTurnModel: true,
  reasoningEffort: false,
  listSessions: false,
  subagentStreams: false,
  stopTasks: false,
};
interface GrokProtocolFixtureConfig {
  /** Gram-owned provider directory, independent of ~/.grok configuration. */
  readonly home: string;
  /** Official CLI login delegation path; Gram never reads/copies it. */
  readonly authPath: string;
  /** Injection for offline protocol fixtures; production resolves the installed native CLI. */
  readonly binary: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
}
const unavailable = (message: string) => new AgentUnavailable({ agent: "grok", message });
const login =
  "Run `grok login` in your terminal using the official Grok Build CLI, then retry. Gram requires CLI-owned session authentication; API keys are not used.";
const modeProblem = (mode: PermissionMode) =>
  new ModeRefused({
    mode,
    message:
      "Grok Build currently supports Gram's Ask (Default) mode only. Other permission modes are not qualified.",
  });
const modelProblem = (model: ModelRef) =>
  model.agent !== "grok" ||
  model.profileId !== undefined ||
  model.variant !== undefined ||
  model.speed === "fast";
const modelsOf = (state: z.infer<typeof modelState>): AgentModel[] =>
  state.availableModels.map((model) => ({
    id: model.modelId,
    displayName: model.name,
    ...(model.description === undefined ? {} : { description: model.description }),
    supportsEffort: false,
    isDefault: model.modelId === state.currentModelId,
  }));
const permission = z.object({
  sessionId: z.string(),
  toolCall: z.object({
    toolCallId: z.string(),
    title: z.string(),
    rawInput: z.unknown().optional(),
  }),
  options: z.array(z.object({ optionId: z.string(), kind: z.string() })),
});

/** One child per session; a saved provider session stays fenced until that exact child EXIT. */
export const makeUnqualifiedGrokProtocolFixture = (
  config: GrokProtocolFixtureConfig,
): AgentHost => {
  const owners = new Map<string, object>();
  const connect = (home: string, onChild?: (child: ReturnType<typeof spawnServe>) => void) =>
    Effect.gen(function* () {
      const binary = config.binary;
      yield* Effect.tryPromise({
        try: () => prepareGrokHome(home),
        catch: () => unavailable("Could not prepare the isolated Grok Build configuration"),
      });
      const child = yield* Effect.acquireRelease(
        Effect.sync(() =>
          spawnServe(
            binary,
            [...config.args, "agent", "stdio"],
            grokEnvironment(config.env, home, config.authPath),
            { stdin: "pipe", cwd: homedir() },
          ),
        ),
        (owned) =>
          Effect.promise(async () => {
            // ENOENT has a ChildProcess object but no owning process and emits no EXIT.
            // Bun also leaves exitCode null; do not enter a real-child EXIT wait here.
            if (owned.pid === undefined) {
              owned.stdin?.destroy();
              owned.stdout?.destroy();
              owned.stderr?.destroy();
              return;
            }
            if (!(await endInputAndWait(owned, 2_000))) await stopChild(owned, 1_000);
          }),
      );
      if (child.pid !== undefined) onChild?.(child);
      let receive: (message: Record<string, unknown>) => void = (message) => {
        if (message.id !== undefined) rpc.refuse(message.id);
      };
      const rpc = grokRpc(child, (message) => receive(message));
      yield* Effect.addFinalizer(() => Effect.sync(() => rpc.close()));
      const request = (method: string, params: unknown, timeout?: number) =>
        Effect.tryPromise({
          try: () => rpc.request(method, params, timeout),
          catch: () =>
            unavailable(
              `Grok Build ${method} failed. ${method === "authenticate" ? login : "Check the official CLI and retry."}`,
            ),
        });
      const init = yield* request("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "Gram", version: "0.1.1" },
        // Native tools remain CLI-owned; Gram does not grant filesystem or terminal reverse APIs.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }).pipe(
        Effect.flatMap((value) =>
          Effect.try({
            try: () => initialization.parse(value),
            catch: () => unavailable("Unsupported Grok Build initialization response"),
          }),
        ),
      );
      if (init["_meta"].agentVersion !== GROK_CLI_VERSION)
        return yield* unavailable(
          `This Grok Build version is not qualified for this adapter; expected ${GROK_CLI_VERSION}. No prompt was sent.`,
        );
      if (
        !init.authMethods.some((method) => method.id === "cached_token") ||
        init.authMethods.some((method) => method.id === "xai.api_key")
      )
        return yield* unavailable(login);
      yield* request("authenticate", { methodId: "cached_token", _meta: { headless: true } });
      const catalog = yield* request("x.ai/models/list", {}).pipe(
        Effect.flatMap((value) =>
          Effect.try({
            try: () => modelState.parse(record(value).result),
            catch: () => unavailable("Grok Build did not return an authenticated model catalog"),
          }),
        ),
      );
      return {
        catalog,
        child,
        rpc,
        request,
        init,
        listen: (handler: typeof receive) => {
          receive = handler;
        },
      };
    });

  return {
    kind: "grok",
    capabilities: GROK_CAPABILITIES,
    listModels: (options = {}) =>
      options.profileId !== undefined
        ? Effect.fail(
            unavailable(
              "Grok Build uses its official CLI login. Gateway profiles are not supported.",
            ),
          )
        : Effect.scoped(
            Effect.gen(function* () {
              const connection = yield* connect(join(config.home, "discovery"));
              return modelsOf(connection.catalog);
            }),
          ),
    open: (options) =>
      Effect.gen(function* () {
        const problem = unsupportedOptions(options);
        if (problem !== undefined) return yield* unavailable(problem);
        const saved = options.resumeId;
        if (saved !== undefined && owners.has(saved))
          return yield* unavailable(
            "The previous Grok Build child still owns this session. Wait for its actual exit before reopening.",
          );
        const claim = {};
        if (saved !== undefined) owners.set(saved, claim);
        // A failed pre-spawn attempt has no owning child. Once spawned, only EXIT clears the fence.
        let spawned = false;
        const connection = yield* connect(
          join(config.home, "sessions", options.threadId),
          (child) => {
            spawned = true;
            if (saved !== undefined)
              child.once("exit", () => {
                if (owners.get(saved) === claim) owners.delete(saved);
              });
          },
        ).pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              if (!spawned && saved !== undefined && owners.get(saved) === claim)
                owners.delete(saved);
            }),
          ),
        );
        const { child, rpc, request, init } = connection;
        let sessionId = saved ?? "";
        const release = () => {
          if (owners.get(sessionId) === claim) owners.delete(sessionId);
        };
        child.once("exit", release);
        if (saved !== undefined && !isRunning(child)) release();
        const events = yield* Queue.unbounded<AgentEvent, Cause.Done>();
        const emit = (event: AgentEvent) => {
          Queue.offerUnsafe(events, event);
        };
        const pending = new Map<
          string,
          { wireId: unknown; allow: string | undefined; deny: string | undefined }
        >();
        let running = false;
        let cancelled = false;
        let messageId = MessageId.make(randomUUID());
        let textOpen = false;
        let thoughtOpen = false;
        let servedModel: string | undefined;
        let modelConflict = false;
        const tools = new Set<string>();
        const completedTools = new Set<string>();
        let settled: Promise<void> = Promise.resolve();
        const chunk = (value: Extract<AgentEvent, { type: "chunk" }>["chunk"]) =>
          emit({ type: "chunk", messageId, chunk: value });
        const clearApprovals = () => {
          for (const [id, approval] of pending) {
            try {
              rpc.reply(approval.wireId, { outcome: { outcome: "cancelled" } });
            } catch {
              /* EXIT already rejects provider requests. */
            }
            emit({ type: "requestResolved", requestId: RequestId.make(id) });
          }
          pending.clear();
        };
        const finish = (reason: "completed" | "interrupted" | "error", error?: string) => {
          if (!running) return;
          running = false;
          clearApprovals();
          if (textOpen) chunk({ type: "text-end", id: "text" });
          if (thoughtOpen) chunk({ type: "reasoning-end", id: "thought" });
          for (const id of tools)
            if (!completedTools.has(id))
              chunk({
                type: "tool-output-error",
                toolCallId: id,
                errorText:
                  reason === "interrupted"
                    ? "Grok Build tool interrupted"
                    : "Grok Build ended before the tool completed",
              });
          emit({ type: "turnEnd", reason, ...(error === undefined ? {} : { error }) });
          emit({ type: "status", status: "idle" });
        };
        connection.listen((message) => {
          const params = record(message.params ?? {});
          if (message.method === "session/request_permission" && message.id !== undefined) {
            const parsed = permission.safeParse(params);
            if (!parsed.success || parsed.data.sessionId !== sessionId || !running || cancelled) {
              rpc.reply(message.id, { outcome: { outcome: "cancelled" } });
              return;
            }
            const p = parsed.data;
            const id = randomUUID();
            const allow = p.options.find((option) => option.kind === "allow_once")?.optionId;
            const deny = p.options.find((option) => option.kind === "reject_once")?.optionId;
            // Unknown permissions never become grants. Persistent grants are deliberately unavailable.
            pending.set(id, { wireId: message.id, allow, deny });
            emit({
              type: "request",
              request: {
                kind: "approval",
                id: RequestId.make(id),
                toolUseId: p.toolCall.toolCallId,
                toolName: p.toolCall.title,
                displayName: p.toolCall.title,
                input: { tool: p.toolCall.rawInput ?? p.toolCall.title },
                suggestions: [],
                scopes: ["once"],
              },
            });
            emit({ type: "status", status: "awaitingApproval" });
            return;
          }
          if (message.id !== undefined) {
            rpc.refuse(message.id);
            return;
          }
          if (message.method === "x.ai/session_notification" && params.sessionId === sessionId) {
            const notice = record(params.update);
            if (notice.sessionUpdate === "model_changed" && typeof notice.model_id === "string")
              emit({ type: "model", model: notice.model_id });
            if (
              notice.sessionUpdate === "served_model" &&
              typeof notice.display_name === "string" &&
              running &&
              !cancelled
            ) {
              modelConflict ||= servedModel !== undefined && servedModel !== notice.display_name;
              servedModel = notice.display_name;
              chunk({
                type: "message-metadata",
                messageMetadata: {
                  model: servedModel,
                  ...(modelConflict ? { modelConflict: true } : {}),
                },
              });
            }
            return;
          }
          if (
            message.method !== "session/update" ||
            params.sessionId !== sessionId ||
            !running ||
            cancelled
          )
            return;
          const update = record(params.update);
          if (
            update.sessionUpdate === "agent_message_chunk" ||
            update.sessionUpdate === "agent_thought_chunk"
          ) {
            const content = record(update.content);
            if (content.type !== "text" || typeof content.text !== "string") return;
            const thought = update.sessionUpdate === "agent_thought_chunk";
            if (thought ? !thoughtOpen : !textOpen) {
              chunk(
                thought
                  ? { type: "reasoning-start", id: "thought" }
                  : { type: "text-start", id: "text" },
              );
              if (thought) thoughtOpen = true;
              else textOpen = true;
            }
            chunk(
              thought
                ? { type: "reasoning-delta", id: "thought", delta: content.text }
                : { type: "text-delta", id: "text", delta: content.text },
            );
          } else if (
            (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
            typeof update.toolCallId === "string"
          ) {
            const id = update.toolCallId;
            if (!tools.has(id)) {
              tools.add(id);
              chunk({
                type: "tool-input-available",
                toolCallId: id,
                toolName: typeof update.title === "string" ? update.title : "Grok tool",
                input: update.rawInput ?? {},
              });
            }
            if (update.status === "completed") {
              completedTools.add(id);
              chunk({
                type: "tool-output-available",
                toolCallId: id,
                output: update.rawOutput ?? update.content ?? [],
              });
            }
            if (update.status === "failed") {
              completedTools.add(id);
              chunk({
                type: "tool-output-error",
                toolCallId: id,
                errorText: "Grok Build tool failed",
              });
            }
          }
          // Usage/cost is intentionally unknown: no totals are invented from ACP context gauges.
        });
        child.once("exit", () => {
          finish("error", "Grok Build process exited");
          emit({ type: "ended", reason: "Grok Build process exited" });
        });
        if (options.mcp !== undefined && init.agentCapabilities.mcpCapabilities?.http !== true)
          return yield* unavailable(
            "This Grok Build CLI does not advertise HTTP MCP support for Gram's app tools.",
          );
        if (saved !== undefined && init.agentCapabilities.loadSession !== true)
          return yield* unavailable(
            "This Grok Build CLI does not advertise session loading. The saved conversation was retained.",
          );
        const created = yield* request(saved === undefined ? "session/new" : "session/load", {
          ...(saved === undefined ? {} : { sessionId: saved }),
          cwd: options.cwd,
          _meta: { yoloMode: false, autoMode: false },
          mcpServers:
            options.mcp === undefined
              ? []
              : [
                  {
                    type: "http",
                    name: "gram",
                    url: options.mcp.url,
                    headers: Object.entries(options.mcp.headers).map(([name, value]) => ({
                      name,
                      value,
                    })),
                  },
                ],
        }).pipe(
          Effect.flatMap((value) =>
            Effect.try({
              try: () => record(value),
              catch: () => unavailable("Invalid Grok session response"),
            }),
          ),
        );
        if (saved === undefined) {
          if (typeof created.sessionId !== "string" || created.sessionId === "")
            return yield* unavailable("Grok Build returned no session identity");
          sessionId = created.sessionId;
          if (owners.has(sessionId))
            return yield* unavailable("Grok Build returned an already owned session identity");
          owners.set(sessionId, claim);
          if (!isRunning(child)) release();
        }
        const state = modelState.safeParse(created.models ?? connection.catalog);
        if (!state.success) return yield* unavailable("Grok Build returned no model catalog");
        const changeModel = (model: ModelRef) =>
          Effect.gen(function* () {
            if (
              modelProblem(model) ||
              !state.data.availableModels.some((entry) => entry.modelId === model.model)
            )
              return yield* unavailable(
                "Choose a CLI-discovered Grok Build model without gateway, effort or Fast overrides.",
              );
            yield* request("session/set_model", { sessionId, modelId: model.model });
            emit({ type: "model", model: model.model });
          });
        if (options.model !== undefined) yield* changeModel(options.model);
        // Permission mode comes from the scoped requirements file, separate from ACP prompt modes.
        emit({
          type: "identity",
          agentSessionId: sessionId,
          model: options.model?.model ?? state.data.currentModelId,
          tools: [],
          commands: [],
        });
        yield* Effect.addFinalizer(() => Effect.sync(clearApprovals));
        const session: AgentSession = {
          events: Stream.fromQueue(events),
          send: (input) =>
            Effect.sync(() => {
              if (running) throw new Error("Grok Build turn already running");
              if (input.attachments?.length) {
                emit({
                  type: "turnEnd",
                  reason: "error",
                  error: "Grok Build attachment input is not qualified.",
                });
                return;
              }
              running = true;
              cancelled = false;
              textOpen = false;
              thoughtOpen = false;
              servedModel = undefined;
              modelConflict = false;
              tools.clear();
              completedTools.clear();
              messageId = MessageId.make(randomUUID());
              emit({ type: "status", status: "running" });
              settled = rpc
                .request(
                  "session/prompt",
                  { sessionId, prompt: [{ type: "text", text: input.text }] },
                  24 * 60 * 60 * 1000,
                )
                .then(
                  (value) => {
                    const result = record(value);
                    finish(
                      cancelled || result.stopReason === "cancelled"
                        ? "interrupted"
                        : result.stopReason === "end_turn"
                          ? "completed"
                          : "error",
                      result.stopReason === "end_turn" || result.stopReason === "cancelled"
                        ? undefined
                        : "Grok Build did not complete the turn",
                    );
                  },
                  () => finish(cancelled ? "interrupted" : "error", "Grok Build prompt failed"),
                )
                .catch(() => finish("error", "Invalid Grok Build prompt result"));
            }),
          steer: () => Effect.die(new Error("Grok Build steering is not supported")),
          interrupt: Effect.tryPromise({
            try: async () => {
              if (!running) return;
              cancelled = true;
              clearApprovals();
              rpc.notify("session/cancel", { sessionId });
              await settled;
            },
            catch: () => new InterruptHung({ timeoutMs: 10_000 }),
          }).pipe(
            Effect.timeoutOrElse({
              duration: 10_000,
              orElse: () => Effect.fail(new InterruptHung({ timeoutMs: 10_000 })),
            }),
          ),
          respond: (requestId, answer) =>
            Effect.try({
              try: () => {
                const approval = pending.get(requestId);
                if (!approval || answer.kind !== "approval" || answer.scope !== "once" || cancelled)
                  throw new Error("Unavailable approval");
                const optionId = answer.decision === "allow" ? approval.allow : approval.deny;
                if (answer.decision === "allow" && optionId === undefined)
                  throw new Error("Unsupported permission grant");
                rpc.reply(
                  approval.wireId,
                  optionId === undefined
                    ? { outcome: { outcome: "cancelled" } }
                    : { outcome: { outcome: "selected", optionId } },
                );
                pending.delete(requestId);
                emit({ type: "requestResolved", requestId });
                emit({ type: "status", status: "running" });
              },
              catch: () =>
                new AnswerUndelivered({
                  message:
                    "Grok Build did not accept this approval. Only the requested once scope is supported.",
                }),
            }),
          setMode: (mode) => (mode === "default" ? Effect.void : Effect.fail(modeProblem(mode))),
          setModel: (model) => changeModel(model).pipe(Effect.orDie),
          processId: Effect.sync(() => child.pid),
        };
        return session;
      }),
  };
};

function unsupportedOptions(o: OpenSessionOptions): string | undefined {
  if (o.model !== undefined && modelProblem(o.model))
    return "Grok Build uses its official local CLI account; gateway, effort and Fast overrides are unsupported.";
  if (o.permissionMode !== undefined && o.permissionMode !== "default")
    return modeProblem(o.permissionMode).message;
  if (!/^[a-zA-Z0-9_-]+$/.test(o.threadId)) return "Invalid Grok thread identity";
  if (o.pinCwd || o.codexHome !== undefined || o.waitForPreviousSession !== undefined)
    return "Grok Build does not support the requested Codex lifecycle or shell policy.";
  if (o.fork || o.resumeAt !== undefined)
    return "Grok Build fork and rewind are not implemented. Saved history was retained.";
  if (
    o.switchStartup !== undefined ||
    o.confineWrites ||
    o.dreamFilesOnly ||
    o.dreamGuided ||
    o.outwardGate ||
    (o.audience !== undefined && o.audience !== "plain")
  )
    return "This Grok Build adapter does not support workspace switches, orchestration, Dream or confinement.";
  if (
    o.instructions ||
    o.additionalDirectories?.length ||
    o.mcpAllowlist !== undefined ||
    o.mcpDenylist?.length ||
    o.mcpNoneWithoutToolSearch ||
    o.noBlockingAsk
  )
    return "This Grok Build adapter cannot enforce the requested instructions, folder or connector restrictions.";
  return undefined;
}
