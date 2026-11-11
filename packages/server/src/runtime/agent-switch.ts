// Moving any thread to the other agent: the checks a target has to pass, the refusals of a thread
// that can't move now, and the switch itself, which claims the thread, stops its session, opens one
// on the target with no memory of the old one, marks the transcript and lets the queue go.

import {
  aboveHigh,
  effectiveCheckout,
  InvalidState,
  isLocalHost,
  redactText,
  type AgentKind,
  type GitState,
  type GramUIMessage,
  type Handoff,
  type HandoffNote,
  type ModelRef,
  type PermissionMode,
  type SwitchNoteMode,
  type Thread,
  type ThreadId,
  type ThreadNotFound,
  type TurnId,
  type UserInput,
} from "@gram/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberMap from "effect/FiberMap";
import * as Option from "effect/Option";
import { randomUUID } from "node:crypto";
import type { AgentHosts } from "./agent-hosts.ts";
import { selectableModels } from "./model-efforts.ts";
import type { SeqMessage, ThreadStoreShape } from "../persistence/thread-store.ts";
import { locked, type GetRuntime, type Runtime } from "./runtime-state.ts";
import type { ObservedTurnEnd } from "./runtime-observer.ts";
import type { SystemDeliveryFailure } from "./system-delivery.ts";
import type { ThreadRuntimesShape } from "./thread-runtimes-shape.ts";
import { sessionIdentity } from "./session-switch.ts";
import type { EventHub } from "../events/event-hub.ts";
import { fromStoredMessages } from "../orchestration/transcripts.ts";
import {
  capNote,
  notePrompt,
  renderFacts,
  renderHandoff,
  renderRecentTurns,
  turnsBudgetTokens,
} from "./switch-handoff.ts";

/** What the user calls each agent. */
export const AGENT_NAMES: Readonly<Record<AgentKind, string>> = {
  claude: "Claude Code",
  codex: "Codex",
};

/**
 * Whether `target` can take over `thread`'s session: a build that can stop and start one cleanly,
 * the CLI's own sign-in, a mode it keeps, a model and effort its CLI lists, and a sign-in it
 * re-checks now. Shared by the orchestrator's switch and any thread's. Returns nothing; each
 * refusal is an `InvalidState` the user reads.
 */
export const checkSwitchTarget = (
  store: Pick<ThreadStoreShape, "listProfiles" | "getSettings">,
  hosts: AgentHosts["Service"],
  thread: Pick<Thread, "model" | "mode">,
  target: ModelRef,
) =>
  Effect.gen(function* () {
    const name = AGENT_NAMES[target.agent];
    const sourceHost = yield* hosts
      .get(thread.model.agent)
      .pipe(Effect.mapError((e) => new InvalidState({ message: e.message })));
    const targetHost = yield* hosts
      .get(target.agent)
      .pipe(Effect.mapError((e) => new InvalidState({ message: e.message })));
    if (!sourceHost.supportsWorkspaceSwitch || !targetHost.supportsWorkspaceSwitch)
      return yield* new InvalidState({
        message:
          "Switching an existing session is unavailable on this platform or harness build. Windows cannot currently guarantee a graceful stop. Your current session and preferences have not changed.",
      });
    if (target.profileId !== undefined)
      return yield* new InvalidState({
        message:
          "Choose the installed CLI's subscription login for this switch. Switching does not migrate gateway credentials or accounts.",
      });
    if (thread.model.profileId !== undefined)
      return yield* new InvalidState({
        message: "Switching uses the CLI's own sign-in; it doesn't move gateway accounts.",
      });
    // The user's ceiling for a switch, whatever the model lists.
    if (target.variant !== undefined && aboveHigh(target.variant))
      return yield* new InvalidState({
        message: "A switch runs at High effort at most. Pick High or lower.",
      });
    if (thread.mode === "plan" && !targetHost.capabilities.planMode)
      return yield* new InvalidState({
        message:
          "The selected harness cannot preserve this session's Plan mode. Finish the plan in the current session before switching.",
      });
    const models = yield* selectableModels(store, hosts, target.agent, undefined).pipe(
      Effect.mapError((e) => new InvalidState({ message: e.message })),
    );
    const selected = models.find(
      (model) => model.id === target.model || model.resolvedId === target.model,
    );
    if (selected === undefined)
      return yield* new InvalidState({
        message: `The installed ${name} CLI does not list ${target.model}. Select a listed model, or add that exact custom ID in Settings → Agents first. No model was substituted.`,
      });
    if (target.variant !== undefined && !selected.efforts.includes(target.variant))
      return yield* new InvalidState({
        message:
          "The selected model does not support that effort. Choose one offered by its model picker.",
      });
    if (target.speed === "fast" && !selected.speeds.includes("fast"))
      return yield* new InvalidState({
        message:
          "The selected model does not support that speed. Choose one offered by its model picker.",
      });
    if (targetHost.checkWorkspaceSwitch === undefined)
      return yield* new InvalidState({
        message:
          "This harness build cannot re-check sign-in before stopping the current session. Update or recover the current session before trying the switch.",
      });
    // The CLI's own sign-in check, as the launch checks run it; never its credential files.
    yield* targetHost.checkWorkspaceSwitch.pipe(
      Effect.mapError((e) => new InvalidState({ message: e.message })),
    );
  });

/**
 * Why `thread`, as its runtime stands, can't move to `target` now, in the words the user reads; or
 * `undefined`. Holds the lock: the turn, requests and background work it reads are the runtime's.
 */
const notNow = (
  rt: Runtime,
  thread: Thread,
  target: ModelRef,
  requests: number,
): string | undefined => {
  const from = AGENT_NAMES[thread.model.agent];
  const to = AGENT_NAMES[target.agent];
  if (target.agent === thread.model.agent)
    return `This thread already runs in ${to}. Pick one of its models instead.`;
  if (thread.role === "orchestrator")
    return "Switch the orchestrator from its own Switch orchestrator… action.";
  if (rt.closing || thread.parked) return "Unarchive this thread before switching it.";
  // A thread whose last turn failed moves too: that is limit mode, with no note turn.
  if (
    rt.turn !== undefined ||
    rt.reopening ||
    (rt.status !== "idle" && rt.status !== "cold" && rt.status !== "error")
  )
    return "Wait for this turn to finish, or stop it, then switch.";
  if (requests > 0) return `Answer the open approval first. It can't move to ${to}.`;
  if (rt.background.length > 0 || rt.activity.subagentsRunning)
    return `${from} still has background work running.`;
  if (!isLocalHost(effectiveCheckout(thread)))
    return `${to} can't run on this thread's machine yet.`;
  // A fork with no session of its own reopens by forking its source, which is the old agent's.
  if (
    thread.forkedFrom !== undefined &&
    (thread.agentSessionId === undefined || thread.agentSessionUnused === true)
  )
    return "Send once in this fork first.";
  if (rt.reserved) return "This thread's worktree is in use. Try again in a moment.";
  return undefined;
};

/** The keys of a switch's own deliveries: the old session's note turn and the new one's handoff. */
const NOTE_KEY = "switch-note";
const HANDOFF_KEY = "switch-handoff";

/** What a switch of any thread reads and changes. */
export interface AgentSwitchDeps {
  readonly store: ThreadStoreShape;
  readonly hosts: AgentHosts["Service"];
  readonly hub: EventHub["Service"];
  readonly getRuntime: GetRuntime;
  readonly switches: FiberMap.FiberMap<ThreadId>;
  readonly refuseMissingFolder: (rt: Runtime) => Effect.Effect<void, InvalidState | ThreadNotFound>;
  readonly runtimes: Pick<
    ThreadRuntimesShape,
    | "claimSessionSwitch"
    | "switchSession"
    | "cancelSessionSwitch"
    | "releaseSwitch"
    | "emitChunk"
    | "updateDataPart"
    | "updateThread"
    | "requestSystemDelivery"
  >;
  /** Lets the queue the switch held go to the new session. */
  readonly afterRelease: (rt: Runtime) => Effect.Effect<void>;
  /**
   * Epoch ms the thread's account is out of usage until, by the agent's own usage-limit reports
   * (`LimitResume`); `undefined` when none says so. Never read from credentials.
   */
  readonly limitedUntil: (thread: Thread) => Effect.Effect<number | undefined>;
  /** Ends a limit wait the old account left, so nothing resumes the old turn on the new agent. */
  readonly endLimitWait: (rt: Runtime) => Effect.Effect<void>;
  /** A checkout's branch, HEAD and changes, as git reports them here or on its machine. */
  readonly gitState: (cwd: string) => Effect.Effect<GitState, unknown>;
}

/** How a switch's turn of Gram's own ended: the turn's end, or the delivery's failure. */
type Outcome =
  | { readonly end: ObservedTurnEnd; readonly turnId: TurnId }
  | { readonly failed: SystemDeliveryFailure };

/** A turn's reply as plain text: its main lane's text parts, in order. */
const replyOf = (messages: ReadonlyArray<GramUIMessage>): string =>
  messages
    .filter(
      (message) => message.role === "assistant" && message.metadata?.parentToolUseId === undefined,
    )
    .flatMap((message) =>
      message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    )
    .join("\n\n");

/** How far back a switch's own turn is looked for: its prompt and its reply are the newest. */
const OWN_TURN_LOOKBACK = 40;

/** A reset time for the model, unambiguous: 24-hour UTC. */
const utc = (at: number): string =>
  `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/**
 * How `thread`'s switch writes its note, and in limit mode why: out of usage by the agent's own
 * report, or its last turn failed. Otherwise the old session's last turn, unless the user left
 * the note out.
 */
const noteModeOf = (
  rt: Runtime,
  thread: Thread,
  until: number | undefined,
  wanted: boolean,
): { readonly mode: SwitchNoteMode; readonly why?: string } => {
  const wait = thread.limitWait;
  const waitUntil =
    wait !== undefined && wait.cleared === undefined ? (wait.resetsAt ?? wait.resumeAt) : undefined;
  const limitedTo = until ?? waitUntil;
  if (limitedTo !== undefined)
    return { mode: "limit", why: `it is out of usage until ${utc(limitedTo)}` };
  if (wait !== undefined && wait.cleared === undefined)
    return { mode: "limit", why: "it is out of usage" };
  if (thread.lastError !== undefined || rt.status === "error")
    return {
      mode: "limit",
      why:
        thread.lastError === undefined
          ? "its last turn failed"
          : `its last turn failed (${redactText(thread.lastError.text)})`,
    };
  return { mode: wanted ? "outgoing" : "none" };
};

/** `switchAgent`, the boot sweep of the switches a restart cut off, and the turn ends they wait on. */
export const makeAgentSwitch = ({
  store,
  hosts,
  hub,
  getRuntime,
  switches,
  refuseMissingFolder,
  runtimes,
  afterRelease,
  limitedUntil,
  endLimitWait,
  gitState,
}: AgentSwitchDeps) => {
  /** The switch's own turns still running, by turn id, each waiting for its end. */
  const turnEnds = new Map<TurnId, Deferred.Deferred<Outcome>>();

  /** The runtime's observer hears every turn end; a switch's own turn ends its wait. */
  const onTurnEnd = (_thread: Thread, end: ObservedTurnEnd) =>
    Effect.suspend(() => {
      const waiting = turnEnds.get(end.turnId);
      return waiting === undefined
        ? Effect.void
        : Deferred.succeed(waiting, { end, turnId: end.turnId }).pipe(Effect.asVoid);
    });

  /**
   * One server-authored turn of the switch's own, sent once the thread can take it, and its
   * outcome: the turn's end, or why it never ran. `build` returns `undefined` to send nothing.
   */
  const turnOf = (
    threadId: ThreadId,
    key: string,
    build: (turnId: TurnId) => Effect.Effect<UserInput | undefined>,
  ) =>
    Effect.gen(function* () {
      const done = yield* Deferred.make<Outcome>();
      let carried: TurnId | undefined;
      yield* runtimes.requestSystemDelivery(threadId, key, {
        build: (turnId) =>
          Effect.gen(function* () {
            const input = yield* build(turnId);
            if (input === undefined) {
              yield* Deferred.succeed(done, { failed: "buildFailed" });
              return undefined;
            }
            carried = turnId;
            turnEnds.set(turnId, done);
            return input;
          }),
        accepted: () => Effect.void,
        failed: (_turnId, reason) => Deferred.succeed(done, { failed: reason }).pipe(Effect.asVoid),
      });
      return yield* Deferred.await(done).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (carried !== undefined) turnEnds.delete(carried);
          }),
        ),
      );
    });

  /** The messages of one of the switch's own turns, its prompt and its reply, as stored. */
  const messagesOf = (threadId: ThreadId, turnId: TurnId) =>
    Effect.gen(function* () {
      const recent = yield* store.lastMessages(threadId, OWN_TURN_LOOKBACK);
      const turns = yield* Effect.forEach(recent, (message) =>
        store.getMessageTurn(threadId, message.id),
      );
      return recent.filter((_, index) => turns[index]?.turnId === turnId);
    });

  /** The reply of a turn that ended `completed`, as a capped note by `by`; none otherwise. */
  const noteFrom = (threadId: ThreadId, outcome: Outcome, by: AgentKind) =>
    Effect.gen(function* () {
      if (!("end" in outcome) || outcome.end.synthesized || outcome.end.reason !== "completed")
        return undefined;
      const text = capNote(replyOf(yield* messagesOf(threadId, outcome.turnId)));
      return text === undefined ? undefined : ({ text, by } satisfies HandoffNote);
    });

  /**
   * The old session's last turn, asked for its note. Its turn id goes on the claim as it is built,
   * which holds the queue from then on. Undefined, with why, when the turn didn't end `completed`.
   */
  const askNote = (threadId: ThreadId, attemptId: string, previous: ModelRef, target: ModelRef) =>
    Effect.gen(function* () {
      const outcome = yield* turnOf(threadId, NOTE_KEY, (turnId) =>
        Effect.gen(function* () {
          const current = yield* store.getThread(threadId).pipe(Effect.option);
          if (
            Option.isNone(current) ||
            current.value.sessionSwitch?.id !== attemptId ||
            current.value.sessionSwitch.phase !== "checkpoint"
          )
            return undefined;
          yield* store
            .updateThread(threadId, (t) =>
              t.sessionSwitch?.id === attemptId
                ? { ...t, sessionSwitch: { ...t.sessionSwitch, checkpointTurnId: turnId } }
                : t,
            )
            .pipe(Effect.orDie);
          return { text: notePrompt(target.agent) };
        }),
      );
      const note = yield* noteFrom(threadId, outcome, previous.agent);
      // Its prompt and reply are the switch's, never part of the turns the handoff replays.
      const own = new Set(
        "turnId" in outcome
          ? (yield* messagesOf(threadId, outcome.turnId)).map((message) => message.id)
          : [],
      );
      if (note !== undefined) return { note, own };
      const why =
        "failed" in outcome
          ? `the note turn didn't run (${outcome.failed})`
          : outcome.end.reason === "completed"
            ? "the note turn ended with no reply"
            : `the note turn ended early (${outcome.end.synthesized ? "the session stopped" : outcome.end.reason})`;
      return { why, own };
    });

  /**
   * The thread's messages a handoff replays: since the last divider when there is one (switching
   * back), with that divider's note; else all of them. Never the note turn's own.
   */
  const conversation = (threadId: ThreadId, own: ReadonlySet<string>) =>
    Effect.gen(function* () {
      const rows = yield* store.listMessagesFrom(threadId, 0);
      let after = -1;
      let earlierNote: HandoffNote | undefined;
      rows.forEach((row, index) => {
        for (const part of row.message.parts)
          if (part.type === "data-handoff") {
            after = index;
            earlierNote = part.data.note;
          }
      });
      const window: ReadonlyArray<SeqMessage> = rows
        .slice(after + 1)
        .filter((row) => !own.has(row.message.id));
      return { messages: fromStoredMessages(window), earlierNote, sinceDivider: after >= 0 };
    });

  /** Gram's facts about the thread, from its own state; git is asked, and left out if it can't say. */
  const factsOf = (thread: Thread, opening: string | undefined) =>
    Effect.gen(function* () {
      const checkout = effectiveCheckout(thread);
      // Best effort: a machine that can't say (offline, no git here) leaves those facts unknown.
      const read = yield* Effect.exit(Effect.suspend(() => gitState(checkout.path)));
      const git = Exit.isSuccess(read) ? Option.some(read.value) : Option.none<GitState>();
      const plan = (yield* store.getPlan(thread.id)).plan;
      const waits = yield* store.listWaits(thread.id, "open");
      const wakes = (yield* store.listThreadWakes).filter((wake) => wake.threadId === thread.id);
      return renderFacts({
        title: thread.title,
        worker: thread.spawnedBy !== undefined,
        opening,
        plan,
        waits,
        checkout: {
          path: checkout.path,
          branch: Option.isSome(git) && git.value.repo ? git.value.branch : checkout.branch,
          ...(Option.isSome(git) && git.value.repo
            ? { head: git.value.head, changedFiles: git.value.changedFiles }
            : {}),
        },
        boundPr: thread.boundPr,
        extraPrs: thread.extraPrs ?? [],
        runWatches: thread.runWatches ?? [],
        wakes,
      });
    });

  /** The divider, once per attempt: messages above it can't be rewound or forked to. */
  const markTranscript = (
    threadId: ThreadId,
    attemptId: string,
    previous: ModelRef,
    agentSessionId?: string,
    carried?: Pick<Handoff, "noteMode" | "note" | "facts">,
  ) =>
    Effect.gen(function* () {
      const data: Handoff = {
        reason: "switch",
        switchId: attemptId,
        previousAgent: previous.agent,
        ...(agentSessionId === undefined ? {} : { previousAgentSessionId: agentSessionId }),
        ...carried,
        at: yield* Clock.currentTimeMillis,
      };
      const id = randomUUID();
      yield* runtimes.emitChunk(threadId, { type: "data-handoff", id, data }).pipe(Effect.ignore);
      return { id, data };
    });

  /** Limit mode's note, written by the new agent, onto the divider it belongs under. */
  const addNote = (
    threadId: ThreadId,
    divider: { readonly id: string; readonly data: Handoff },
    note: HandoffNote,
  ) =>
    Effect.gen(function* () {
      const message = (yield* store.messagesWithParts(threadId, ["data-handoff"])).find((m) =>
        m.parts.some((part) => part.type === "data-handoff" && part.id === divider.id),
      );
      if (message === undefined) return;
      yield* runtimes.updateDataPart(threadId, message.id, {
        type: "data-handoff",
        id: divider.id,
        data: { ...divider.data, note },
      });
    });

  /**
   * After the new session is ready: the divider with what the handoff carries, then the handoff as
   * the new session's first turn. The switch stays `ready` until that turn ends, so queued input
   * and Gram's own messages wait for it, limit mode's catch-up above all; its reply is the note.
   */
  const handOver = (
    threadId: ThreadId,
    attemptId: string,
    previous: ModelRef,
    replaced: string | undefined,
    own: ReadonlySet<string>,
    why: string | undefined,
  ) =>
    Effect.gen(function* () {
      const thread = yield* store.getThread(threadId);
      const plan = thread.sessionSwitch?.handoff;
      const noteMode: SwitchNoteMode = plan?.note ?? "none";
      const note: HandoffNote | undefined =
        plan?.text === undefined ? undefined : { text: plan.text, by: previous.agent };
      const { messages, earlierNote, sinceDivider } = yield* conversation(threadId, own);
      const opening = (yield* store.firstMessages(threadId, 4))
        .flatMap((message) => fromStoredMessages([{ seq: 0, message }]))
        .find((message) => message.role === "user")?.text;
      const facts = yield* factsOf(thread, opening);
      const turns = renderRecentTurns(
        messages,
        turnsBudgetTokens(noteMode),
        sinceDivider ? "this thread, since its previous switch" : "this thread",
      );
      const divider = yield* markTranscript(threadId, attemptId, previous, replaced, {
        noteMode,
        ...(note === undefined ? {} : { note }),
        facts,
      });
      const text = renderHandoff({
        from: previous.agent,
        to: thread.model.agent,
        noteMode,
        note,
        earlierNote,
        limitReason: why,
        facts,
        turns: turns.text,
      });
      const outcome = yield* turnOf(threadId, HANDOFF_KEY, () =>
        store.getThread(threadId).pipe(
          Effect.map((current) =>
            current.sessionSwitch?.id === attemptId && current.sessionSwitch.phase === "ready"
              ? { text }
              : undefined,
          ),
          Effect.orElseSucceed(() => undefined),
        ),
      );
      if (noteMode === "limit") {
        const written = yield* noteFrom(threadId, outcome, thread.model.agent);
        if (written !== undefined) yield* addNote(threadId, divider, written);
      }
    });

  /**
   * Lets the held input go. A release refused because the new session went meanwhile still drops
   * the claim: the thread is on its target, and holding its queue would help nothing.
   */
  const letGo = (threadId: ThreadId, attemptId: string) =>
    Effect.gen(function* () {
      const released = yield* runtimes.releaseSwitch(threadId, attemptId).pipe(
        Effect.as(true),
        Effect.catchTag("InvalidState", () => Effect.succeed(false)),
      );
      if (!released)
        yield* runtimes.updateThread(threadId, (t) =>
          t.sessionSwitch?.id === attemptId && t.sessionSwitch.phase === "ready"
            ? (({ sessionSwitch: _switch, ...rest }) => rest)(t)
            : t,
        );
      yield* afterRelease(yield* getRuntime(threadId));
    });

  /** The switch past its claim: the note, stop, open on the target, hand over, release. */
  const run = (threadId: ThreadId, attemptId: string, previous: ModelRef, limitWhy?: string) =>
    Effect.gen(function* () {
      let why = limitWhy;
      let own: ReadonlySet<string> = new Set();
      const claimed = (yield* store.getThread(threadId)).sessionSwitch;
      if (
        claimed?.id === attemptId &&
        claimed.phase === "checkpoint" &&
        claimed.handoff?.note === "outgoing" &&
        claimed.handoff.text === undefined
      ) {
        const asked = yield* askNote(threadId, attemptId, previous, claimed.target);
        own = asked.own;
        const after = yield* store.getThread(threadId);
        if (asked.note === undefined) {
          // The old agent ran out of usage or failed in its last turn: limit mode after all.
          // Anything else that stopped the note leaves the thread where it was.
          const limit = noteModeOf(
            yield* getRuntime(threadId),
            after,
            yield* limitedUntil(after),
            true,
          );
          if (limit.mode !== "limit")
            return yield* new InvalidState({
              threadId,
              message: `${AGENT_NAMES[previous.agent]} didn't write its handoff note: ${asked.why}.`,
            });
          why = limit.why;
        }
        yield* runtimes.updateThread(threadId, (t) =>
          t.sessionSwitch?.id === attemptId
            ? {
                ...t,
                sessionSwitch: {
                  ...t.sessionSwitch,
                  handoff:
                    asked.note === undefined
                      ? { note: "limit" }
                      : { note: "outgoing", text: asked.note.text },
                },
              }
            : t,
        );
      }
      const replaced = yield* runtimes.switchSession(threadId, attemptId);
      // The wait was the old account's; the new agent's turns aren't held by it.
      yield* endLimitWait(yield* getRuntime(threadId));
      // The thread is on its target now: a handoff that couldn't be put together or sent still
      // lets the queue go, rather than hold it on a switch nothing can retry.
      yield* handOver(threadId, attemptId, previous, replaced, own, why).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("the switched session didn't get its handoff").pipe(
              Effect.annotateLogs({ threadId, cause: Cause.pretty(cause) }),
            );
            yield* hub.publish({
              type: "notify",
              kind: "error",
              title: "The handoff didn't reach the new session",
              body: `The thread continues in ${AGENT_NAMES[(yield* store.getThread(threadId)).model.agent]} without the note and recent turns. Tell it what it needs to carry on.`,
              threadId,
            });
          }),
        ),
      );
      yield* letGo(threadId, attemptId);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const failure = Cause.findErrorOption(cause);
          const why = Option.isSome(failure)
            ? failure.value.message
            : "The switch was interrupted before the previous session stopped.";
          const current = yield* store.getThread(threadId).pipe(Effect.option);
          if (Option.isNone(current)) return;
          // Rolled back by `switchSession`: on its source again, the held input on its way.
          if (current.value.sessionSwitch === undefined) {
            if (current.value.model.agent !== previous.agent) return;
            return yield* hub.publish({
              type: "notify",
              kind: "info",
              title: "The switch was undone",
              body: `${why} The thread is back in ${AGENT_NAMES[previous.agent]}, on the session it had.`,
              threadId,
            });
          }
          if (current.value.sessionSwitch.id !== attemptId) return;
          // Nothing was stopped yet: the thread carries on in the session it had.
          if (current.value.sessionSwitch.phase === "checkpoint") {
            yield* runtimes.cancelSessionSwitch(threadId, attemptId).pipe(Effect.ignore);
            return yield* hub.publish({
              type: "notify",
              kind: "info",
              title: "The switch didn't start",
              body: `${why} The thread carries on in ${AGENT_NAMES[previous.agent]}.`,
              threadId,
            });
          }
          yield* hub.publish({
            type: "notify",
            kind: "error",
            title: "The switch needs attention",
            body: `${why} Queued messages are held. Try the switch again from the thread.`,
            threadId,
          });
          yield* Effect.logWarning("thread agent switch did not complete").pipe(
            Effect.annotateLogs({ threadId, cause: Cause.pretty(cause) }),
          );
        }),
      ),
    );

  /**
   * A failed switch tried again, onto `target` (the same agent or back to the previous one). An
   * attempt whose old session had begun stopping needs the target's proof that its own child is
   * gone, as the orchestrator's retry does.
   */
  const retry = (thread: Thread, target: ModelRef) =>
    Effect.gen(function* () {
      const change = thread.sessionSwitch!;
      let release = change.targetRelease;
      if (change.oldExited && release === undefined) {
        const host = yield* hosts
          .get(change.target.agent)
          .pipe(Effect.mapError((e) => new InvalidState({ message: e.message })));
        release =
          host.switchAttemptReceipt === undefined
            ? undefined
            : yield* host.switchAttemptReceipt(change.id);
      }
      if (change.oldExited && release === undefined)
        return yield* new InvalidState({
          threadId: thread.id,
          message:
            "The failed attempt has not proved that no target child remains. It may still be stopping, or its owner cannot be verified after an app restart. No retry was started; queued input remains held.",
        });
      const id = randomUUID();
      const next = yield* runtimes
        .updateThread(thread.id, (t) =>
          t.sessionSwitch?.id === change.id
            ? {
                ...t,
                sessionSwitch: {
                  id,
                  previous: change.previous,
                  target,
                  mode: change.mode,
                  phase: "retry",
                  oldExited: change.oldExited,
                  ...(change.oldExited && release !== undefined
                    ? { retryFrom: { id: change.id, release } }
                    : {}),
                  ...(change.source === undefined ? {} : { source: change.source }),
                  // The old session is gone or going: a note it didn't write is not asked again.
                  handoff:
                    change.handoff === undefined
                      ? { note: "none" }
                      : change.handoff.note === "outgoing" && change.handoff.text === undefined
                        ? { note: "none" }
                        : change.handoff,
                },
              }
            : t,
        )
        .pipe(Effect.mapError((e) => new InvalidState({ message: e.message })));
      if (next.sessionSwitch?.id !== id)
        return yield* new InvalidState({
          threadId: thread.id,
          message: "The switch changed while it was checked. Review it and try again.",
        });
      return { next, id };
    });

  const switchAgent: ThreadRuntimesShape["switchAgent"] = (threadId, target, options) =>
    Effect.gen(function* () {
      const rt = yield* getRuntime(threadId);
      const thread = yield* store.getThread(threadId);
      const failed = thread.sessionSwitch?.phase === "failed";
      if (thread.sessionSwitch !== undefined && !failed)
        return yield* new InvalidState({
          threadId,
          message: "Wait for this switch to finish, then switch again.",
        });
      // A failed switch is tried again, onto its target or back onto the agent it left: either
      // way a fresh session, from the model it was switched away from.
      if (failed) {
        const previous = thread.sessionSwitch!.previous;
        if (thread.role === "orchestrator")
          return yield* new InvalidState({
            threadId,
            message: "Retry the orchestrator's switch from its own Switch orchestrator… action.",
          });
        yield* checkSwitchTarget(store, hosts, { model: previous, mode: thread.mode }, target);
        const { id } = yield* retry(thread, target);
        yield* FiberMap.run(switches, threadId, run(threadId, id, previous));
        return yield* store.getThread(threadId);
      }
      const until = yield* limitedUntil(thread);
      const checked = yield* locked(
        rt,
        Effect.gen(function* () {
          const current = yield* store.getThread(threadId);
          return {
            why: notNow(rt, current, target, (yield* store.listRequests(threadId)).length),
            note: noteModeOf(rt, current, until, options?.note !== false),
          };
        }),
      );
      if (checked.why !== undefined)
        return yield* new InvalidState({ threadId, message: checked.why });
      yield* refuseMissingFolder(rt);
      yield* checkSwitchTarget(store, hosts, thread, target);
      const id = randomUUID();
      const mode: PermissionMode = thread.mode;
      // The claim re-checks the model and mode it was asked against, under the runtime lock.
      yield* runtimes.claimSessionSwitch(threadId, {
        id,
        target,
        previous: thread.model,
        mode,
        phase: "checkpoint",
        oldExited: false,
        // Kept until the target is confirmed, so a failed start goes back to it.
        source: sessionIdentity(thread),
        handoff: { note: checked.note.mode },
      });
      // The refusals again, now that the claim holds the queue: a turn may have started meanwhile.
      const late = yield* locked(
        rt,
        Effect.gen(function* () {
          const current = yield* store.getThread(threadId);
          return notNow(
            rt,
            { ...current, model: thread.model },
            target,
            (yield* store.listRequests(threadId)).length,
          );
        }),
      );
      if (late !== undefined) {
        yield* runtimes.cancelSessionSwitch(threadId, id).pipe(Effect.ignore);
        return yield* new InvalidState({ threadId, message: late });
      }
      yield* FiberMap.run(switches, threadId, run(threadId, id, thread.model, checked.note.why));
      return yield* store.getThread(threadId);
    });

  /**
   * At boot, a plain thread's or worker's switch the last run left. One not yet stopping is
   * dropped, as nothing happened to its session. One whose new session was confirmed only lacks its
   * divider and release, so it finishes. One caught between is failed: who owns the session can't
   * be proved, so nothing starts on its own. The orchestrator's is `resumeHandoff`'s.
   */
  const resumeAtBoot = (thread: Thread) =>
    Effect.gen(function* () {
      const change = thread.sessionSwitch;
      if (change === undefined || thread.role === "orchestrator") return;
      if (change.phase === "checkpoint") {
        yield* runtimes
          .updateThread(thread.id, (t) =>
            t.sessionSwitch?.id === change.id
              ? (({ sessionSwitch: _switch, ...rest }) => rest)(t)
              : t,
          )
          .pipe(Effect.ignore);
        return;
      }
      if (change.phase === "ready") {
        const marked = (yield* store.messagesWithParts(thread.id, ["data-handoff"])).some(
          (message) =>
            message.parts.some(
              (part) => part.type === "data-handoff" && part.data.switchId === change.id,
            ),
        );
        // Its handoff turn was lost with the process: the divider says what was carried.
        if (!marked)
          yield* markTranscript(thread.id, change.id, change.previous, undefined, {
            noteMode: change.handoff?.note ?? "none",
            ...(change.handoff?.text === undefined
              ? {}
              : { note: { text: change.handoff.text, by: change.previous.agent } }),
          });
        yield* runtimes
          .updateThread(thread.id, (t) =>
            t.sessionSwitch?.id === change.id
              ? (({ sessionSwitch: _switch, ...rest }) => rest)(t)
              : t,
          )
          .pipe(Effect.ignore);
        return;
      }
      if (change.phase === "failed") return;
      yield* runtimes
        .updateThread(thread.id, (t) =>
          t.sessionSwitch?.id === change.id
            ? {
                ...t,
                sessionSwitch: {
                  ...change,
                  phase: "failed",
                  detail:
                    "The app restarted during this switch. The previous attempt's process ownership cannot be verified, so no session was started automatically. Your history and queued input are retained.",
                },
              }
            : t,
        )
        .pipe(Effect.ignore);
    });

  return { switchAgent, resumeAtBoot, onTurnEnd };
};
