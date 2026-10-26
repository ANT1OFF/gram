import {
  claudeServerEntry,
  describeClaudeEntry,
  type AgentHost,
  type AgentSession,
  type AppTool,
  type OpenSessionOptions,
} from "@gram/agents";
import {
  AgentUnavailable,
  AnswerUndelivered,
  AppToolError,
  InterruptHung,
  ModeRefused,
  type AgentCapabilities,
  type AgentEvent,
  type AgentKind,
  type AgentModel,
  type ConfiguredServer,
  type MessageId,
  type ModelRef,
  type PermissionMode,
  type RequestAnswer,
  type RequestId,
  type GramUIMessageChunk,
  type ThreadId,
  type UserInput,
} from "@gram/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { McpCliShape } from "../connectors/mcp-cli.ts";
import { AgentHosts } from "./agent-hosts.ts";

type InterruptBehavior =
  /** Emits `turnEnd{interrupted}` and `status idle`, like the Claude SDK in the spike. */
  | "complete"
  /** Never returns and never ends the turn (as the Agent SDK can). */
  | "hang"
  | "fail";

/** One opened session, as the test sees it. */
export interface FakeSession {
  /** Everything the runtime opened the session with: `instructions`, `outwardGate`, `audience`, … */
  readonly options: OpenSessionOptions;
  readonly agentSessionId: string;
  readonly sent: Array<UserInput>;
  /** The `messageId` passed with each send, in order. */
  readonly sentIds: Array<string | undefined>;
  readonly steered: Array<UserInput>;
  readonly responses: Array<{ requestId: RequestId; answer: RequestAnswer }>;
  readonly modes: Array<PermissionMode>;
  readonly models: Array<ModelRef>;
  readonly switchStartupAccepts: string[];
  switchStopPrepared: boolean;
  /** `reconnect:<name>`, `enable:<name>:<bool>` and `authenticate:<name>`, in order. */
  readonly connectorCalls: Array<string>;
  /** Each `addDirectories` call's folders. */
  readonly directories: Array<ReadonlyArray<string>>;
  interrupts: number;
  /** How often the tool gate was closed (`closeToolGate`). */
  gateCloses: number;
  /** Tool calls the closed gate refused before they ran, by tool call id. */
  readonly refusedTools: Array<string>;
  /**
   * The tool calls admitted and not finished each time the session was interrupted: an interrupt
   * after the gate closed always finds none.
   */
  readonly runningAtInterrupt: Array<ReadonlyArray<string>>;
  /** How often the runtime asked for the background tasks to be stopped. */
  backgroundStops: number;
  /** The task ids `stopTask` was asked to stop, in order. */
  readonly taskStops: Array<string>;
  /** The session has started closing, which takes `setCloseDelay`'s delay. */
  closing: boolean;
  closed: boolean;
  emit(...events: ReadonlyArray<AgentEvent>): Effect.Effect<void>;
  /** Ends the event stream as an agent process that exits on its own does, after `events`. */
  end(...events: ReadonlyArray<AgentEvent>): Effect.Effect<void>;
  /** A short assistant reply followed by `turnEnd{completed}` and `status idle`. */
  completeTurn(text?: string): Effect.Effect<void>;
  /**
   * Runs one of the thread's app tools as the agent would, looked up for the session's audience,
   * with no approval card and no transcript. It can call back into the runtime, so don't await it
   * from anything that holds the thread's lock.
   */
  callTool(name: string, input: unknown): Effect.Effect<unknown, AppToolError>;
}

export interface FakeAgentControlShape {
  readonly sessions: ReadonlyArray<FakeSession>;
  /** The past session ids `deleteSession` was asked to delete. */
  readonly deletedSessions: ReadonlyArray<string>;
  /** `<agent>:add:<scope>:<name>` and `<agent>:remove:<scope>:<name>` for each host config write. */
  readonly mcpConfigCalls: ReadonlyArray<string>;
  /** The agent of each host MCP config list started, in order. */
  readonly mcpLists: ReadonlyArray<AgentKind>;
  /**
   * `<agent>:<profileId>` (no profile: `<agent>:`) for each host `reloadConfig`, and `<agent>:*`
   * for each `reloadAllConfig`, in order.
   */
  readonly configReloads: ReadonlyArray<string>;
  /** When set, a host's MCP config reads and writes fail with this message, as a config it can't parse. */
  setMcpConfigFailure(message: string | undefined): Effect.Effect<void>;
  /**
   * How long a session's connector status and a host's MCP config list take from now on, like a
   * Claude thread busy connecting its servers or a Codex app-server slow to start.
   */
  setMcpReadDelay(delay: Duration.Input | undefined): Effect.Effect<void>;
  /** The newest session for a thread; dies if there is none. */
  latest(threadId: ThreadId): Effect.Effect<FakeSession>;
  setInterruptBehavior(behavior: InterruptBehavior): Effect.Effect<void>;
  /** How long sessions opened from now on take to close, like an agent process slow to exit. */
  setCloseDelay(delay: Duration.Input | undefined): Effect.Effect<void>;
  /** How long opening takes from now on, like `claude` slow to initialise. */
  setOpenDelay(delay: Duration.Input | undefined): Effect.Effect<void>;
  /** When set, `respond` fails with this message unrecorded, like an agent the answer didn't reach. */
  setRespondFailure(message: string | undefined): Effect.Effect<void>;
  /** When on, `steer` dies instead of recording the input, like an agent that rejected it. */
  setSteerFails(on: boolean): Effect.Effect<void>;
  /**
   * When on, `send` never returns and records nothing, like an agent process killed before it took
   * the input: the window a crash leaves between the runtime's handing it over and the agent's.
   */
  setSendHangs(on: boolean): Effect.Effect<void>;
  /** The `steer` capability sessions opened from now on report; `false` for an agent that can't. */
  setSteerCapability(supported: boolean): Effect.Effect<void>;
  /** Whether sessions opened from now on have a tool gate (`closeToolGate`); Codex has none. */
  setToolGate(supported: boolean): Effect.Effect<void>;
  /** Modes `setMode` refuses from now on, like Claude Code with bypass disabled by policy. */
  setRefusedModes(modes: ReadonlyArray<PermissionMode>): Effect.Effect<void>;
  /** How long `setMode` takes to apply this mode from now on, so a later pick can try to overtake. */
  setModeDelay(mode: PermissionMode, delay: Duration.Input): Effect.Effect<void>;
  /** When set, `open` fails with `AgentUnavailable`. */
  setSwitchStopFailure(message: string | undefined): Effect.Effect<void>;
  setSwitchStopDelay(delay: Duration.Input | undefined): Effect.Effect<void>;
  setModelDiscoveryFailure(message: string | undefined): Effect.Effect<void>;
  setSwitchCapability(supported: boolean): Effect.Effect<void>;
  setNativeGateReady(ready: boolean): Effect.Effect<void>;
  setUnavailable(message: string | undefined): Effect.Effect<void>;
  /**
   * Like `claude --resume`: when on, opening with `resumeId` fails unless that session was sent a
   * message, since only then does a transcript exist.
   */
  setResumeNeedsTranscript(on: boolean): Effect.Effect<void>;
  /** Drops a session's transcript, as when Claude Code cleans up an old one. */
  forgetTranscript(sessionId: string): Effect.Effect<void>;
}

export class FakeAgentControl extends Context.Service<FakeAgentControl, FakeAgentControlShape>()(
  "@gram/server/FakeAgentControl",
) {}

export const FAKE_CAPABILITIES: AgentCapabilities = {
  fork: true,
  rewind: "history",
  steer: true,
  planMode: true,
  approvalScopes: ["once", "session", "always"],
  userQuestions: true,
  costReporting: true,
  perTurnModel: true,
  reasoningEffort: false,
  listSessions: false,
  subagentStreams: false,
  stopTasks: true,
};

/** Obviously fake models, so a picker backed by the fake is neither empty nor mistaken for Claude's. */
const FAKE_MODELS: ReadonlyArray<AgentModel> = [
  { id: "fake-opus", displayName: "Fake Opus (echo)", supportsEffort: false, isDefault: true },
  { id: "fake-haiku", displayName: "Fake Haiku (echo)", supportsEffort: false },
];

export interface FakeAgentOptions {
  /**
   * `echo`: every send completes a turn on its own with "echo: <input>", so the UI and e2e can run
   * without a script. An input containing `/approve` first asks to run a fake Bash command; one
   * containing `/tool` thinks, reads, runs and edits before replying, paced by `toolStepDelay`;
   * `/cd <path>` reports the agent working in `<path>`; and `/call <tool> <json>` runs one of the
   * thread's app tools and replies `echo: <tool> → <JSON result>` or `echo: <tool> → error: <why>`.
   * Absent: sends only report `running`, and tests drive the rest.
   */
  readonly reply?: "echo";
  /** Pause between the steps of a `/tool` turn, so the activity line shows live. */
  readonly toolStepDelay?: Duration.Input;
  /** Servers the fake `claude mcp` added, listed as connected by every session. */
  readonly mcpServers?: FakeMcpServers;
}

/** Server name → scope, shared by `makeFakeMcpCli` and the fake sessions. */
export type FakeMcpServers = Map<string, string>;

/** `claude mcp add-json` / `remove` over `servers`, so the echo fake can add a server and list it. */
export const makeFakeMcpCli = (servers: FakeMcpServers): McpCliShape => {
  const entries = new Map<string, unknown>();
  return {
    configured: () =>
      Effect.sync(() =>
        [...servers].flatMap(([name, scope]) => {
          const description = describeClaudeEntry(entries.get(name));
          return description === undefined ? [] : [{ name, scope, ...description }];
        }),
      ),
    run: (args) =>
      Effect.sync(() => {
        const [, command, ...rest] = args;
        const at = rest.indexOf("--scope");
        const scope = at === -1 ? undefined : rest[at + 1];
        const name = rest.filter((_, i) => at === -1 || (i !== at && i !== at + 1))[0] ?? "";
        if (command === "add-json") {
          if (servers.has(name)) {
            return { status: 1, stdout: "", stderr: `MCP server ${name} already exists` };
          }
          servers.set(name, scope ?? "local");
          entries.set(name, JSON.parse(rest.at(-1) ?? "{}"));
          return {
            status: 0,
            stdout: `Added MCP server ${name} to ${scope ?? "local"} config`,
            stderr: "",
          };
        }
        if (command === "remove") {
          if (!servers.delete(name)) {
            return { status: 1, stdout: "", stderr: `No MCP server found with name: ${name}` };
          }
          return { status: 0, stdout: `Removed MCP server ${name}`, stderr: "" };
        }
        return { status: 1, stdout: "", stderr: `unknown command: ${command}` };
      }),
  };
};

/**
 * Chunks for one assistant reply streamed in two deltas, tagged with fake SDK message ids and, when
 * given, the agent and model a real adapter stamps on its replies, which usage is attributed by.
 */
const replyChunks = (
  text: string,
  said?: { readonly agent: AgentKind; readonly model: string },
): ReadonlyArray<AgentEvent> => {
  const messageId = `reply-${randomUUID()}` as MessageId;
  const half = Math.ceil(text.length / 2);
  return [
    {
      type: "chunk",
      messageId,
      chunk: {
        type: "start",
        messageId,
        messageMetadata: {
          ...said,
          agentMessageIds: [`sdk-${randomUUID()}`, `sdk-${randomUUID()}`],
        },
      },
    },
    { type: "chunk", messageId, chunk: { type: "text-start", id: "t" } },
    {
      type: "chunk",
      messageId,
      chunk: { type: "text-delta", id: "t", delta: text.slice(0, half) },
    },
    { type: "chunk", messageId, chunk: { type: "text-delta", id: "t", delta: text.slice(half) } },
    { type: "chunk", messageId, chunk: { type: "text-end", id: "t" } },
    { type: "chunk", messageId, chunk: { type: "finish" } },
    { type: "usage", tokens: { inputTokens: text.length, outputTokens: text.length }, costUsd: 0 },
    { type: "turnEnd", reason: "completed" },
    { type: "status", status: "idle" },
  ];
};

/** `/call <tool> <json>`; the JSON runs to the end of the input and may be left out for `{}`. */
const CALL = /\/call\s+([\w-]+)(?:\s+([\s\S]+))?/;

/** The steps of a `/tool` turn: think, read, run, edit two files, then reply. */
const toolTurnSteps = (cwd: string, reply: string): ReadonlyArray<ReadonlyArray<AgentEvent>> => {
  const messageId = `tools-${randomUUID()}` as MessageId;
  const chunk = (value: GramUIMessageChunk): AgentEvent => ({
    type: "chunk",
    messageId,
    chunk: value,
  });
  const tool = (toolName: string, input: Record<string, unknown>): ReadonlyArray<AgentEvent> => {
    const toolCallId = `toolu_${randomUUID()}`;
    return [
      chunk({ type: "tool-input-start", toolCallId, toolName, providerExecuted: true }),
      chunk({ type: "tool-input-available", toolCallId, toolName, input, providerExecuted: true }),
      chunk({ type: "tool-output-available", toolCallId, output: "ok", providerExecuted: true }),
    ];
  };
  return [
    [
      chunk({ type: "start", messageId }),
      chunk({ type: "reasoning-start", id: "r" }),
      chunk({ type: "reasoning-delta", id: "r", delta: "Planning the change" }),
      chunk({ type: "reasoning-end", id: "r" }),
    ],
    tool("Read", { file_path: join(cwd, "src", "app.ts") }),
    tool("Bash", { command: "pnpm test", description: "Run the tests" }),
    tool("Edit", { file_path: join(cwd, "src", "app.ts"), old_string: "a", new_string: "b" }),
    [
      ...tool("Edit", {
        file_path: join(cwd, "src", "app.test.ts"),
        old_string: "a",
        new_string: "b",
      }),
      chunk({ type: "finish" }),
    ],
    replyChunks(reply),
  ];
};

/**
 * A scripted `AgentHost` for tests and the headless e2e server. On open it emits `identity` then
 * `status idle`; on send it emits `status running`, then either the echo reply or nothing.
 */
export const makeFakeAgentAdapter = (
  options: FakeAgentOptions = {},
): Layer.Layer<AgentHosts | FakeAgentControl> =>
  Layer.effectContext(
    Effect.sync(() => {
      const sessions: Array<FakeSession> = [];
      const deletedSessions: Array<string> = [];
      let interruptBehavior: InterruptBehavior = "complete";
      let steerFails = false;
      let sendHangs = false;
      let closeDelay: Duration.Input | undefined;
      let mcpReadDelay: Duration.Input | undefined;
      const mcpRead = <A, E>(read: Effect.Effect<A, E>) =>
        Effect.suspend(() =>
          mcpReadDelay === undefined ? read : Effect.sleep(mcpReadDelay).pipe(Effect.andThen(read)),
        );
      let switchStopFailure: string | undefined;
      let switchStopDelay: Duration.Input | undefined;
      let switchCapability = true;
      let nativeGateReady = false;
      let modelDiscoveryFailure: string | undefined;
      const releasedSwitches = new Set<string>();
      const neverStartedSwitches = new Set<string>();
      let openDelay: Duration.Input | undefined;
      let refusedModes: ReadonlyArray<PermissionMode> = [];
      let respondFailure: string | undefined;
      const modeDelays = new Map<PermissionMode, Duration.Input>();
      let steerSupported = true;
      let toolGateSupported = true;
      let unavailable: string | undefined;
      let resumeNeedsTranscript = false;
      /** Session ids that have been sent a message. */
      const transcripts = new Set<string>();
      let replies = 0;

      const open = (openOptions: OpenSessionOptions) =>
        Effect.gen(function* () {
          if (unavailable !== undefined) {
            if (openOptions.switchStartup !== undefined)
              neverStartedSwitches.add(openOptions.switchStartup);
            return yield* new AgentUnavailable({ agent: "claude", message: unavailable });
          }
          if (openDelay !== undefined) yield* Effect.sleep(openDelay);
          const { resumeId } = openOptions;
          if (resumeNeedsTranscript && resumeId !== undefined && !transcripts.has(resumeId)) {
            return yield* new AgentUnavailable({
              agent: "claude",
              reason: "session-not-found",
              message: `No conversation found with session ID: ${resumeId}`,
            });
          }
          const queue = yield* Queue.unbounded<AgentEvent, Cause.Done>();
          const scope = yield* Effect.scope;
          const agentSessionId =
            resumeId !== undefined && openOptions.fork !== true
              ? resumeId
              : (openOptions.sessionId ?? `fake-session-${sessions.length + 1}`);
          // The tool gate, as Claude's adapter keeps it (`makeToolGate`): a call is admitted as its
          // input starts, the provider's `PreToolUse`, and refused there while the gate is closed.
          const admitted = new Set<string>();
          const refused = new Set<string>();
          let gateOpen = true;
          const throughGate = (event: AgentEvent): ReadonlyArray<AgentEvent> => {
            if (event.type === "turnEnd") {
              admitted.clear();
              gateOpen = true;
              return [event];
            }
            if (event.type !== "chunk") return [event];
            const { chunk } = event;
            if (chunk.type === "tool-input-start" || chunk.type === "tool-input-available") {
              if (refused.has(chunk.toolCallId)) return [];
              if (admitted.has(chunk.toolCallId)) return [event];
              if (!gateOpen) {
                refused.add(chunk.toolCallId);
                record.refusedTools.push(chunk.toolCallId);
                return [
                  event,
                  {
                    type: "chunk",
                    messageId: event.messageId,
                    chunk: {
                      type: "tool-output-error",
                      toolCallId: chunk.toolCallId,
                      errorText: "refused: the tool gate is closed",
                    },
                  } as AgentEvent,
                ];
              }
              admitted.add(chunk.toolCallId);
              return [event];
            }
            if (
              chunk.type === "tool-output-error" ||
              (chunk.type === "tool-output-available" && chunk.preliminary !== true)
            ) {
              if (refused.has(chunk.toolCallId)) return [];
              admitted.delete(chunk.toolCallId);
            }
            return [event];
          };
          const emit = (...events: ReadonlyArray<AgentEvent>) =>
            Effect.forEach(
              events.flatMap((event) => throughGate(event)),
              (event) => Queue.offer(queue, event),
              { discard: true },
            );
          /** What an echo turn does once its approval is answered, by request id. */
          const awaiting = new Map<RequestId, (allowed: boolean) => Effect.Effect<void>>();
          /** Bumped by an interrupt, so a `/call` still running doesn't reply into a later turn. */
          let turnGeneration = 0;

          /**
           * Looked up per call, so a tool registered after the session opened is found. `gated` is
           * the binding Claude's adapter serves, whose `run` raises the registry's cards.
           */
          const findTool = (name: string, gated: boolean): AppTool | undefined => {
            const { appTools: registry, threadId, audience } = openOptions;
            const tools =
              registry === undefined
                ? []
                : gated
                  ? registry.forSession(threadId, audience)
                  : registry.forThread(threadId, audience);
            return tools.find((t) => t.descriptor.name === name);
          };
          const runTool = (name: string, input: unknown, gated: boolean) =>
            Effect.suspend(() => {
              const tool = findTool(name, gated);
              return tool === undefined
                ? Effect.fail(new AppToolError({ tool: name, message: `unknown tool ${name}` }))
                : tool.run(input);
            });
          const callTool = (name: string, input: unknown) => runTool(name, input, false);

          /** Servers the session reconnected, which it lists from then on. */
          const reconnected = new Set<string>();
          const record: FakeSession = {
            options: openOptions,
            agentSessionId,
            sent: [],
            sentIds: [],
            steered: [],
            responses: [],
            modes: [],
            models: [],
            switchStartupAccepts: [],
            switchStopPrepared: false,
            connectorCalls: [],
            directories: [],
            interrupts: 0,
            gateCloses: 0,
            refusedTools: [],
            runningAtInterrupt: [],
            backgroundStops: 0,
            taskStops: [],
            closing: false,
            closed: false,
            emit,
            end: (...events) => emit(...events).pipe(Effect.andThen(Queue.end(queue))),
            callTool,
            completeTurn: (text = "done") => {
              const messageId = `reply-${++replies}` as MessageId;
              return emit(
                {
                  type: "chunk",
                  messageId,
                  chunk: {
                    type: "start",
                    messageId,
                    messageMetadata: { agentMessageIds: [`sdk-${messageId}`] },
                  },
                },
                { type: "chunk", messageId, chunk: { type: "text-start", id: "t" } },
                { type: "chunk", messageId, chunk: { type: "text-delta", id: "t", delta: text } },
                { type: "chunk", messageId, chunk: { type: "text-end", id: "t" } },
                { type: "chunk", messageId, chunk: { type: "finish" } },
                { type: "turnEnd", reason: "completed" },
                { type: "status", status: "idle" },
              );
            },
          };
          sessions.push(record);

          const closeAfter = closeDelay;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              record.closing = true;
            }).pipe(
              Effect.andThen(closeAfter === undefined ? Effect.void : Effect.sleep(closeAfter)),
              Effect.andThen(
                Effect.sync(() => {
                  record.closed = true;
                  if (openOptions.switchStartup !== undefined)
                    releasedSwitches.add(openOptions.switchStartup);
                }),
              ),
              Effect.andThen(Queue.end(queue)),
            ),
          );
          yield* emit(
            { type: "identity", agentSessionId, model: "fake", tools: [], commands: [] },
            { type: "status", status: "idle" },
          );

          /**
           * A `/call` turn. Everything that touches the tool is forked into the session's scope:
           * `send` and `respond` run under the runtime's per-thread lock, and an app tool may call
           * back into the runtime (`set_title`, a message to this thread or another), which would
           * wait on that lock forever if `send` waited on the tool.
           */
          const callTurn = (name: string, json: string | undefined) => {
            const generation = turnGeneration;
            const finish = (outcome: string) =>
              Effect.suspend(() =>
                generation === turnGeneration
                  ? emit(...replyChunks(`echo: ${name} → ${outcome}`))
                  : Effect.void,
              );
            // As Claude's adapter does, the host raises no card: the tool's gate does.
            return Effect.gen(function* () {
              const input = yield* Effect.try((): unknown =>
                json === undefined ? {} : JSON.parse(json),
              ).pipe(Effect.orElseSucceed(() => undefined));
              if (input === undefined) return yield* finish("error: the input isn't JSON");
              yield* runTool(name, input, true).pipe(
                Effect.map((output) => JSON.stringify(output ?? null)),
                Effect.catchTag("AppToolError", (error) =>
                  Effect.succeed(`error: ${error.message}`),
                ),
                Effect.catchCause((cause) => Effect.succeed(`error: ${Cause.pretty(cause)}`)),
                Effect.flatMap(finish),
              );
            }).pipe(Effect.forkIn(scope), Effect.asVoid);
          };

          /** As a real adapter names its replies: the session's agent and its latest model. */
          const said = () => ({
            agent: openOptions.model?.agent ?? "claude",
            model: record.models.at(-1)?.model ?? openOptions.model?.model ?? FAKE_MODELS[0]!.id,
          });
          const echo = (input: UserInput) =>
            Effect.suspend(() => {
              const reply = `echo: ${input.text}`;
              const call = CALL.exec(input.text);
              if (call !== null) return callTurn(call[1]!, call[2]?.trim());
              const cd = /\/cd\s+(\S+)/.exec(input.text)?.[1];
              if (cd !== undefined)
                return emit({ type: "cwd", cwd: cd }, ...replyChunks(reply, said()));
              if (input.text.includes("/tool")) {
                // Forked into the session's scope: `send` runs under the runtime lock, and a paced
                // script held there would deliver every step at once.
                return Effect.forEach(
                  toolTurnSteps(openOptions.cwd, reply),
                  (step) =>
                    emit(...step).pipe(
                      Effect.andThen(Effect.sleep(options.toolStepDelay ?? "600 millis")),
                    ),
                  { discard: true },
                ).pipe(Effect.forkIn(scope), Effect.asVoid);
              }
              if (!input.text.includes("/approve")) return emit(...replyChunks(reply, said()));
              const requestId = randomUUID() as RequestId;
              awaiting.set(requestId, (allowed) =>
                emit(...replyChunks(allowed ? reply : "echo: denied", said())),
              );
              return emit(
                {
                  type: "request",
                  request: {
                    kind: "approval",
                    id: requestId,
                    toolName: "Bash",
                    displayName: "Bash",
                    input: { command: "echo approved", description: "A fake command" },
                    suggestions: [],
                  },
                },
                { type: "status", status: "awaitingApproval" },
              );
            });

          const session: AgentSession = {
            prepareForSwitch: Effect.sync(() => {
              record.switchStopPrepared = true;
            }),
            stopForSwitch: Effect.gen(function* () {
              if (switchStopFailure !== undefined)
                return yield* new AgentUnavailable({
                  agent: openOptions.model?.agent ?? "claude",
                  message: switchStopFailure,
                });
              if (switchStopDelay !== undefined) yield* Effect.sleep(switchStopDelay);
              record.closed = true;
              yield* Queue.end(queue);
            }),
            acceptSwitchStartup: (attemptId) =>
              attemptId === openOptions.switchStartup && !record.closed
                ? Effect.sync(() => {
                    record.switchStartupAccepts.push(attemptId);
                  })
                : Effect.fail(
                    new AgentUnavailable({
                      agent: openOptions.model?.agent ?? "claude",
                      message: "stale switch startup",
                    }),
                  ),
            events: Stream.fromQueue(queue),
            send: (input, sendOptions) =>
              Effect.suspend(() =>
                sendHangs
                  ? Effect.never
                  : Effect.sync(() => {
                      record.sent.push(input);
                      record.sentIds.push(sendOptions?.messageId);
                      transcripts.add(agentSessionId);
                    }),
              ).pipe(
                Effect.andThen(emit({ type: "status", status: "running" })),
                Effect.andThen(options.reply === "echo" ? echo(input) : Effect.void),
              ),
            steer: (input) =>
              Effect.suspend(() =>
                steerFails
                  ? Effect.die(new Error("the agent rejected the steer"))
                  : Effect.sync(() => void record.steered.push(input)),
              ),
            stopBackgroundTasks: Effect.sync(() => {
              record.backgroundStops++;
              return 1;
            }),
            stopTask: (taskId) =>
              Effect.sync(() => {
                record.taskStops.push(taskId);
                return true;
              }),
            ...(!toolGateSupported
              ? {}
              : {
                  closeToolGate: Effect.sync(() => {
                    record.gateCloses++;
                    gateOpen = false;
                  }),
                }),
            interrupt: Effect.suspend(() => {
              record.interrupts++;
              record.runningAtInterrupt.push([...admitted]);
              // An interrupted `/approve` or `/call` turn is over; a late answer or a tool still
              // running mustn't resume it.
              awaiting.clear();
              turnGeneration++;
              switch (interruptBehavior) {
                case "complete":
                  return emit(
                    { type: "turnEnd", reason: "interrupted" },
                    { type: "status", status: "idle" },
                  );
                case "hang":
                  return Effect.never;
                case "fail":
                  return Effect.fail(new InterruptHung({ timeoutMs: 0 }));
              }
            }),
            respond: (requestId, answer) =>
              Effect.suspend(() => {
                if (respondFailure !== undefined) {
                  return Effect.fail(new AnswerUndelivered({ message: respondFailure }));
                }
                record.responses.push({ requestId, answer });
                const resume = awaiting.get(requestId);
                if (resume === undefined) return Effect.void;
                awaiting.delete(requestId);
                return emit(
                  { type: "requestResolved", requestId },
                  { type: "status", status: "running" },
                ).pipe(
                  Effect.andThen(resume(answer.kind === "approval" && answer.decision === "allow")),
                );
              }),
            setMode: (mode) =>
              refusedModes.includes(mode)
                ? Effect.fail(new ModeRefused({ mode, message: `${mode} is disabled` }))
                : Effect.sleep(modeDelays.get(mode) ?? 0).pipe(
                    Effect.andThen(Effect.sync(() => void record.modes.push(mode))),
                  ),
            setModel: (model) => Effect.sync(() => void record.models.push(model)),
            // A model only a fresh process can run, as Claude's across the EU data-zone boundary.
            needsReopenFor: (model) => model.startsWith("reopen:"),
            connectors: {
              status: mcpRead(
                Effect.sync(() => {
                  const listed = [
                    { name: "github", status: "connected" as const, scope: "user" },
                    // A gateway profile's key keeps claude.ai connectors out, as Claude Code does.
                    ...(openOptions.model?.profileId === undefined
                      ? [
                          {
                            name: "linear",
                            status: "needs-auth" as const,
                            scope: "claudeai",
                            url: "https://mcp.linear.app/mcp",
                            claudeAi: { id: "mcpsrv_linear" },
                          },
                        ]
                      : []),
                    ...[...(options.mcpServers ?? [])].map(([name, mcpScope]) => ({
                      name,
                      status: "connected" as const,
                      scope: mcpScope,
                    })),
                  ];
                  return [
                    ...listed,
                    ...[...reconnected]
                      .filter((name) => !listed.some((server) => server.name === name))
                      .map((name) => ({ name, status: "connected" as const, scope: "user" })),
                  ];
                }).pipe(
                  Effect.tap((connectors) =>
                    Effect.sync(() =>
                      openOptions.onConnectorsSeen?.({ detailed: true, whole: true, connectors }),
                    ),
                  ),
                ),
              ),
              // Claude Code reads the server's entry again, so one added since comes up listed.
              reconnect: (name) =>
                Effect.sync(() => {
                  record.connectorCalls.push(`reconnect:${name}`);
                  reconnected.add(name);
                }),
              setEnabled: (name, enabled) =>
                Effect.sync(() => {
                  record.connectorCalls.push(`enable:${name}:${enabled}`);
                  return "applied" as const;
                }),
              authenticate: (name) =>
                Effect.sync(() => {
                  record.connectorCalls.push(`authenticate:${name}`);
                  return { authorizationUrl: `https://idp.example/authorize?server=${name}` };
                }),
              // As Claude's on a gateway profile, whose key keeps claude.ai connectors out.
              ...(openOptions.model?.profileId === undefined
                ? {}
                : { claudeAiUnavailable: "claude.ai connectors need your Claude sign-in." }),
            },
            addDirectories: (paths) =>
              Effect.sync(() => {
                record.directories.push(paths);
                return true;
              }),
          };
          return session;
        });

      const mcpConfigCalls: Array<string> = [];
      const mcpLists: Array<AgentKind> = [];
      const configReloads: Array<string> = [];
      let mcpConfigFailure: string | undefined;
      /** Per agent, the servers its fake config holds; a sign-in from Settings marks one signed in. */
      const configured = new Map<AgentKind, Map<string, ConfiguredServer>>();
      /** Per agent, the reader of its `mcpConfig.signedIn`, which hears each sign-in from Settings. */
      const signInReaders = new Map<AgentKind, (name: string) => void>();
      const configOf = (agent: AgentKind) => {
        const held = configured.get(agent) ?? new Map<string, ConfiguredServer>();
        configured.set(agent, held);
        return held;
      };
      const writeMcpConfig = (agent: AgentKind, call: string, change: () => void) =>
        Effect.suspend(() => {
          if (mcpConfigFailure !== undefined) {
            return Effect.fail(new AgentUnavailable({ agent, message: mcpConfigFailure }));
          }
          mcpConfigCalls.push(call);
          change();
          return Effect.void;
        });

      const host = (kind: AgentKind): AgentHost => ({
        kind,
        nativeGateReady: Effect.sync(() => nativeGateReady),
        supportsWorkspaceSwitch: switchCapability,
        checkWorkspaceSwitch: Effect.suspend(() =>
          modelDiscoveryFailure === undefined
            ? Effect.void
            : Effect.fail(
                new AgentUnavailable({
                  agent: kind,
                  reason: "not-logged-in",
                  message: modelDiscoveryFailure,
                }),
              ),
        ),
        switchAttemptReceipt: (id) =>
          Effect.sync(() =>
            releasedSwitches.has(id)
              ? "exited"
              : neverStartedSwitches.has(id)
                ? "notStarted"
                : undefined,
          ),
        switchAttemptReleased: (id) =>
          Effect.sync(() => releasedSwitches.has(id) || neverStartedSwitches.has(id)),
        capabilities: { ...FAKE_CAPABILITIES, steer: steerSupported },
        open,
        listModels: () =>
          modelDiscoveryFailure === undefined
            ? Effect.succeed([...FAKE_MODELS])
            : Effect.fail(
                new AgentUnavailable({
                  agent: kind,
                  reason: "not-logged-in",
                  message: modelDiscoveryFailure,
                }),
              ),
        deleteSession: ({ agentSessionId }) =>
          Effect.sync(() => void deletedSessions.push(agentSessionId)),
        reloadConfig: (profileId) =>
          Effect.sync(() => void configReloads.push(`${kind}:${profileId ?? ""}`)),
        // Claude keeps no shared server, so only the others have it, as the real hosts do.
        ...(kind === "claude"
          ? {}
          : { reloadAllConfig: Effect.sync(() => void configReloads.push(`${kind}:*`)) }),
        mcpConfig: {
          add: ({ scope, name }, config) =>
            writeMcpConfig(kind, `${kind}:add:${scope}:${name}`, () => {
              const description = describeClaudeEntry(claudeServerEntry(config));
              if (description === undefined) return;
              configOf(kind).set(name, {
                name,
                scope,
                ...description,
                ...(description.url === undefined ? {} : { signedIn: false }),
              });
            }),
          remove: ({ scope, name }) =>
            writeMcpConfig(
              kind,
              `${kind}:remove:${scope}:${name}`,
              () => void configOf(kind).delete(name),
            ),
          list: () =>
            Effect.sync(() => void mcpLists.push(kind)).pipe(
              Effect.andThen(
                mcpRead(
                  Effect.suspend(() =>
                    mcpConfigFailure === undefined
                      ? Effect.succeed([...configOf(kind).values()])
                      : Effect.fail(
                          new AgentUnavailable({ agent: kind, message: mcpConfigFailure }),
                        ),
                  ),
                ),
              ),
            ),
          signIn: (name) =>
            Effect.suspend(() => {
              const server = configOf(kind).get(name);
              if (server === undefined) {
                return Effect.fail(
                  new AgentUnavailable({ agent: kind, message: `No MCP server named ${name}.` }),
                );
              }
              mcpConfigCalls.push(`${kind}:signIn:${name}`);
              configOf(kind).set(name, { ...server, signedIn: true });
              signInReaders.get(kind)?.(name);
              return Effect.succeed("started" as const);
            }),
          signedIn: Stream.callback<string>((queue) =>
            Effect.acquireRelease(
              Effect.sync(() => signInReaders.set(kind, (name) => Queue.offerUnsafe(queue, name))),
              () => Effect.sync(() => signInReaders.delete(kind)),
            ),
          ),
        },
      });

      const control: FakeAgentControlShape = {
        sessions,
        deletedSessions,
        mcpConfigCalls,
        mcpLists,
        configReloads,
        setMcpConfigFailure: (message) =>
          Effect.sync(() => {
            mcpConfigFailure = message;
          }),
        setMcpReadDelay: (delay) =>
          Effect.sync(() => {
            mcpReadDelay = delay;
          }),
        latest: (threadId) =>
          Effect.suspend(() => {
            const found = sessions.findLast((s) => s.options.threadId === threadId);
            return found === undefined
              ? Effect.die(`no fake session for thread ${threadId}`)
              : Effect.succeed(found);
          }),
        setInterruptBehavior: (behavior) =>
          Effect.sync(() => {
            interruptBehavior = behavior;
          }),
        setCloseDelay: (delay) =>
          Effect.sync(() => {
            closeDelay = delay;
          }),
        setOpenDelay: (delay) =>
          Effect.sync(() => {
            openDelay = delay;
          }),
        setModeDelay: (mode, delay) =>
          Effect.sync(() => {
            modeDelays.set(mode, delay);
          }),
        setRespondFailure: (message) =>
          Effect.sync(() => {
            respondFailure = message;
          }),
        setRefusedModes: (modes) =>
          Effect.sync(() => {
            refusedModes = modes;
          }),
        setSteerFails: (on) =>
          Effect.sync(() => {
            steerFails = on;
          }),
        setSendHangs: (on) =>
          Effect.sync(() => {
            sendHangs = on;
          }),
        setToolGate: (supported) =>
          Effect.sync(() => {
            toolGateSupported = supported;
          }),
        setSteerCapability: (supported) =>
          Effect.sync(() => {
            steerSupported = supported;
          }),
        setModelDiscoveryFailure: (message) =>
          Effect.sync(() => {
            modelDiscoveryFailure = message;
          }),
        setNativeGateReady: (ready) =>
          Effect.sync(() => {
            nativeGateReady = ready;
          }),
        setSwitchCapability: (supported) =>
          Effect.sync(() => {
            switchCapability = supported;
          }),
        setSwitchStopFailure: (message) =>
          Effect.sync(() => {
            switchStopFailure = message;
          }),
        setSwitchStopDelay: (delay) =>
          Effect.sync(() => {
            switchStopDelay = delay;
          }),
        setUnavailable: (message) =>
          Effect.sync(() => {
            unavailable = message;
          }),
        setResumeNeedsTranscript: (on) =>
          Effect.sync(() => {
            resumeNeedsTranscript = on;
          }),
        forgetTranscript: (sessionId) =>
          Effect.sync(() => {
            transcripts.delete(sessionId);
          }),
      };

      return Context.make(
        AgentHosts,
        AgentHosts.of({ get: (kind) => Effect.succeed(host(kind)) }),
      ).pipe(Context.add(FakeAgentControl, control));
    }),
  );

/** The scripted fake: sends report `running` and tests drive the rest of the turn. */
export const FakeAgentAdapter: Layer.Layer<AgentHosts | FakeAgentControl> = makeFakeAgentAdapter();
