import { codexUsage } from "../testing/subscription-limit-shapes.ts";
import { describe, expect, it } from "@effect/vitest";
import {
  AgentUnavailable,
  AgentModel,
  ModelList,
  ProfileId,
  RequestId,
  ThreadId,
  type AgentEvent,
  type CodexHome,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { GatewayKeyProvider } from "../gateway.ts";
import { TRANSCRIPT_TOOL_MAX_CHARS } from "../transcript-text.ts";
import type { AgentSession, OpenSessionOptions, OutwardGate } from "../host.ts";
import type { ServerNotification } from "./protocol/ServerNotification.ts";
import type { ServerRequest } from "./protocol/ServerRequest.ts";
import { CodexRpcError, type CodexMethods, type CodexRpc } from "./rpc.ts";
import { CodexServers, type CodexListener } from "./servers.ts";
import {
  CodexHost,
  CodexHostLayer,
  confinedConfig,
  leftOutConfig,
  gatedHomeIsOwned,
  gateHoldsInMode,
  policyFor,
  unconfinedServers,
} from "./session.ts";
import { startupDiagnostic } from "./startup-diagnostic.ts";
import { codexFixture, serverMessages } from "./testing.ts";
import { toCodexTranscript } from "./transcript.ts";

const profile = {
  id: ProfileId.make("litellm"),
  name: "LiteLLM",
  baseURL: "https://llm.example/v1",
  keyRef: "ref",
  models: [{ id: "gpt-5.5", name: "GPT-5.5", variants: ["low", "high"] as const }],
};

const thread = (id: string, cwd: string, extra: Record<string, unknown> = {}) => ({
  id,
  cwd,
  preview: `prompt ${id}`,
  name: null,
  parentThreadId: null,
  ephemeral: false,
  updatedAt: 100,
  gitInfo: null,
  ...extra,
});

/** A stored thread as the fake serves it to `thread/read` and `thread/turns/list`. */
interface StoredThread {
  readonly cwd: string;
  readonly parentThreadId?: string;
  /** Pages of turns, in the order `thread/turns/list` hands them out. */
  readonly pages: ReadonlyArray<ReadonlyArray<unknown>>;
}

const harness = (
  options: {
    readonly homes?: ReadonlyArray<CodexHome>;
    readonly cliVersion?: string | null;
    readonly gateReady?: boolean;
    readonly nativeGateReady?: boolean;
    /** Each home's stored threads by id; asked of whichever home's history server was taken last. */
    readonly stored?: Partial<Record<CodexHome, Record<string, StoredThread>>>;
    /** A second `thread/list` page, behind the cursor the first one then hands out. */
    readonly olderThreads?: ReadonlyArray<unknown>;
    /** Homes of app-servers already running besides the one `acquire` hands out. */
    readonly alsoRunning?: ReadonlyArray<CodexHome>;
    /** The other running app-servers refuse every request with this. */
    readonly othersFailWith?: string;
    /** What `mcpServerStatus/list` answers in place of the default mix. */
    readonly statuses?: ReadonlyArray<unknown>;
    /** What `config/read` answers with as `config`, in place of the default servers. */
    readonly config?: Record<string, unknown>;
    readonly reload?: Effect.Effect<void, CodexRpcError>;
    readonly account?: "signedOut" | "chatgpt" | "apiKey" | "localProvider";
    readonly modelPages?: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>;
    readonly modelListErrorAt?: number;
    readonly steerFailure?: string;
    readonly respond?: Effect.Effect<void>;
    readonly repeatModelCursor?: boolean;
  } = {},
) => {
  const calls: Array<[string, unknown]> = [];
  /** The requests each other running app-server got, by home. */
  const otherCalls: Array<[CodexHome, string, unknown]> = [];
  const responses: Array<[unknown, unknown]> = [];
  const acquired: Array<string> = [];
  /** The home of each `acquire`, and of each listing server, in order. */
  const homes: Array<CodexHome> = [];
  const historyHomes: Array<CodexHome> = [];
  /** Each thread open's home and whether it was gated, in order. */
  const openings: Array<[CodexHome, OutwardGate | undefined]> = [];
  let listener: CodexListener | undefined;
  /** The holds on the user's app-server, as a session or a sign-in takes them. */
  const holds = { count: 0 };
  const retires = { count: 0 };
  const results: { [M in keyof CodexMethods]?: (params: CodexMethods[M][0]) => unknown } = {
    "thread/start": () => ({ thread: { id: "thr_1" }, model: "gpt-5.5" }),
    "thread/resume": (p) => ({ thread: { id: p.threadId }, model: "gpt-5.5" }),
    "thread/fork": () => ({ thread: { id: "thr_fork" }, model: "gpt-5.5" }),
    "skills/list": () => ({
      data: [
        {
          cwd: "/repo",
          skills: [
            {
              name: "ship-it",
              description: "Ships it",
              path: "/repo/.agents/skills/ship-it/SKILL.md",
              scope: "repo",
              enabled: true,
            },
            {
              name: "ship-it",
              description: "Shadowed",
              path: "/home/.agents/skills/ship-it/SKILL.md",
              scope: "user",
              enabled: true,
            },
            {
              name: "off",
              description: "Disabled",
              path: "/home/.agents/skills/off/SKILL.md",
              scope: "user",
              enabled: false,
            },
          ],
          errors: [],
        },
      ],
    }),
    "thread/compact/start": () => ({}),
    "thread/turns/list": (p) => {
      const stored = options.stored?.[historyHomes.at(-1) ?? "user"]?.[p.threadId];
      if (stored === undefined) {
        return { data: [{ id: "turn_1" }, { id: "turn_2" }, { id: "turn_3" }] };
      }
      const page = Number(p.cursor ?? 0);
      return {
        data: stored.pages[page],
        nextCursor: page + 1 < stored.pages.length ? String(page + 1) : null,
      };
    },
    "thread/read": (p) => {
      const stored = options.stored?.[historyHomes.at(-1) ?? "user"]?.[p.threadId];
      if (stored === undefined) throw new Error(`thread not loaded: ${p.threadId}`);
      return {
        thread: thread(p.threadId, stored.cwd, { parentThreadId: stored.parentThreadId ?? null }),
      };
    },
    "thread/revert": () => ({}),
    "turn/start": () => ({ turn: { id: "turn_9" } }),
    "turn/steer": () => {
      if (options.steerFailure !== undefined) throw new Error(options.steerFailure);
      return { turnId: "turn_9" };
    },
    "turn/interrupt": () => ({}),
    "account/rateLimits/read": () => codexUsage,
    "account/read": () => ({
      account:
        options.account === "signedOut" || options.account === "localProvider"
          ? null
          : options.account === "apiKey"
            ? { type: "apiKey" }
            : { type: "chatgpt", email: null, planType: "plus" },
      requiresOpenaiAuth: options.account !== "localProvider",
      workspaceRouting: null,
    }),
    "model/list": (p) => {
      const page = Number(p.cursor ?? "0");
      if (page === options.modelListErrorAt) throw new Error("synthetic discovery failure");
      return options.modelPages === undefined
        ? {
            data: [
              {
                id: "gpt-6",
                displayName: "GPT-6",
                description: "Capable",
                hidden: false,
                isDefault: true,
                supportedReasoningEfforts: [
                  { reasoningEffort: "low" },
                  { reasoningEffort: "high" },
                ],
              },
              {
                id: "secret",
                displayName: "Hidden",
                description: "",
                hidden: true,
                isDefault: false,
                supportedReasoningEfforts: [],
              },
            ],
            nextCursor: null,
          }
        : {
            data: options.modelPages[page],
            nextCursor: options.repeatModelCursor
              ? "0"
              : page + 1 < options.modelPages.length
                ? String(page + 1)
                : null,
          };
    },
    "thread/list": (p) =>
      p.cursor === "older"
        ? { data: options.olderThreads, nextCursor: null }
        : {
            data: [
              thread("thr_old", "/repo", { updatedAt: 10 }),
              thread("thr_new", "/repo/", { updatedAt: 20, name: "Named" }),
              thread("thr_child", "/repo", { parentThreadId: "thr_new" }),
              thread("thr_elsewhere", "/other"),
            ],
            nextCursor: options.olderThreads === undefined ? null : "older",
          },
    "thread/delete": () => ({}),
    "mcpServerStatus/list": () => ({
      data: options.statuses ?? [
        {
          name: "docs",
          runtimeStatus: "disabled",
          toolsError: null,
          pluginId: null,
          authStatus: "oAuth",
        },
        { name: "gram", runtimeStatus: "connected", toolsError: null, pluginId: null },
        {
          name: "sentry",
          runtimeStatus: "failed",
          toolsError: "tools/list timed out",
          pluginId: "sentry@openai",
        },
        {
          name: "linear",
          runtimeStatus: "authenticationRequired",
          toolsError: null,
          pluginId: null,
          authStatus: "notLoggedIn",
        },
        { name: "slow", runtimeStatus: null, toolsError: null, pluginId: null },
      ],
      nextCursor: null,
    }),
    "mcpServer/oauth/login": (p) => {
      if (p.name === "gone") throw new Error("No MCP server named 'gone' found.");
      return { authorizationUrl: `https://idp.example/authorize?server=${p.name}` };
    },
    "config/mcpServer/reload": () => ({}),
    "config/read": () => ({
      config: options.config ?? {
        mcp_servers: {
          docs: { url: "https://docs.example/mcp", enabled: false },
          linear: { url: "https://linear.example/mcp", http_headers: { "X-Key": "sekrit-value" } },
          files: { command: "npx", args: ["-y", "fs"], env: { ROOT: "sekrit-value" } },
          team: { url: "https://team.example/mcp" },
        },
      },
      origins: {
        "mcp_servers.docs.url": { name: { type: "user", file: "/h/config.toml" }, version: "v" },
        "mcp_servers.team.url": {
          name: { type: "project", dotCodexFolder: "/repo/.codex" },
          version: "v",
        },
      },
      layers: null,
    }),
    "config/batchWrite": () => ({
      status: "ok",
      version: "v",
      filePath: "/home/.codex/config.toml",
    }),
  };
  const rpc: CodexRpc = {
    request: (method, params) =>
      method === "config/mcpServer/reload" && options.reload !== undefined
        ? options.reload.pipe(Effect.as({} as never))
        : Effect.try({
            try: () => {
              calls.push([method, params]);
              return (results[method] as (p: unknown) => unknown)(params) as never;
            },
            catch: (error) => new CodexRpcError({ method, message: (error as Error).message }),
          }),
    notify: () => Effect.void,
    respond: (id, result) =>
      (options.respond ?? Effect.void).pipe(
        Effect.andThen(Effect.sync(() => void responses.push([id, result]))),
      ),
    messages: Stream.empty,
  };
  const layer = CodexHostLayer({ newId: () => "id-1" }).pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(CodexServers)({
          acquire: (profileId, home) =>
            Effect.sync(() => {
              acquired.push(profileId ?? "local");
              homes.push(home);
              return {
                rpc,
                cliVersion:
                  options.cliVersion === null ? undefined : (options.cliVersion ?? "0.162.1"),
                openThread: (_resumeId, open) => open,
                waitForThreadExit: () => Effect.void,
                configCurrent: Effect.succeed(true),
                gateway: profileId !== undefined,
                warnings: ["version skew"],
                subscribe: (_threadId, next) => Effect.sync(() => void (listener = next)),
                retain: Effect.acquireRelease(
                  Effect.sync(() => {
                    holds.count++;
                    return true;
                  }),
                  () => Effect.sync(() => void holds.count--),
                ),
                generated: [],
              };
            }),
          opening: (home, gate) => (open) =>
            Effect.sync(() => void openings.push([home, gate])).pipe(Effect.andThen(open)),
          gateReady: options.gateReady ?? false,
          gateReadyFor: (home) =>
            home === "owned"
              ? options.nativeGateReady === true
              : home === "gateway" && options.gateReady === true,
          invalidate: () => Effect.void,
          retire: () => Effect.void,
          retireAll: Effect.sync(() => {
            retires.count++;
          }),
          running: Effect.succeed(
            (options.alsoRunning ?? []).map((home) => ({
              home,
              server: {
                rpc: {
                  ...rpc,
                  request: (method, params) =>
                    Effect.suspend(() => {
                      otherCalls.push([home, method, params]);
                      return options.othersFailWith === undefined
                        ? Effect.succeed({} as never)
                        : Effect.fail(
                            new CodexRpcError({ method, message: options.othersFailWith }),
                          );
                    }),
                },
                openThread: (_resumeId, open) => open,
                waitForThreadExit: () => Effect.void,
                configCurrent: Effect.succeed(true),
                gateway: home === "gateway",
                warnings: [],
                subscribe: () => Effect.void,
                retain: Effect.succeed(true),
                generated: [],
              },
            })),
          ),
          homes: options.homes ?? ["user"],
          history: (home) =>
            Effect.sync(() => {
              historyHomes.push(home);
              return {
                rpc,
                openThread: (_resumeId, open) => open,
                waitForThreadExit: () => Effect.void,
                configCurrent: Effect.succeed(true),
                gateway: false,
                warnings: [],
                subscribe: (_threadId, next) => Effect.sync(() => void (listener = next)),
                retain: Effect.succeed(true),
                generated: [],
              };
            }),
        }),
        Layer.succeed(GatewayKeyProvider)({
          credentials: (profileId, agent) =>
            profileId === profile.id
              ? Effect.succeed({ profile, key: Redacted.make("secret") })
              : Effect.fail(new AgentUnavailable({ agent, message: "no profile" })),
        }),
      ),
    ),
  );
  return {
    calls,
    otherCalls,
    responses,
    acquired,
    homes,
    historyHomes,
    openings,
    holds,
    retires,
    layer,
    push: (message: ServerNotification | ServerRequest) => listener?.message(message),
  };
};

const openSession = (overrides: Partial<OpenSessionOptions> = {}) =>
  Effect.gen(function* () {
    const host = yield* CodexHost;
    return yield* host.open({ threadId: ThreadId.make("t1"), cwd: "/repo", ...overrides });
  });

const take = (session: AgentSession, n: number) =>
  Stream.runCollect(Stream.take(session.events, n));

const gatewayModel = {
  agent: "codex" as const,
  model: "gpt-5.5",
  profileId: profile.id,
  variant: "high" as const,
};

/** Opens a session on a fresh harness: the homes it acquired and its identity event. */
const openOnHomes = (options: Partial<OpenSessionOptions>) =>
  Effect.gen(function* () {
    const h = harness();
    const session = yield* openSession(options).pipe(Effect.provide(h.layer));
    const identity = (yield* take(session, 2))[1];
    return { acquired: h.acquired, homes: h.homes, identity };
  });

describe("CodexHost.open", () => {
  it.effect("starts a thread with the thread's MCP server, and emits identity", () =>
    Effect.gen(function* () {
      const h = harness();
      const session = yield* openSession({
        model: gatewayModel,
        mcp: { url: "http://127.0.0.1:4317/mcp", headers: { authorization: "Bearer tok" } },
        additionalDirectories: ["/shared"],
      }).pipe(Effect.provide(h.layer));
      expect(h.acquired).toEqual(["litellm"]);
      expect(h.calls).toEqual([
        [
          "thread/start",
          {
            cwd: "/repo",
            model: "gpt-5.5",
            approvalPolicy: "on-request",
            sandbox: "workspace-write",
            config: {
              mcp_servers: {
                gram: {
                  enabled: true,
                  url: "http://127.0.0.1:4317/mcp",
                  http_headers: { authorization: "Bearer tok" },
                  default_tools_approval_mode: "approve",
                },
              },
              sandbox_workspace_write: { writable_roots: ["/shared"] },
            },
          },
        ],
        ["skills/list", { cwds: ["/repo"] }],
      ]);
      expect(yield* take(session, 3)).toEqual([
        {
          type: "notice",
          level: "warning",
          message: "version skew",
          startupDiagnostic: startupDiagnostic(
            JSON.stringify(["gateway", profile.id]),
            "Codex startup",
            ["version skew"],
          ),
        },
        {
          type: "identity",
          agentSessionId: "thr_1",
          codexHome: "gateway",
          model: "gpt-5.5",
          tools: [],
          commands: [
            { name: "compact", description: "Summarize the conversation to free up context" },
            { name: "ship-it", description: "Ships it" },
          ],
        },
        { type: "status", status: "idle" },
      ]);
    }),
  );

  it.effect("passes the role's instructions as developer instructions at every kind of open", () =>
    Effect.gen(function* () {
      const instructions = "# Your role: worker";
      const opens = [{}, { resumeId: "thr_old" }, { resumeId: "thr_old", fork: true }] as const;
      for (const [index, how] of opens.entries()) {
        const h = harness();
        yield* openSession({ ...how, instructions }).pipe(Effect.provide(h.layer));
        expect(h.calls[0]).toEqual([
          ["thread/start", "thread/resume", "thread/fork"][index],
          expect.objectContaining({ developerInstructions: instructions }),
        ]);
      }
      const plain = harness();
      yield* openSession({}).pipe(Effect.provide(plain.layer));
      expect(plain.calls[0]?.[1]).not.toHaveProperty("developerInstructions");
    }),
  );

  it.effect("sends a skill as Codex's `$name`, and /compact as a compaction", () =>
    Effect.gen(function* () {
      const h = harness();
      const session = yield* openSession({}).pipe(Effect.provide(h.layer));
      yield* session.send({ text: "/compact" });
      yield* session.send({ text: "/ship-it to staging" });
      // Into the turn that send started.
      yield* session.steer({ text: "/ship-it to prod" });
      yield* session.steer({ text: "/compact" });
      yield* session.send({ text: "/tmp is full" });
      const sent = h.calls.flatMap(([method, params]) =>
        method === "turn/start" || method === "turn/steer"
          ? [`${method} ${(params as { input: ReadonlyArray<{ text: string }> }).input[0]?.text}`]
          : method === "thread/compact/start"
            ? [method]
            : [],
      );
      expect(sent).toEqual([
        "thread/compact/start",
        "turn/start $ship-it to staging",
        "turn/steer $ship-it to prod",
        "turn/steer /compact",
        "turn/start /tmp is full",
      ]);
    }),
  );

  it.effect("tracks and interrupts the provider turn after manual compaction acknowledgement", () =>
    Effect.gen(function* () {
      const h = harness();
      const session = yield* openSession({}).pipe(Effect.provide(h.layer));
      yield* take(session, 2); // Discovery warning and identity only.
      yield* session.send({ text: "/compact" });
      const manualTurn = {
        id: "manual-turn",
        rootTurnId: null,
        items: [],
        itemsView: "full" as const,
        error: null,
        startedAt: 1,
      };
      h.push({
        method: "turn/started",
        params: {
          threadId: "thr_1",
          turn: {
            ...manualTurn,
            status: "inProgress",
            completedAt: null,
            durationMs: null,
          },
        },
      });
      h.push({
        method: "item/started",
        params: {
          threadId: "thr_1",
          turnId: "manual-turn",
          startedAtMs: 1_000,
          item: { type: "contextCompaction", id: "manual-item" },
        },
      });
      const started = yield* take(session, 4);
      expect(started.at(-1)).toMatchObject({
        type: "status",
        status: "compacting",
        compaction: { trigger: "manual" },
      });
      expect(started.some((e) => e.type === "turnEnd")).toBe(false);
      yield* session.interrupt;
      expect(h.calls.filter(([m]) => m === "turn/interrupt")).toEqual([
        ["turn/interrupt", { threadId: "thr_1", turnId: "manual-turn" }],
      ]);
      expect(h.calls.filter(([m]) => m === "thread/compact/start")).toHaveLength(1);
      expect(h.calls.some(([m]) => m === "turn/start")).toBe(false);
      h.push({
        method: "turn/completed",
        params: {
          threadId: "thr_1",
          turn: {
            ...manualTurn,
            status: "interrupted",
            completedAt: 2,
            durationMs: 1_000,
          },
        },
      });
      const ended = yield* session.events.pipe(
        Stream.takeUntil((event) => event.type === "turnEnd"),
        Stream.runCollect,
      );
      expect(ended).toEqual([
        { type: "chunk", messageId: "id-1", chunk: { type: "finish-step" } },
        { type: "chunk", messageId: "id-1", chunk: { type: "finish" } },
        { type: "turnEnd", reason: "interrupted" },
      ]);
      expect(ended.at(-1)).toEqual({ type: "turnEnd", reason: "interrupted" });
      expect(ended.some((e) => e.type === "chunk" && e.chunk.type === "data-compaction")).toBe(
        false,
      );
      yield* session.send({ text: "continue" });
      expect(h.calls.filter(([m]) => m === "turn/start")).toHaveLength(1);
    }),
  );

  it.effect("states its policy with a resumed session's first turn, and only that one", () =>
    Effect.gen(function* () {
      const h = harness({ gateReady: true });
      const session = yield* openSession({
        resumeId: "thr_old",
        codexHome: "gateway",
        model: gatewayModel,
        permissionMode: "bypassPermissions",
        outwardGate: "all",
      }).pipe(Effect.provide(h.layer));
      yield* session.send({ text: "one" });
      yield* session.send({ text: "two" });
      const turns = h.calls.filter(([method]) => method === "turn/start").map(([, p]) => p);
      expect(turns[0]).toMatchObject({
        approvalPolicy: "untrusted",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "dangerFullAccess" },
      });
      expect(turns[1]).not.toHaveProperty("approvalPolicy");

      for (const how of [{}, { resumeId: "thr_old", fork: true }]) {
        const fresh = harness();
        const opened = yield* openSession(how).pipe(Effect.provide(fresh.layer));
        yield* opened.send({ text: "one" });
        expect(fresh.calls.at(-1)?.[1]).not.toHaveProperty("approvalPolicy");
      }
    }),
  );

  it.effect("resumes, forks through a turn, and reverts to just after resumeAt", () =>
    Effect.gen(function* () {
      const resumed = harness();
      yield* openSession({ resumeId: "thr_old" }).pipe(Effect.provide(resumed.layer));
      expect(resumed.calls.map(([method]) => method)).toEqual(["thread/resume", "skills/list"]);

      const forked = harness();
      yield* openSession({ resumeId: "thr_old", resumeAt: "turn_1", fork: true }).pipe(
        Effect.provide(forked.layer),
      );
      expect(forked.calls).toEqual([
        [
          "thread/fork",
          expect.objectContaining({
            threadId: "thr_old",
            lastTurnId: "turn_1",
            excludeTurns: true,
          }),
        ],
        ["skills/list", { cwds: ["/repo"] }],
      ]);

      const reverted = harness();
      yield* openSession({ resumeId: "thr_old", resumeAt: "turn_2" }).pipe(
        Effect.provide(reverted.layer),
      );
      expect(
        reverted.calls.map(([method, params]) =>
          method === "thread/revert" ? [method, params] : method,
        ),
      ).toEqual([
        "thread/resume",
        "thread/turns/list",
        ["thread/revert", { threadId: "thr_old", beforeTurnId: "turn_3" }],
        "skills/list",
      ]);

      const unknown = harness();
      const error = yield* Effect.flip(
        openSession({ resumeId: "thr_old", resumeAt: "turn_x" }).pipe(
          Effect.provide(unknown.layer),
        ),
      );
      expect(error.message).toContain("turn_x");
    }),
  );

  it.effect(
    "keeps each session on its home: unrecorded ones on the user's, gateway ones on theirs",
    () =>
      Effect.gen(function* () {
        // No recorded home: a session, even one that ran on a gateway profile, reopens and forks
        // in the user's own home, still with the profile's key.
        const unrecorded = yield* openOnHomes({ resumeId: "thr_old", model: gatewayModel });
        expect(unrecorded).toMatchObject({ acquired: ["litellm"], homes: ["user"] });
        expect(unrecorded.identity).toMatchObject({ type: "identity", codexHome: "user" });
        expect(
          (yield* openOnHomes({
            resumeId: "thr_old",
            fork: true,
            resumeAt: "turn_1",
            model: gatewayModel,
          })).homes,
        ).toEqual(["user"]);

        // A new gateway session starts on the gateway home, and reopens and forks there.
        expect((yield* openOnHomes({ model: gatewayModel })).identity).toMatchObject({
          codexHome: "gateway",
        });
        const gateway = { codexHome: "gateway" as const, model: gatewayModel };
        expect((yield* openOnHomes({ resumeId: "thr_1", ...gateway })).homes).toEqual(["gateway"]);
        expect(
          (yield* openOnHomes({ resumeId: "thr_1", fork: true, resumeAt: "turn_1", ...gateway }))
            .homes,
        ).toEqual(["gateway"]);

        // A session picked from the user's home resumes there on the chosen profile's credentials.
        expect(
          yield* openOnHomes({ resumeId: "thr_old", codexHome: "user", model: gatewayModel }),
        ).toMatchObject({ acquired: ["litellm"], homes: ["user"] });
        // Without a profile, a new session uses the user's own home and login.
        expect(yield* openOnHomes({})).toMatchObject({ acquired: ["local"], homes: ["user"] });
      }),
  );
});

describe("CodexSession", () => {
  it.effect(
    "sends turns with model, effort and plan mode, and steers and interrupts the running turn",
    () =>
      Effect.gen(function* () {
        const h = harness();
        const session = yield* openSession({ model: gatewayModel }).pipe(Effect.provide(h.layer));
        yield* session.send({ text: "hi" }, { messageId: "msg-1" });
        yield* session.setMode("plan");
        yield* session.send({ text: "plan it" });
        yield* session.setMode("bypassPermissions");
        yield* session.send({ text: "go" });
        const turns = h.calls
          .filter(([method]) => method === "turn/start")
          .map(([, params]) => params);
        expect(turns[0]).toEqual({
          threadId: "thr_1",
          input: [{ type: "text", text: "hi", text_elements: [] }],
          clientUserMessageId: "msg-1",
          model: "gpt-5.5",
          effort: "high",
        });
        expect(turns[1]).toMatchObject({
          collaborationMode: {
            mode: "plan",
            settings: { model: "gpt-5.5", reasoning_effort: "high" },
          },
        });
        expect(turns[1]).not.toHaveProperty("approvalPolicy");
        // Leaving plan mode is sent once, with the new approval policy and sandbox.
        expect(turns[2]).toMatchObject({
          collaborationMode: { mode: "default" },
          approvalPolicy: "never",
          sandboxPolicy: { type: "dangerFullAccess" },
        });

        h.push({
          method: "turn/started",
          params: { threadId: "thr_1", turn: { id: "turn_9" } },
        } as never);
        yield* session.steer({ text: "shorter" });
        yield* session.interrupt;
        expect(h.calls.slice(-2)).toEqual([
          [
            "turn/steer",
            {
              threadId: "thr_1",
              expectedTurnId: "turn_9",
              input: [{ type: "text", text: "shorter", text_elements: [] }],
            },
          ],
          ["turn/interrupt", { threadId: "thr_1", turnId: "turn_9" }],
        ]);
      }),
  );

  it.effect("never starts a turn from a steer, after the turn ends or when Codex refuses it", () =>
    Effect.gen(function* () {
      const h = harness({ steerFailure: "synthetic steer refusal" });
      const session = yield* openSession().pipe(Effect.provide(h.layer));
      const starts = () => h.calls.filter(([method]) => method === "turn/start").length;
      h.push({
        method: "turn/started",
        params: { threadId: "thr_1", turn: { id: "turn_9" } },
      } as never);
      const outcome = (text: string) =>
        session.steer({ text }).pipe(
          Effect.as("taken"),
          Effect.catchDefect((defect) => Effect.succeed(String(defect))),
        );
      expect(yield* outcome("correction")).toContain("Codex refused the steer");
      // The turn ends before the runtime has seen its end: a steer now has no turn to join.
      h.push({
        method: "turn/completed",
        params: { threadId: "thr_1", turn: { id: "turn_9", status: "completed" } },
      } as never);
      expect(yield* outcome("late notice")).toContain("no running turn");
      expect(h.calls.filter(([method]) => method === "turn/steer")).toHaveLength(1);
      expect(starts()).toBe(0);
    }),
  );

  it.effect("raises approval cards from recorded requests and answers them", () =>
    Effect.gen(function* () {
      const h = harness();
      const session = yield* openSession().pipe(Effect.provide(h.layer));
      yield* take(session, 3);
      for (const message of serverMessages(codexFixture("cx02-approval"))) {
        if (message.method === "item/commandExecution/requestApproval") h.push(message);
      }
      const events: ReadonlyArray<AgentEvent> = yield* take(session, 1);
      expect(events[0]).toMatchObject({
        type: "request",
        request: { kind: "approval", toolName: "Bash" },
      });
      yield* session.respond(RequestId.make("codex-0"), {
        kind: "approval",
        decision: "allow",
        scope: "always",
      });
      yield* session.respond(RequestId.make("codex-0"), {
        kind: "approval",
        decision: "deny",
        scope: "once",
      });
      expect(h.responses).toEqual([
        [
          0,
          {
            decision: {
              acceptWithExecpolicyAmendment: { execpolicy_amendment: ["echo", "hello"] },
            },
          },
        ],
      ]);
    }),
  );
});

const commandRequest = (id: number, command: string, extra: Record<string, unknown> = {}) =>
  ({
    method: "item/commandExecution/requestApproval",
    id,
    params: {
      kind: "command",
      threadId: "thr_1",
      turnId: "turn_9",
      itemId: `call_${id}`,
      startedAtMs: 0,
      environmentId: "local",
      command: `/bin/zsh -lc '${command}'`,
      cwd: "/repo",
      commandActions: [{ type: "unknown", command }],
      proposedExecpolicyAmendment: command.split(" "),
      // What codex 0.154.0 offers under `untrusted`: no `decline`.
      availableDecisions: [
        "accept",
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: command.split(" ") } },
        "cancel",
      ],
      ...extra,
    },
  }) as unknown as ServerRequest;

const patchRequest = (id: number) =>
  ({
    method: "item/fileChange/requestApproval",
    id,
    params: { threadId: "thr_1", turnId: "turn_9", itemId: `call_${id}`, startedAtMs: 0 },
  }) as unknown as ServerRequest;

const threadStatus = (...activeFlags: ReadonlyArray<string>) =>
  ({
    method: "thread/status/changed",
    params: { threadId: "thr_1", status: { type: "active", activeFlags } },
  }) as unknown as ServerNotification;

const allowOnce = { kind: "approval", decision: "allow", scope: "once" } as const;
const allowAlways = { kind: "approval", decision: "allow", scope: "always" } as const;
const deny = { kind: "approval", decision: "deny", scope: "once" } as const;

/** Everything the session has emitted so far, after the three events of opening. */
const drain = (session: AgentSession, n: number) =>
  take(session, 3 + n).pipe(Effect.map((events) => events.slice(3)));

describe("Codex approval delivery", () => {
  it.effect("keeps an undelivered answer pending for a successful retry", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const h = harness({
        respond: Effect.suspend(() =>
          ++attempts === 1 ? Effect.die(new Error("synthetic pipe write failure")) : Effect.void,
        ),
      });
      const session = yield* openSession().pipe(Effect.provide(h.layer));
      h.push(commandRequest(73, "echo hello"));
      const requestId = RequestId.make("codex-73");
      const failure = yield* Effect.flip(session.respond(requestId, allowOnce));
      expect(failure._tag).toBe("AnswerUndelivered");
      expect(h.responses).toEqual([]);
      yield* session.respond(requestId, allowOnce);
      expect(h.responses).toEqual([[73, { decision: "accept" }]]);
      yield* session.respond(requestId, allowOnce);
      expect(attempts).toBe(2);
    }),
  );
});

describe("policyFor and the outward gate's helpers", () => {
  it("maps each mode to a policy, and only bypass changes under the gate", () => {
    const sandboxed = { approvalPolicy: "on-request", sandbox: "workspace-write" };
    const table = [
      ["bypassPermissions", { approvalPolicy: "never", sandbox: "danger-full-access" }],
      ["dontAsk", { approvalPolicy: "never", sandbox: "workspace-write" }],
      ["default", sandboxed],
      ["acceptEdits", sandboxed],
      ["auto", sandboxed],
      ["plan", sandboxed],
    ] as const;
    for (const [mode, policy] of table) {
      expect(policyFor(mode)).toEqual(policy);
      expect(policyFor(mode, false)).toEqual(policy);
      expect(policyFor(mode, true)).toEqual(
        mode === "bypassPermissions"
          ? { approvalPolicy: "untrusted", sandbox: "danger-full-access" }
          : policy,
      );
      expect(gateHoldsInMode(mode)).toBe(mode !== "dontAsk");
    }
  });

  it("lets a gated session run only on Gram's home, with its rules available", () => {
    expect(gatedHomeIsOwned("owned", true)).toBe(true);
    expect(gatedHomeIsOwned("owned", false)).toBe(false);
    expect(gatedHomeIsOwned("gateway", true)).toBe(true);
    expect(gatedHomeIsOwned("gateway", false)).toBe(false);
    expect(gatedHomeIsOwned("user", true)).toBe(false);
  });
});

describe("CodexSession under the outward gate", () => {
  const gatedBypass = {
    model: gatewayModel,
    outwardGate: true,
    permissionMode: "bypassPermissions" as const,
  };

  it.effect("refuses the user's own home, and a gateway home with no rules to put in it", () =>
    Effect.gen(function* () {
      const own = harness({ gateReady: true });
      const error = yield* Effect.flip(
        openSession({ outwardGate: true, codexHome: "user" }).pipe(Effect.provide(own.layer)),
      );
      expect(error).toMatchObject({ _tag: "AgentUnavailable", reason: "startup-failed" });
      expect(error.message).toContain("prepared native or gateway home");
      expect(own.acquired).toEqual([]);

      const bare = harness();
      yield* Effect.flip(openSession(gatedBypass).pipe(Effect.provide(bare.layer)));
      expect(bare.calls).toEqual([]);

      // Ungated sessions open on either, with nothing new in the request.
      const plain = harness();
      yield* openSession({ permissionMode: "bypassPermissions" }).pipe(Effect.provide(plain.layer));
      expect(plain.openings).toEqual([["user", undefined]]);
      expect(plain.calls[0]?.[1]).toEqual({
        cwd: "/repo",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
    }),
  );

  it.effect(
    "uses the owned home for a new native gated session and refuses missing preparation or non-ChatGPT auth",
    () =>
      Effect.gen(function* () {
        const ready = harness({ nativeGateReady: true });
        yield* openSession({ outwardGate: "all", permissionMode: "bypassPermissions" }).pipe(
          Effect.provide(ready.layer),
        );
        expect(ready.homes).toEqual(["owned"]);
        expect(ready.openings).toEqual([["owned", "all"]]);
        expect(ready.calls.find(([method]) => method === "thread/start")?.[1]).toMatchObject({
          modelProvider: "openai",
          allowProviderModelFallback: false,
          approvalPolicy: "untrusted",
          approvalsReviewer: "user",
          config: { features: { exec_policy: true, hooks: false } },
        });
        for (const account of ["signedOut", "apiKey", "localProvider"] as const) {
          const h = harness({ nativeGateReady: true, account });
          yield* Effect.flip(openSession({ outwardGate: true }).pipe(Effect.provide(h.layer)));
          expect(h.calls.some(([method]) => method === "thread/start")).toBe(false);
        }
        const absent = harness({ gateReady: true });
        yield* Effect.flip(openSession({ outwardGate: true }).pipe(Effect.provide(absent.layer)));
        expect(absent.acquired).toEqual([]);
      }),
  );

  it.effect("opens bypass as untrusted with the user as reviewer, under the gate's rules", () =>
    Effect.gen(function* () {
      const h = harness({ gateReady: true });
      yield* openSession(gatedBypass).pipe(Effect.provide(h.layer));
      expect(h.openings).toEqual([["gateway", "all"]]);
      expect(h.calls[0]).toEqual([
        "thread/start",
        {
          cwd: "/repo",
          model: "gpt-5.5",
          approvalPolicy: "untrusted",
          approvalsReviewer: "user",
          sandbox: "danger-full-access",
        },
      ]);
      const resumed = harness({ gateReady: true });
      yield* openSession({ ...gatedBypass, resumeId: "thr_1", codexHome: "gateway" }).pipe(
        Effect.provide(resumed.layer),
      );
      expect(resumed.calls[0]?.[1]).toMatchObject({
        approvalPolicy: "untrusted",
        approvalsReviewer: "user",
      });
    }),
  );

  it.effect(
    "in bypass, accepts commands and patches unseen and keeps the thread running, and asks once about a push",
    () =>
      Effect.gen(function* () {
        const h = harness({ gateReady: true });
        const session = yield* openSession(gatedBypass).pipe(Effect.provide(h.layer));
        h.push(threadStatus());
        // Codex flags the wait before it sends the request.
        h.push(threadStatus("waitingOnApproval"));
        h.push(commandRequest(0, "git status"));
        h.push(threadStatus());
        h.push(threadStatus("waitingOnApproval"));
        h.push(patchRequest(1));
        h.push(threadStatus());
        h.push(threadStatus("waitingOnApproval"));
        h.push(commandRequest(2, "git push origin HEAD:main"));
        h.push(threadStatus("waitingOnApproval"));
        expect(h.responses).toEqual([
          [0, { decision: "accept" }],
          [1, { decision: "accept" }],
        ]);
        // The mode event marks the end: nothing else was emitted, no flicker to "needs you".
        yield* session.setMode("bypassPermissions");
        expect(yield* drain(session, 4)).toEqual([
          { type: "status", status: "running" },
          { type: "status", status: "awaitingApproval" },
          {
            type: "request",
            request: expect.objectContaining({
              kind: "approval",
              id: "codex-2",
              toolName: "Bash",
              input: { command: "git push origin HEAD:main", cwd: "/repo" },
              suggestions: [],
              scopes: ["once"],
            }),
          },
          { type: "mode", mode: "bypassPermissions" },
        ]);

        // "Always" can't be asked for, and a stale client that sends it still gets one run.
        yield* session.respond(RequestId.make("codex-2"), allowAlways);
        expect(h.responses[2]).toEqual([2, { decision: "accept" }]);

        // A denied push goes back to the model; `cancel` would end the turn.
        h.push(commandRequest(3, "cd sub && gh pr create --fill"));
        yield* session.respond(RequestId.make("codex-3"), deny);
        expect(h.responses[3]).toEqual([3, { decision: "decline" }]);
      }),
  );

  it.effect(
    "at irreversible, in bypass, accepts a push and a new PR unseen and asks once about the rest",
    () =>
      Effect.gen(function* () {
        const h = harness({ gateReady: true });
        const session = yield* openSession({ ...gatedBypass, outwardGate: "irreversible" }).pipe(
          Effect.provide(h.layer),
        );
        expect(h.openings).toEqual([["gateway", "irreversible"]]);
        expect(h.calls[0]?.[1]).toMatchObject({
          approvalPolicy: "untrusted",
          approvalsReviewer: "user",
          sandbox: "danger-full-access",
        });
        h.push(commandRequest(0, "git push -u origin feature"));
        h.push(commandRequest(1, "cd sub && gh pr create --fill"));
        h.push(commandRequest(2, "git push --force-with-lease"));
        h.push(commandRequest(3, "git push origin :old"));
        h.push(commandRequest(4, "gh pr merge 3 --squash"));
        expect(h.responses).toEqual([
          [0, { decision: "accept" }],
          [1, { decision: "accept" }],
        ]);
        const events = yield* drain(session, 4);
        expect(
          events.flatMap((e) =>
            e.type === "request" && e.request.kind === "approval"
              ? [[e.request.id, e.request.scopes]]
              : [],
          ),
        ).toEqual([
          ["codex-2", ["once"]],
          ["codex-3", ["once"]],
          ["codex-4", ["once"]],
        ]);
        yield* session.respond(RequestId.make("codex-2"), allowAlways);
        yield* session.respond(RequestId.make("codex-4"), deny);
        expect(h.responses.slice(2)).toEqual([
          [2, { decision: "accept" }],
          [4, { decision: "decline" }],
        ]);
      }),
  );

  it.effect(
    "at irreversible, in a sandboxed mode, a push is an ordinary card that can't become a rule",
    () =>
      Effect.gen(function* () {
        const h = harness({ gateReady: true });
        const session = yield* openSession({
          model: gatewayModel,
          outwardGate: "irreversible",
        }).pipe(Effect.provide(h.layer));
        expect(h.calls[0]?.[1]).toMatchObject({
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: "workspace-write",
        });
        h.push(commandRequest(0, "npm install"));
        h.push(commandRequest(1, "git push", { availableDecisions: null }));
        h.push(commandRequest(2, "git push -f"));
        expect(h.responses).toEqual([]);
        const events = yield* drain(session, 4);
        // An allow rule for `git push` would run the forced push the gate still asks about.
        expect(
          events.flatMap((e) =>
            e.type === "request" && e.request.kind === "approval" ? [e.request.scopes] : [],
          ),
        ).toEqual([["once", "always"], ["once", "session"], ["once"]]);
        yield* session.respond(RequestId.make("codex-1"), allowAlways);
        expect(h.responses).toEqual([[1, { decision: "acceptForSession" }]]);
      }),
  );

  it.effect("keeps a request it can't read as one plain command as a card", () =>
    Effect.gen(function* () {
      const h = harness({ gateReady: true });
      const session = yield* openSession(gatedBypass).pipe(Effect.provide(h.layer));
      h.push(commandRequest(0, "cat", { kind: "writeStdin" }));
      h.push(
        commandRequest(1, "curl organization.example.invalid", {
          networkApprovalContext: { host: "x" },
        }),
      );
      h.push(commandRequest(2, "ls", { command: null, commandActions: null }));
      expect(h.responses).toEqual([]);
      const events = yield* drain(session, 4);
      expect(events.filter((e) => e.type === "request")).toHaveLength(3);
    }),
  );

  it.effect("in a sandboxed mode accepts nothing unseen, and still asks once about a push", () =>
    Effect.gen(function* () {
      const h = harness({ gateReady: true });
      const session = yield* openSession({ model: gatewayModel, outwardGate: true }).pipe(
        Effect.provide(h.layer),
      );
      expect(h.calls[0]?.[1]).toMatchObject({
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
      });
      h.push(threadStatus("waitingOnApproval"));
      h.push(commandRequest(0, "npm install"));
      h.push(commandRequest(1, "git push"));
      h.push(patchRequest(2));
      expect(h.responses).toEqual([]);
      const events = yield* drain(session, 4);
      expect(events[0]).toEqual({ type: "status", status: "awaitingApproval" });
      expect(
        events.flatMap((e) =>
          e.type === "request" && e.request.kind === "approval" ? [e.request.scopes] : [],
        ),
      ).toEqual([["once", "always"], ["once"], ["once", "session"]]);
      yield* session.respond(RequestId.make("codex-0"), deny);
      yield* session.respond(RequestId.make("codex-1"), allowOnce);
      expect(h.responses).toEqual([
        [0, { decision: "decline" }],
        [1, { decision: "accept" }],
      ]);
    }),
  );

  it.effect("follows a mode switch at once, and never falls back to never with full access", () =>
    Effect.gen(function* () {
      const h = harness({ gateReady: true });
      const session = yield* openSession({ model: gatewayModel, outwardGate: true }).pipe(
        Effect.provide(h.layer),
      );
      h.push(commandRequest(0, "ls"));
      expect(h.responses).toEqual([]);

      yield* session.setMode("bypassPermissions");
      h.push(commandRequest(1, "ls"));
      expect(h.responses).toEqual([[1, { decision: "accept" }]]);
      yield* session.send({ text: "go" });
      yield* session.setMode("default");
      h.push(commandRequest(2, "ls"));
      expect(h.responses).toHaveLength(1);
      yield* session.send({ text: "carefully" });
      yield* session.setMode("dontAsk");
      yield* session.send({ text: "quietly" });

      const turns = h.calls.filter(([method]) => method === "turn/start").map(([, p]) => p);
      expect(turns[0]).toMatchObject({
        approvalPolicy: "untrusted",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "dangerFullAccess" },
      });
      expect(turns[1]).toMatchObject({
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "workspaceWrite" },
      });
      expect(turns[2]).toMatchObject({
        approvalPolicy: "never",
        sandboxPolicy: { type: "workspaceWrite" },
      });
      for (const [, params] of h.calls) {
        expect(params).not.toMatchObject({ approvalsReviewer: "auto_review" });
        expect(params).not.toMatchObject({
          approvalPolicy: "never",
          sandbox: "danger-full-access",
        });
        expect(params).not.toMatchObject({
          approvalPolicy: "never",
          sandboxPolicy: { type: "dangerFullAccess" },
        });
      }
    }),
  );

  it.effect("leaves an ungated bypass session's requests, scopes and denials as they were", () =>
    Effect.gen(function* () {
      const h = harness({ gateReady: true });
      const session = yield* openSession({
        model: gatewayModel,
        permissionMode: "bypassPermissions",
      }).pipe(Effect.provide(h.layer));
      expect(h.openings).toEqual([["gateway", undefined]]);
      expect(h.calls[0]?.[1]).not.toHaveProperty("approvalsReviewer");
      h.push(commandRequest(0, "git push"));
      expect(yield* drain(session, 1)).toEqual([
        { type: "request", request: expect.objectContaining({ scopes: ["once", "always"] }) },
      ]);
      yield* session.respond(RequestId.make("codex-0"), deny);
      expect(h.responses).toEqual([[0, { decision: "cancel" }]]);
    }),
  );
});

describe("CodexSession connectors", () => {
  it.effect("reports the thread's servers, and applies a toggle by reopening the thread", () =>
    Effect.gen(function* () {
      const h = harness();
      const host = yield* CodexHost.pipe(Effect.provide(h.layer));
      const mcp = { url: "http://127.0.0.1:4317/mcp", headers: { authorization: "Bearer tok" } };
      const open = () => host.open({ threadId: ThreadId.make("t1"), cwd: "/repo", mcp });
      const session = yield* open();
      if (session.connectors === undefined) throw new Error("no connectors");

      const reconnectReason = "Codex reconnects its MCP servers when the thread restarts.";
      expect(yield* session.connectors.status).toEqual([
        { name: "docs", status: "disabled", scope: "user", reconnectUnavailable: reconnectReason },
        {
          name: "gram",
          status: "connected",
          reconnectUnavailable: reconnectReason,
          builtIn: true,
          toggleUnavailable: "Gram's app tools stay on for every thread.",
        },
        {
          name: "sentry",
          status: "failed",
          error: "tools/list timed out",
          reconnectUnavailable: reconnectReason,
        },
        {
          name: "linear",
          status: "needs-auth",
          scope: "user",
          reconnectUnavailable: reconnectReason,
        },
        { name: "slow", status: "pending", scope: "user", reconnectUnavailable: reconnectReason },
      ]);
      expect(h.calls.find(([method]) => method === "mcpServerStatus/list")?.[1]).toEqual({
        threadId: "thr_1",
        detail: "toolsAndAuthOnly",
      });

      expect((yield* Effect.flip(session.connectors.reconnect("sentry"))).message).toBe(
        reconnectReason,
      );
      expect((yield* Effect.flip(session.connectors.setEnabled("gram", false))).message).toBe(
        "Gram's app tools stay on for every thread.",
      );
      expect(yield* session.connectors.setEnabled("docs", true)).toBe("restart");
      expect(yield* session.connectors.setEnabled("sentry", false)).toBe("restart");

      // The runtime reopens the thread; the choice carries over into the thread's config.
      yield* open();
      const starts = h.calls.filter(([method]) => method === "thread/start");
      expect(starts.at(-1)?.[1]).toMatchObject({
        config: {
          mcp_servers: {
            docs: { enabled: true },
            sentry: { enabled: false },
            gram: {
              enabled: true,
              url: "http://127.0.0.1:4317/mcp",
              http_headers: { authorization: "Bearer tok" },
              default_tools_approval_mode: "approve",
            },
          },
        },
      });
    }),
  );
});

const status = (name: string, runtimeStatus: string, pluginId: string | null = null) => ({
  name,
  runtimeStatus,
  toolsError: null,
  pluginId,
});

describe("CodexHost confined sessions", () => {
  it.effect(
    "refuses file-only Dream before launching the fake child or reading native config",
    () =>
      Effect.gen(function* () {
        const h = harness();
        const error = yield* Effect.flip(
          openSession({ dreamFilesOnly: true, confineWrites: true }).pipe(Effect.provide(h.layer)),
        );
        expect(error).toMatchObject({ _tag: "AgentUnavailable", reason: "startup-failed" });
        expect(error.message).toContain("Codex Dream is unavailable");
        expect(error.message).toContain("Choose Claude Code.");
        expect(h.calls).toEqual([]);
      }),
  );

  it.effect("requires a bounded bridge for guided Dream before acquiring the child", () =>
    Effect.gen(function* () {
      const h = harness();
      const error = yield* Effect.flip(
        openSession({ audience: "dream", dreamGuided: true, confineWrites: true }).pipe(
          Effect.provide(h.layer),
        ),
      );
      expect(error.message).toContain("bounded Dream file bridge");
      expect(h.acquired).toEqual([]);
    }),
  );

  it.effect("guided Dream keeps ordinary native approvals and sandbox on start and resume", () =>
    Effect.gen(function* () {
      const h = harness({ statuses: [status("gram", "connected")] });
      const options = {
        audience: "dream",
        dreamGuided: true,
        dreamFilesOnly: false,
        confineWrites: true,
        permissionMode: "acceptEdits",
        instructions: "normal Codex permissions",
        mcp: { url: "http://127.0.0.1:4317/mcp", headers: { authorization: "Bearer synthetic" } },
      } as const;
      yield* openSession(options).pipe(Effect.provide(h.layer));
      yield* openSession({ ...options, resumeId: "thr_1" }).pipe(Effect.provide(h.layer));
      for (const method of ["thread/start", "thread/resume"]) {
        const params = h.calls.find(([name]) => name === method)?.[1];
        expect(params).toMatchObject({
          approvalPolicy: "on-request",
          sandbox: "workspace-write",
          developerInstructions: options.instructions,
          config: {
            features: { plugins: false, apps: false },
            mcp_servers: { gram: { enabled: true, url: options.mcp.url } },
          },
        });
        expect(params).not.toHaveProperty("environments");
      }
    }),
  );

  for (const cliVersion of [null, "0.160.0"] as const)
    it.effect(
      `guided Dream refuses unqualified CLI ${cliVersion} without affecting ordinary sessions`,
      () =>
        Effect.gen(function* () {
          const h = harness({ cliVersion, statuses: [status("gram", "connected")] });
          const error = yield* Effect.flip(
            openSession({
              audience: "dream",
              dreamGuided: true,
              mcp: { url: "http://127.0.0.1:4317/mcp", headers: {} },
            }).pipe(Effect.provide(h.layer)),
          );
          expect(error.message).toContain("Codex Dream is verified");
          expect(h.calls).toEqual([]);
          yield* openSession().pipe(Effect.provide(h.layer));
          expect(h.calls.some(([method]) => method === "thread/start")).toBe(true);
        }),
    );

  const appTools = { url: "http://127.0.0.1:4317/mcp", headers: { authorization: "Bearer tok" } };

  it.effect("switches off every MCP server and app the config names, keeping Gram's", () =>
    Effect.gen(function* () {
      const h = harness({
        statuses: [
          ...["docs", "linear", "files", "team"].map((name) => status(name, "disabled")),
          status("gram", "connected"),
        ],
      });
      yield* openSession({
        confineWrites: true,
        permissionMode: "acceptEdits",
        mcp: appTools,
      }).pipe(Effect.provide(h.layer));
      expect(h.calls[0]).toEqual(["config/read", { includeLayers: false, cwd: "/repo" }]);
      const start = h.calls.find(([method]) => method === "thread/start")?.[1];
      expect(start).toMatchObject({
        config: {
          mcp_servers: {
            docs: { enabled: false },
            linear: { enabled: false },
            files: { enabled: false },
            team: { enabled: false },
            gram: { url: appTools.url },
          },
          apps: { _default: { enabled: false } },
          features: { plugins: false, apps: false },
        },
      });
      expect(h.calls.at(-2)).toEqual([
        "mcpServerStatus/list",
        { threadId: "thr_1", detail: "toolsAndAuthOnly" },
      ]);

      // An unconfined session reads nothing and keeps the user's servers.
      const plain = harness();
      yield* openSession({ permissionMode: "acceptEdits" }).pipe(Effect.provide(plain.layer));
      expect(plain.calls.map(([method]) => method)).toEqual(["thread/start", "skills/list"]);
    }),
  );

  it.effect("keeps a confined dream's app tools reachable, even when the config names them", () =>
    Effect.gen(function* () {
      const h = harness({
        // A stale `gram` table in the user's config must not switch the session's own off.
        config: {
          mcp_servers: {
            gram: { url: "http://stale/mcp", enabled: false },
            docs: { url: "x" },
          },
        },
        statuses: [status("docs", "disabled"), status("gram", "connected")],
      });
      const session = yield* openSession({
        confineWrites: true,
        permissionMode: "acceptEdits",
        mcp: appTools,
      }).pipe(Effect.provide(h.layer));
      const start = h.calls.find(([method]) => method === "thread/start")?.[1] as {
        config: { mcp_servers: Record<string, unknown> };
      };
      expect(start.config.mcp_servers).toEqual({
        docs: { enabled: false },
        gram: {
          enabled: true,
          url: appTools.url,
          http_headers: appTools.headers,
          default_tools_approval_mode: "approve",
        },
      });
      expect(yield* session.connectors!.status).toContainEqual(
        expect.objectContaining({ name: "gram", status: "connected", builtIn: true }),
      );
      expect(
        confinedConfig({ config: { mcp_servers: { gram: {} } } } as never, undefined),
      ).toMatchObject({ mcp_servers: { gram: { enabled: false } } });
    }),
  );

  it.effect("refuses the session when a server Codex couldn't be told about stays on", () =>
    Effect.gen(function* () {
      const h = harness({
        statuses: [status("docs", "disabled"), status("sentry", "connected", "sentry@openai")],
      });
      const error = yield* Effect.flip(
        openSession({ confineWrites: true, mcp: appTools }).pipe(Effect.provide(h.layer)),
      );
      expect(error.message).toContain("Codex kept sentry on");
      // `gram` is someone else's server when the session has no app tools of its own.
      expect(
        unconfinedServers([status("gram", "connected"), status("x", "disabled")] as never, false),
      ).toEqual(["gram"]);
    }),
  );

  it.effect("doesn't let a connector the user switched on back into a confined session", () =>
    Effect.gen(function* () {
      const h = harness({ statuses: [status("docs", "disabled"), status("sentry", "disabled")] });
      const host = yield* CodexHost.pipe(Effect.provide(h.layer));
      const open = (confineWrites: boolean) =>
        host.open({ threadId: ThreadId.make("t1"), cwd: "/repo", confineWrites });
      const session = yield* open(false);
      expect(yield* session.connectors!.setEnabled("docs", true)).toBe("restart");
      expect(yield* session.connectors!.setEnabled("sentry", false)).toBe("restart");
      yield* open(true);
      const starts = h.calls.filter(([method]) => method === "thread/start");
      expect(starts.at(-1)?.[1]).toMatchObject({
        config: { mcp_servers: { docs: { enabled: false }, sentry: { enabled: false } } },
      });
    }),
  );

  it.effect(
    "switches off what a workspace's lists leave out, and a toggle can't bring it back",
    () =>
      Effect.gen(function* () {
        const h = harness({
          config: {
            mcp_servers: {
              gram: { url: "http://stale/mcp" },
              docs: { url: "https://mcp.example.invalid/docs" },
              teams: { url: "https://mcp.example.invalid/teams" },
              sentry: { command: "sentry-mcp" },
            },
          },
          statuses: [status("gram", "connected"), status("docs", "connected")],
        });
        const host = yield* CodexHost.pipe(Effect.provide(h.layer));
        const open = (lists: { mcpAllowlist?: string[]; mcpDenylist?: string[] }) =>
          host.open({ threadId: ThreadId.make("t1"), cwd: "/repo", mcp: appTools, ...lists });
        const mcpServersOf = () =>
          (
            h.calls.findLast(([method]) => method === "thread/start")![1] as {
              config?: { mcp_servers?: Record<string, { enabled?: boolean }> };
            }
          ).config?.mcp_servers;

        const allowed = yield* open({ mcpAllowlist: ["https://mcp.example.invalid/*"] });
        expect(mcpServersOf()).toMatchObject({
          sentry: { enabled: false },
          gram: { enabled: true, url: appTools.url },
        });
        expect(mcpServersOf()).not.toHaveProperty("docs");
        expect(allowed.connectors?.allowlist).toEqual(["https://mcp.example.invalid/*"]);
        expect(yield* allowed.connectors!.setEnabled("sentry", true)).toBe("restart");
        expect(yield* allowed.connectors!.setEnabled("docs", false)).toBe("restart");

        const denied = yield* open({ mcpDenylist: ["teams"] });
        expect(mcpServersOf()).toMatchObject({
          teams: { enabled: false },
          docs: { enabled: false },
          sentry: { enabled: true },
        });
        expect(denied.connectors?.denylist).toEqual(["teams"]);

        yield* open({ mcpDenylist: ["sentry"] });
        expect(mcpServersOf()).toMatchObject({ sentry: { enabled: false } });
        // Without lists nothing is read first.
        const reads = h.calls.filter(([method]) => method === "config/read").length;
        yield* open({});
        expect(h.calls.filter(([method]) => method === "config/read").length).toBe(reads);
        expect(
          leftOutConfig(
            { config: { mcp_servers: { a: { url: "https://x/a" }, b: {} } } } as never,
            { mcpAllowlist: ["https://x/*"] },
            undefined,
          ),
        ).toEqual({ b: { enabled: false } });
      }),
  );

  it.effect("refuses a narrowed session when a named exclusion stays on", () =>
    Effect.gen(function* () {
      const h = harness({
        config: { mcp_servers: { docs: { url: "https://docs.example.invalid/mcp" } } },
        statuses: [status("docs", "connected")],
      });
      const error = yield* Effect.flip(
        openSession({ mcpDenylist: ["docs"] }).pipe(Effect.provide(h.layer)),
      );
      expect(error.message).toContain("leave out docs, and Codex kept it on");
      expect(h.calls.map(([method]) => method)).not.toContain("turn/start");
    }),
  );

  it.effect("refuses a narrowed session when a plugin's server it leaves out stays on", () =>
    Effect.gen(function* () {
      const h = harness({
        config: { mcp_servers: { docs: { url: "https://mcp.example.invalid/docs" } } },
        statuses: [
          status("docs", "disabled"),
          status("gram", "connected"),
          status("sentry", "connected", "sentry@openai"),
        ],
      });
      const host = yield* CodexHost.pipe(Effect.provide(h.layer));
      const open = (lists: { mcpAllowlist?: string[]; mcpDenylist?: string[] }) =>
        host.open({ threadId: ThreadId.make("t1"), cwd: "/repo", mcp: appTools, ...lists });
      const error = yield* Effect.flip(open({ mcpAllowlist: ["https://mcp.example.invalid/*"] }));
      expect(error.message).toContain("leave out sentry, and Codex kept it on");
      // Given by the lists, or only denied elsewhere, it is no reason to refuse.
      yield* open({ mcpAllowlist: ["https://mcp.example.invalid/*", "sentry"] });
      yield* open({ mcpDenylist: ["docs"] });
    }),
  );
});

const listingModel = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  displayName: id,
  description: "",
  hidden: false,
  isDefault: false,
  supportedReasoningEfforts: [],
  ...extra,
});

describe("CodexHost listings", () => {
  it.effect(
    "preserves CLI input modalities through model-list wire schema without inferring entitlement",
    () =>
      Effect.gen(function* () {
        const h = harness({
          modelPages: [
            [
              listingModel("vision", { inputModalities: ["text", "image", "audio"] }),
              listingModel("text", { inputModalities: ["text"] }),
              listingModel("unknown"),
            ],
          ],
        });
        const host = yield* CodexHost.pipe(Effect.provide(h.layer));
        const models = yield* host.listModels();
        const expected = [
          { id: "vision", inputModalities: ["text", "image"] },
          { id: "text", inputModalities: ["text"] },
          { id: "unknown" },
        ];
        expect(models).toMatchObject(expected);
        const encoded = Schema.encodeSync(ModelList)({ models });
        const decoded = Schema.decodeUnknownSync(ModelList)(JSON.parse(JSON.stringify(encoded)));
        expect(decoded.models).toMatchObject(expected);
        expect(decoded.models[2]).not.toHaveProperty("inputModalities");
        expect(
          Schema.decodeUnknownSync(AgentModel)(Schema.encodeSync(AgentModel)(models[0]!)),
        ).toMatchObject(expected[0]!);
        expect(models[2]).not.toHaveProperty("inputModalities");
      }),
  );

  it.effect(
    "refuses bundled models for a signed-out subscription account without looking up gateway credentials",
    () =>
      Effect.gen(function* () {
        const h = harness({ account: "signedOut" });
        const host = yield* CodexHost.pipe(Effect.provide(h.layer));
        const error = yield* Effect.flip(host.listModels());
        expect(error.reason).toBe("not-logged-in");
        expect(error.message).toContain("codex login");
        expect(h.acquired).toEqual(["local"]);
        expect(h.homes).toEqual(["user"]);
        expect(h.calls).toEqual([["account/read", { refreshToken: false }]]);
        expect(yield* host.listModels({ profileId: profile.id })).toHaveLength(1);
        expect(h.calls).toHaveLength(1);
      }),
  );

  it.effect(
    "reads all visible account model pages, preserving the CLI default and deduplicating ids",
    () =>
      Effect.gen(function* () {
        const h = harness({
          modelPages: [
            [listingModel("first"), listingModel("hidden", { hidden: true })],
            [listingModel("account-default", { isDefault: true }), listingModel("first")],
          ],
        });
        const host = yield* CodexHost.pipe(Effect.provide(h.layer));
        const models = yield* host.listModels();
        expect(models.map((m) => m.id)).toEqual(["first", "account-default"]);
        expect(models.find((m) => m.isDefault)?.id).toBe("account-default");
        expect(h.calls).toEqual([
          ["account/read", { refreshToken: false }],
          ["model/list", { includeHidden: false }],
          ["model/list", { includeHidden: false, cursor: "1" }],
        ]);
        expect(h.homes).toEqual(["user"]);
      }),
  );

  it.effect(
    "rejects an incomplete or cyclic catalog instead of silently offering a partial list",
    () =>
      Effect.gen(function* () {
        const pages = [[{ id: "first", displayName: "First", supportedReasoningEfforts: [] }], []];
        const failing = harness({ modelPages: pages, modelListErrorAt: 1 });
        const host = yield* CodexHost.pipe(Effect.provide(failing.layer));
        expect((yield* Effect.flip(host.listModels())).message).toContain(
          "synthetic discovery failure",
        );
        const cyclic = harness({ modelPages: pages, repeatModelCursor: true });
        const other = yield* CodexHost.pipe(Effect.provide(cyclic.layer));
        expect((yield* Effect.flip(other.listModels())).message).toContain("repeated model cursor");
        expect(cyclic.calls.filter(([m]) => m === "model/list")).toHaveLength(2);
      }),
  );

  it.effect("retains the user's explicitly configured API-key or local provider support", () =>
    Effect.gen(function* () {
      for (const account of ["apiKey", "localProvider"] as const) {
        const h = harness({ account });
        const host = yield* CodexHost.pipe(Effect.provide(h.layer));
        expect((yield* host.listModels()).map((m) => m.id)).toEqual(["gpt-6"]);
        expect(h.homes).toEqual(["user"]);
      }
    }),
  );

  it.effect("lists a gateway profile's models, or the catalog without one", () =>
    Effect.gen(function* () {
      const h = harness();
      const host = yield* CodexHost.pipe(Effect.provide(h.layer));
      expect(yield* host.listModels({ profileId: profile.id })).toEqual([
        { id: "gpt-5.5", displayName: "GPT-5.5", supportsEffort: true, efforts: ["low", "high"] },
      ]);
      expect(yield* host.listModels()).toEqual([
        {
          id: "gpt-6",
          displayName: "GPT-6",
          description: "Capable",
          supportsEffort: true,
          efforts: ["low", "high"],
          isDefault: true,
        },
      ]);
    }),
  );

  it.effect("lists the folder's root threads newest first and deletes only those", () =>
    Effect.gen(function* () {
      const h = harness();
      const host = yield* CodexHost.pipe(Effect.provide(h.layer));
      if (host.listSessions === undefined || host.deleteSession === undefined)
        throw new Error("missing");
      expect(yield* host.listSessions({ cwd: "/repo", limit: 5 })).toEqual([
        {
          agentSessionId: "thr_new",
          title: "Named",
          firstPrompt: "prompt thr_new",
          updatedAt: 20_000,
          cwd: "/repo/",
          codexHome: "user",
        },
        {
          agentSessionId: "thr_old",
          title: "prompt thr_old",
          firstPrompt: "prompt thr_old",
          updatedAt: 10_000,
          cwd: "/repo",
          codexHome: "user",
        },
      ]);
      const error = yield* Effect.flip(
        host.deleteSession({ cwd: "/repo", agentSessionId: "thr_elsewhere" }),
      );
      expect(error).toMatchObject({ _tag: "NotFound", entity: "session" });
      yield* host.deleteSession({ cwd: "/repo", agentSessionId: "thr_old" });
      expect(h.calls.filter(([method]) => method === "thread/delete")).toEqual([
        ["thread/delete", { threadId: "thr_old" }],
      ]);
      expect(h.acquired.every((a) => a === "local")).toBe(true);
    }),
  );

  it.effect("follows the home's listing past its first page for a folder's older threads", () =>
    Effect.gen(function* () {
      const h = harness({
        olderThreads: [
          thread("thr_oldest", "/repo", { updatedAt: 1 }),
          thread("thr_far", "/other", { updatedAt: 2 }),
        ],
      });
      const host = yield* CodexHost.pipe(Effect.provide(h.layer));
      const sessions = yield* host.listSessions!({ cwd: "/repo", limit: 5 });
      expect(sessions.map((s) => s.agentSessionId)).toEqual(["thr_new", "thr_old", "thr_oldest"]);
      expect(h.calls.map(([, params]) => params)).toEqual([
        { limit: 50, sortKey: "updated_at", modelProviders: [] },
        { cursor: "older", limit: 50, sortKey: "updated_at", modelProviders: [] },
      ]);
      // Two are enough, so the second page is never asked for.
      const few = harness({ olderThreads: [] });
      const fewHost = yield* CodexHost.pipe(Effect.provide(few.layer));
      yield* fewHost.listSessions!({ cwd: "/repo", limit: 2 });
      expect(few.calls).toHaveLength(1);
    }),
  );

  it.effect("lists sessions from both homes, naming each session's home", () =>
    Effect.gen(function* () {
      const h = harness({ homes: ["user", "gateway"] });
      const host = yield* CodexHost.pipe(Effect.provide(h.layer));
      if (host.listSessions === undefined) throw new Error("missing");
      const sessions = yield* host.listSessions({ cwd: "/repo", limit: 5 });
      expect(sessions.map((s) => [s.agentSessionId, s.codexHome])).toEqual([
        ["thr_new", "user"],
        ["thr_new", "gateway"],
        ["thr_old", "user"],
        ["thr_old", "gateway"],
      ]);
      expect(h.historyHomes).toEqual(["user", "gateway"]);
      expect(h.acquired).toEqual([]);
    }),
  );

  it.effect("starts Codex's own OAuth sign-in, and reloads the servers once it has the token", () =>
    Effect.gen(function* () {
      const h = harness();
      const session = yield* openSession().pipe(Effect.provide(h.layer));
      const authenticate = session.connectors?.authenticate;
      if (authenticate === undefined) throw new Error("no sign-in");

      expect(yield* authenticate("linear")).toEqual({
        authorizationUrl: "https://idp.example/authorize?server=linear",
      });
      expect(h.calls.at(-1)).toEqual([
        "mcpServer/oauth/login",
        { name: "linear", threadId: "thr_1" },
      ]);
      expect((yield* Effect.flip(authenticate("gone"))).message).toBe(
        "Codex couldn't start signing in to gone: No MCP server named 'gone' found.",
      );

      const login = { name: "linear", threadId: "thr_1" };
      h.push({ method: "mcpServer/oauthLogin/completed", params: { ...login, success: true } });
      yield* Effect.yieldNow;
      expect(h.calls.at(-1)).toEqual(["config/mcpServer/reload", undefined]);

      h.push({
        method: "mcpServer/oauthLogin/completed",
        params: { ...login, success: false, error: "access_denied" },
      });
      const events = Array.from(yield* take(session, 4));
      expect(events.at(-1)).toEqual({
        type: "notice",
        level: "warning",
        message: "Signing in to linear didn't finish: access_denied",
      });
    }),
  );

  it.effect(
    "logs an OAuth reload failure and interrupts the next reload when the session closes",
    () =>
      Effect.gen(function* () {
        const logged = yield* Deferred.make<void>();
        const started = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        const messages: Array<unknown> = [];
        const logger = Logger.make(({ message }) => {
          messages.push(message);
          Deferred.doneUnsafe(logged, Effect.void);
        });
        let attempts = 0;
        const h = harness({
          reload: Effect.suspend(() =>
            ++attempts === 1
              ? Effect.fail(
                  new CodexRpcError({
                    method: "config/mcpServer/reload",
                    message: "reload failed",
                  }),
                )
              : Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
                ),
          ),
        });
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        yield* openSession().pipe(
          Effect.provide(h.layer),
          Effect.provideService(Scope.Scope, scope),
          Effect.provide(Logger.layer([logger])),
        );
        const login = {
          method: "mcpServer/oauthLogin/completed" as const,
          params: { name: "linear", threadId: "thr_1", success: true },
        };
        h.push(login);
        yield* Deferred.await(logged);
        expect(messages[0]).toEqual(expect.arrayContaining(["codex oauth reload failed"]));
        h.push(login);
        yield* Deferred.await(started);
        yield* Scope.close(scope, Exit.void);
        expect(Deferred.isDoneUnsafe(interrupted)).toBe(true);
        h.push(login);
        yield* Effect.yieldNow;
        expect(attempts).toBe(2);
        expect(messages).toHaveLength(1);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "persists MCP config and retires future acquisition without live-refreshing held children",
    () =>
      Effect.gen(function* () {
        const h = harness({ alsoRunning: ["gateway", "user"] });
        const host = yield* CodexHost.pipe(Effect.provide(h.layer));
        if (host.mcpConfig === undefined) throw new Error("no config writer");
        const placement = { cwd: "/repo", scope: "user" as const, name: "example" };

        yield* host.mcpConfig.add(placement, {
          type: "http",
          url: "https://organization.example.invalid/example",
          headers: { "X-Api-Key": "abcd" },
        });
        const edit = {
          edits: [
            {
              keyPath: "mcp_servers.example",
              value: {
                url: "https://organization.example.invalid/example",
                http_headers: { "X-Api-Key": "abcd" },
              },
              mergeStrategy: "replace",
            },
          ],
          reloadUserConfig: false,
        };
        expect(h.homes).toEqual(["user"]);
        expect(h.calls).toEqual([["config/batchWrite", edit]]);
        expect(h.otherCalls).toEqual([]);
        expect(h.retires.count).toBe(1);

        yield* host.mcpConfig.remove(placement);
        expect(h.calls.at(-1)?.[1]).toMatchObject({
          edits: [{ keyPath: "mcp_servers.example", value: null }],
        });

        const sse = yield* Effect.flip(
          host.mcpConfig.add(placement, { type: "sse", url: "https://x.example/sse" }),
        );
        expect(sse.message).toBe("Codex connects over streamable HTTP only, not SSE.");
        expect(h.calls).toHaveLength(2);

        // Refusal by an unrelated child is irrelevant: the writer never asks it to reload.
        const held = harness({
          alsoRunning: ["gateway", "user"],
          othersFailWith: "config is read-only",
        });
        const heldHost = yield* CodexHost.pipe(Effect.provide(held.layer));
        yield* heldHost.mcpConfig!.add(placement, { type: "http", url: "https://x.example/mcp" });
        expect(held.calls.map(([method]) => method)).toEqual(["config/batchWrite"]);
        expect(held.otherCalls).toEqual([]);
        expect(held.retires.count).toBe(1);
      }),
  );

  it.effect(
    "lists config.toml's servers without connecting them, and their sign-ins only when asked",
    () =>
      Effect.gen(function* () {
        const h = harness();
        const host = yield* CodexHost.pipe(Effect.provide(h.layer));
        if (host.mcpConfig === undefined) throw new Error("no config reader");

        const quiet = yield* host.mcpConfig.list({ cwd: "/repo", checkSignIn: false });
        expect(h.calls).toEqual([["config/read", { includeLayers: false, cwd: "/repo" }]]);
        expect(quiet).toEqual([
          {
            name: "docs",
            scope: "user",
            transport: "http",
            url: "https://docs.example/mcp",
            carriesValues: false,
            disabled: true,
          },
          {
            name: "linear",
            scope: "user",
            transport: "http",
            url: "https://linear.example/mcp",
            carriesValues: true,
          },
          {
            name: "files",
            scope: "user",
            transport: "stdio",
            command: "npx",
            args: ["-y", "fs"],
            carriesValues: true,
          },
          {
            name: "team",
            scope: "project",
            transport: "http",
            url: "https://team.example/mcp",
            carriesValues: false,
          },
        ]);
        // `config/read` answers with every value; none gets past the host.
        expect(JSON.stringify(quiet)).not.toContain("sekrit");

        // Without a thread this makes Codex start every server, so it takes the user asking.
        const asked = yield* host.mcpConfig.list({ checkSignIn: true });
        expect(h.calls.at(-1)).toEqual(["mcpServerStatus/list", { detail: "toolsAndAuthOnly" }]);
        expect(asked.map((s) => [s.name, s.signedIn])).toEqual([
          ["docs", true],
          ["linear", false],
          ["files", undefined],
          ["team", undefined],
        ]);
      }),
  );

  it.effect("starts a sign-in with no thread, on the user's own app-server", () => {
    const h = harness();
    return Effect.gen(function* () {
      // Inside the layer: the sign-in runs on in the host's scope.
      const host = yield* CodexHost;
      if (host.mcpConfig === undefined) throw new Error("no config reader");

      expect(yield* host.mcpConfig.signIn("linear", undefined)).toEqual({
        authorizationUrl: "https://idp.example/authorize?server=linear",
      });
      expect(h.homes).toEqual(["user"]);
      expect(h.calls).toEqual([["mcpServer/oauth/login", { name: "linear" }]]);
      // The server is held until Codex says the sign-in finished, which `signedIn` then reports.
      expect(h.holds.count).toBe(1);
      const finished = yield* Effect.forkScoped(
        Stream.runCollect(Stream.take(host.mcpConfig.signedIn!, 1)),
      );
      h.push({
        method: "mcpServer/oauthLogin/completed",
        params: { name: "linear", threadId: null, success: true },
      });
      expect(yield* Fiber.join(finished)).toEqual(["linear"]);
      expect(h.holds.count).toBe(0);
      const gone = yield* Effect.flip(host.mcpConfig.signIn("gone", undefined));
      expect(gone.message).toContain("No MCP server named 'gone'");
    }).pipe(Effect.provide(h.layer));
  });
});

// Turns as `thread/turns/list` returned them with `itemsView: "full"` on codex 0.154.0, cut down
// to the fields the transcript reads plus the ones the protocol types require.
const command = (id: string, extra: Record<string, unknown> = {}) => ({
  type: "commandExecution",
  id,
  pluginId: null,
  scriptPath: null,
  command: "/bin/zsh -lc 'pnpm test'",
  cwd: "/repo",
  processId: "1",
  source: "unifiedExecStartup",
  status: "completed",
  commandActions: [{ type: "unknown", command: "pnpm test" }],
  aggregatedOutput: "2 passed\n",
  exitCode: 0,
  durationMs: 12,
  ...extra,
});
const agentMessage = (id: string, text: string) => ({
  type: "agentMessage",
  id,
  text,
  phase: null,
  memoryCitation: null,
  delivery: null,
  questions: null,
});
const userMessage = (id: string, text: string) => ({
  type: "userMessage",
  id,
  clientId: null,
  content: [{ type: "text", text, text_elements: [] }],
});
const storedTurn = (id: string, startedAt: number | null, items: ReadonlyArray<unknown>) => ({
  id,
  items,
  itemsView: "full",
  status: "completed",
  error: null,
  startedAt,
  completedAt: startedAt,
  durationMs: 1,
});

const TURNS = [
  storedTurn("turn_a", 1_790_000_000, [
    userMessage("u1", "Fix the flaky test"),
    { type: "reasoning", id: "r1", summary: ["thinking"], content: [] },
    command("c0", { commandActions: [], command: "ls" }),
    agentMessage("a1", "I'll run the suite."),
    command("c1"),
    {
      type: "fileChange",
      id: "f1",
      status: "completed",
      changes: [
        {
          path: "/repo/a.test.ts",
          kind: { type: "update", move_path: null },
          diff: "@@ -1 +1 @@\n-a\n+b",
        },
      ],
    },
    {
      type: "mcpToolCall",
      id: "m1",
      server: "gram",
      tool: "report",
      status: "completed",
      arguments: { state: "done" },
      appContext: null,
      pluginId: null,
      readOnlyHint: null,
      result: {
        content: [{ type: "text", text: "Reported." }, { type: "image" }],
        structuredContent: null,
        _meta: null,
      },
      error: null,
      durationMs: 3,
    },
    agentMessage("a2", "Fixed and reported."),
  ]),
  storedTurn("turn_b", null, [
    userMessage("u2", "And push it"),
    command("c2", { status: "failed", aggregatedOutput: "remote: denied", exitCode: 1 }),
    command("c3", { status: "declined", aggregatedOutput: null, exitCode: null }),
    { type: "sorcery", id: "x1" },
    agentMessage("a3", "  "),
  ]),
];

describe("toCodexTranscript and CodexHost.readSession", () => {
  it("folds each tool into the agent message before it, names tools as the live transcript does, and skips what it doesn't know", () => {
    expect(toCodexTranscript(TURNS as never)).toEqual([
      { role: "user", text: "Fix the flaky test", at: 1_790_000_000_000 },
      {
        role: "assistant",
        text: "",
        tools: [{ name: "Bash", input: "ls", output: "2 passed" }],
        at: 1_790_000_000_000,
      },
      {
        role: "assistant",
        text: "I'll run the suite.",
        tools: [
          { name: "Bash", input: "pnpm test", output: "2 passed" },
          { name: "Edit", input: expect.stringContaining("/repo/a.test.ts") },
          {
            name: "mcp__gram__report",
            input: '{"state":"done"}',
            output: "Reported.\n[image]",
          },
        ],
        at: 1_790_000_000_000,
      },
      { role: "assistant", text: "Fixed and reported.", at: 1_790_000_000_000 },
      { role: "user", text: "And push it" },
      {
        role: "assistant",
        text: "",
        tools: [
          { name: "Bash", input: "pnpm test", output: "remote: denied\n[exit code 1]" },
          { name: "Bash", input: "pnpm test", output: "Declined" },
        ],
      },
    ]);
  });

  it("cuts a long output to size", () => {
    const big = "x ".repeat(TRANSCRIPT_TOOL_MAX_CHARS);
    const [entry] = toCodexTranscript([
      storedTurn("t", null, [command("c", { aggregatedOutput: big })]),
    ] as never);
    const output = entry!.tools![0]!.output!;
    expect(output.length).toBeLessThan(TRANSCRIPT_TOOL_MAX_CHARS + 80);
    expect(output).toContain(`[truncated: ${big.trim().length} characters in all]`);
  });

  it.effect("reads a thread from whichever home has it, paging through its turns", () =>
    Effect.gen(function* () {
      const h = harness({
        homes: ["user", "gateway"],
        stored: { gateway: { thr_gw: { cwd: "/repo/", pages: [[TURNS[0]], [TURNS[1]]] } } },
      });
      const host = yield* CodexHost.pipe(Effect.provide(h.layer));
      const transcript = yield* host.readSession!({ cwd: "/repo", agentSessionId: "thr_gw" });
      expect(transcript).toMatchObject({ agentSessionId: "thr_gw", cwd: "/repo" });
      expect(transcript.messages).toEqual(toCodexTranscript(TURNS as never));
      expect(h.historyHomes).toEqual(["user", "gateway"]);
      expect(h.calls.filter(([method]) => method === "thread/turns/list")).toEqual([
        [
          "thread/turns/list",
          expect.objectContaining({ cursor: null, sortDirection: "asc", itemsView: "full" }),
        ],
        ["thread/turns/list", expect.objectContaining({ cursor: "1" })],
      ]);

      // `limit` keeps messages from the start, and stops paging once it has them.
      const calls = h.calls.length;
      const head = yield* host.readSession!({ cwd: "/repo", agentSessionId: "thr_gw", limit: 2 });
      expect(head.messages).toEqual(toCodexTranscript(TURNS as never).slice(0, 2));
      expect(
        h.calls.slice(calls).filter(([method]) => method === "thread/turns/list"),
      ).toHaveLength(1);
    }),
  );

  it.effect(
    "answers NotFound for another folder's thread, a subagent's, and an id no home has",
    () =>
      Effect.gen(function* () {
        const h = harness({
          homes: ["user", "gateway"],
          stored: {
            user: {
              thr_other: { cwd: "/other", pages: [[TURNS[0]]] },
              thr_child: { cwd: "/repo", parentThreadId: "thr_new", pages: [[TURNS[0]]] },
            },
          },
        });
        const host = yield* CodexHost.pipe(Effect.provide(h.layer));
        for (const agentSessionId of ["thr_other", "thr_child", "thr_nowhere"]) {
          const error = yield* Effect.flip(host.readSession!({ cwd: "/repo", agentSessionId }));
          expect(error).toMatchObject({ _tag: "NotFound", entity: "session", id: agentSessionId });
        }
        expect(h.calls.some(([method]) => method === "thread/turns/list")).toBe(false);
      }),
  );
});

describe("Codex subscription limits", () => {
  it.effect("reads both windows through the held user app-server without opening a thread", () =>
    Effect.gen(function* () {
      const h = harness({ account: "chatgpt" });
      const host = yield* CodexHost.pipe(Effect.provide(h.layer));
      expect(yield* host.readSubscriptionLimits!).toMatchObject([
        { window: "five_hour", utilization: 0 },
        { window: "seven_day", utilization: 1, status: "rejected" },
      ]);
      expect(h.calls).toEqual([
        ["account/read", { refreshToken: false }],
        ["account/rateLimits/read", undefined],
      ]);
      expect(h.homes).toEqual(["user"]);
      expect(h.holds.count).toBe(0);
    }),
  );
  for (const account of ["signedOut", "apiKey", "localProvider"] as const) {
    it.effect(`leaves subscription limits unavailable for ${account}`, () =>
      Effect.gen(function* () {
        const h = harness({ account });
        const host = yield* CodexHost.pipe(Effect.provide(h.layer));
        expect(yield* host.readSubscriptionLimits!).toEqual([]);
        expect(h.calls).toEqual([["account/read", { refreshToken: false }]]);
        expect(h.holds.count).toBe(0);
      }),
    );
  }
});
