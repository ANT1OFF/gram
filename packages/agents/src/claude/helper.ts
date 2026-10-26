import { localHelperEffortSupported } from "@gram/contracts";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { HelperTransportError, type HelperAdapter } from "../helper.ts";
import type { ClaudeEnvironmentShape, PreparedClaude } from "./environment.ts";
import { AsyncPushQueue } from "./input-queue.ts";
import { toAgentModel } from "./models.ts";
import type { ClaudeSdkShape } from "./sdk.ts";

const failure = (error: unknown): HelperTransportError => {
  if (error instanceof HelperTransportError) return error;
  const reason =
    typeof error === "object" && error !== null && "reason" in error ? error.reason : undefined;
  const message = error instanceof Error ? error.message : "";
  return new HelperTransportError({
    failure:
      reason === "not-logged-in" ||
      reason === "api-key-auth" ||
      reason === "third-party-provider" ||
      /login expired|not logged in|authentication|unauthorized/i.test(message)
        ? "auth"
        : /rate.limit|usage.limit/i.test(message)
          ? "rateLimited"
          : "unavailable",
  });
};

/** No inherited debug payloads, model/body overrides, customizations or paid Fast preference. */
export const helperClaudeOptions = (prepared: PreparedClaude, cwd: string): Options => ({
  ...(prepared.sdkExecutable === undefined
    ? {}
    : { pathToClaudeCodeExecutable: prepared.sdkExecutable }),
  cwd,
  env: {
    ...Object.fromEntries(
      Object.entries(prepared.env).filter(
        ([key]) =>
          !/^(ANTHROPIC_MODEL$|ANTHROPIC_DEFAULT_|ANTHROPIC_CUSTOM_|CLAUDE_CODE_FAST|CLAUDE_CODE_EFFORT_LEVEL$|MAX_THINKING_TOKENS$|CLAUDE_CODE_EXTRA_BODY$|CLAUDE_CODE_DEBUG|ANTHROPIC_LOG$|DEBUG$)/i.test(
            key,
          ),
      ),
    ),
    CLAUDE_CODE_SAFE_MODE: "1",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_CLAUDE_AI_MCP: "1",
  },
  tools: [],
  allowedTools: [],
  mcpServers: {},
  strictMcpConfig: true,
  settingSources: [],
  plugins: [],
  persistSession: false,
  title: "Gram helper",
  promptSuggestions: false,
  agentProgressSummaries: false,
  maxTurns: 1,
  permissionMode: "dontAsk",
  canUseTool: async () => ({ behavior: "deny", message: "Helpers have no tools." }),
  settings: { fastMode: false, fallbackModel: [], disableAllHooks: true, allowedMcpServers: [] },
  extraArgs: { "safe-mode": null, "disable-slash-commands": null },
  stderr: () => {},
});

/** The prompt queue stays empty until MCP exclusions and model discovery have been verified. */
export const makeClaudeHelper = (
  environment: ClaudeEnvironmentShape,
  sdk: ClaudeSdkShape,
): HelperAdapter => {
  const withQuery = <A>(
    run: (
      q: ReturnType<ClaudeSdkShape["query"]>,
      input: AsyncPushQueue<SDKUserMessage>,
    ) => Effect.Effect<A, HelperTransportError>,
    options?: Partial<Options>,
    maxOutputTokens = 2_000,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const prepared = yield* environment.prepare;
        yield* environment.checkAuth(prepared);
        const cwd = yield* Effect.acquireRelease(
          Effect.tryPromise(() => mkdtemp(join(tmpdir(), "gram-helper-"))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const input = new AsyncPushQueue<SDKUserMessage>();
        const controller = new AbortController();
        const base = helperClaudeOptions(prepared, cwd);
        const q = yield* Effect.acquireRelease(
          Effect.sync(() =>
            sdk.query({
              prompt: input,
              options: {
                ...base,
                ...options,
                env: { ...base.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOutputTokens) },
                abortController: controller,
              },
            }),
          ),
          (query) =>
            Effect.sync(() => {
              controller.abort();
              input.end();
              query.close();
            }),
        );
        yield* Effect.tryPromise({
          try: async () => {
            const init = await q.initializationResult();
            if (init.fast_mode_state !== undefined && init.fast_mode_state !== "off")
              throw new HelperTransportError({ failure: "restriction" });
            const servers = await q.mcpServerStatus();
            if (servers.some((server) => server.status !== "disabled"))
              throw new HelperTransportError({ failure: "restriction" });
          },
          catch: failure,
        });
        return yield* run(q, input);
      }),
    ).pipe(
      Effect.mapError(failure),
      Effect.timeoutOrElse({
        duration: "20 seconds",
        orElse: () => Effect.fail(new HelperTransportError({ failure: "unavailable" })),
      }),
    );

  return {
    models: withQuery((q) =>
      Effect.tryPromise({
        try: async () => (await q.supportedModels()).map(toAgentModel),
        catch: failure,
      }),
    ),
    generate: (call) =>
      withQuery(
        (q, input) =>
          Effect.gen(function* () {
            const listed = yield* Effect.tryPromise({
              try: () => q.supportedModels(),
              catch: failure,
            });
            const model = listed.find(
              (row) => row.value === call.model || row.resolvedModel === call.model,
            );
            if (
              model === undefined ||
              !localHelperEffortSupported(toAgentModel(model), call.effort)
            )
              return yield* Effect.fail(new HelperTransportError({ failure: "unavailable" }));
            // No await between the scheduler's fresh authorization and prompt delivery. Keep this
            // in the scoped fiber so cancellation also interrupts a pending authorization read.
            yield* call.authorize(() =>
              input.push({
                type: "user",
                message: { role: "user", content: call.prompt },
                parent_tool_use_id: null,
                session_id: "",
              }),
            );
            input.end();
            return yield* Effect.tryPromise({
              try: async () => {
                const expectedModel =
                  model.resolvedModel ??
                  (model.value === "haiku" && /^Haiku 5\.5(?:\s|$)/.test(model.displayName)
                    ? "claude-haiku-5-5"
                    : model.value);
                const matchesModel = (actual: string) =>
                  actual === expectedModel ||
                  actual === call.model ||
                  (actual.startsWith(`${expectedModel}-`) &&
                    /^\d{8}$/.test(actual.slice(expectedModel.length + 1)));
                for await (const message of q) {
                  if (
                    message.type === "system" &&
                    message.subtype === "init" &&
                    !matchesModel(message.model)
                  )
                    throw new HelperTransportError({ failure: "restriction" });
                  if (message.type === "assistant" && !matchesModel(message.message.model))
                    throw new HelperTransportError({ failure: "restriction" });
                  if (
                    message.type === "system" &&
                    message.subtype === "init" &&
                    (message.tools.length > 0 ||
                      message.mcp_servers.some((server) => server.status !== "disabled"))
                  )
                    throw new HelperTransportError({ failure: "restriction" });
                  if (
                    message.type === "assistant" &&
                    message.message.content.some((block) => block.type === "tool_use")
                  )
                    throw new HelperTransportError({ failure: "restriction" });
                  if (message.type !== "result") continue;
                  if (message.subtype !== "success" || message.is_error)
                    throw failure(
                      new Error(
                        message.subtype === "success" ? message.result : message.errors.join(" "),
                      ),
                    );
                  if (Object.keys(message.modelUsage).some((id) => !matchesModel(id)))
                    throw new HelperTransportError({ failure: "restriction" });
                  if (message.result.length > call.maxOutputTokens * 16)
                    throw new HelperTransportError({ failure: "malformed" });
                  return {
                    text: message.result,
                    usage: {
                      inputTokens:
                        message.usage.input_tokens +
                        (message.usage.cache_read_input_tokens ?? 0) +
                        (message.usage.cache_creation_input_tokens ?? 0),
                      outputTokens: message.usage.output_tokens,
                    },
                  };
                }
                throw new HelperTransportError({ failure: "unavailable" });
              },
              catch: failure,
            });
          }),
        {
          model: call.model,
          systemPrompt: call.system,
          ...(call.effort === undefined || call.effort === "none" ? {} : { effort: call.effort }),
          // CLI-supported output bound, independent of subscription provider usage windows.
        },
        call.maxOutputTokens,
      ),
  };
};
