import {
  listedRow,
  aboveHigh,
  type AgentUnavailable,
  effectiveCheckout,
  InvalidState,
  isLocalHost,
  profileAllowsModel,
  profileModelRefusal,
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
import {
  SWITCH_HANDOFF_KEY,
  type DeliveryRest,
  type SystemDelivery,
  type SystemDeliveryFailure,
} from "./system-delivery.ts";
import type { ThreadRuntimesShape } from "./thread-runtimes-shape.ts";
import { sessionIdentity } from "./session-switch.ts";
import type { EventHub } from "../events/event-hub.ts";
import { fromStoredMessages } from "../orchestration/transcripts.ts";
import { makeKeyedLock } from "../git/keyed-lock.ts";
import {
  capNote,
  material,
  notePrompt,
  renderFacts,
  renderHandoff,
  renderRecentTurns,
  turnsBudgetTokens,
  type HandoffLimit,
} from "./switch-handoff.ts";
import { AGENT_NAMES } from "./agent-names.ts";

/**
 * Refuses a model the thread's profile doesn't let its sessions run (`ProfileModel.choices`): by
 * the name asked for, or by what the listed row runs. Nothing where the profile sets no limit.
 */
export const checkProfileModel = (
  thread: Pick<Thread, "profile"> | undefined,
  model: string,
  row?: { readonly id: string; readonly resolvedId?: string | undefined },
) =>
  Effect.gen(function* () {
    const profile = thread?.profile;
    if (profile?.models === undefined) return;
    if (profileAllowsModel(profile, model)) return;
    if (row !== undefined && profileAllowsModel(profile, row.id, row.resolvedId)) return;
    if (row === undefined) return;
    return yield* new InvalidState({ message: profileModelRefusal(profile, model) });
  });

/**
 * Whether `target` can take over `thread`'s session: a build that can stop and start one cleanly,
 * the CLI's own sign-in, a mode it keeps, a model and effort its CLI lists, and a sign-in it
 * re-checks now. Shared by the orchestrator's switch and any thread's. Returns nothing; each
 * refusal is an `InvalidState` the user reads.
 */
export const checkSwitchTarget = (
  store: Pick<ThreadStoreShape, "listProfiles" | "getSettings">,
  hosts: AgentHosts["Service"],
  thread: Pick<Thread, "model" | "mode" | "profile">,
  target: ModelRef,
) =>
  Effect.gen(function* () {
    const name = AGENT_NAMES[target.agent];
    yield* checkProfileModel(thread, target.model);
    const sourceHost = yield* hosts
      .get(thread.model.agent)
      .pipe(Effect.mapError((e) => new InvalidState({ message: e.message })));
    const targetHost = yield* hosts
      .get(target.agent)
      .pipe(Effect.mapError((e) => new InvalidState({ message: e.message })));
    if (!sourceHost.supportsWorkspaceSwitch || !targetHost.supportsWorkspaceSwitch) {
      const lacking = [sourceHost, targetHost].find(
        (host) => host.supportsWorkspaceSwitch === undefined,
      );
      return yield* new InvalidState({
        message:
          lacking !== undefined
            ? `${AGENT_NAMES[lacking.kind]} can't hand a session to another agent yet. Start a new thread on ${name} instead. Your current session and preferences have not changed.`
            : "Switching an existing session is unavailable on Windows, which cannot currently guarantee a graceful stop. Your current session and preferences have not changed.",
      });
    }
    if (target.profileId !== undefined)
      return yield* new InvalidState({
        message:
          "Choose the installed CLI's subscription login for this switch. Switching does not migrate gateway credentials or accounts.",
      });
    if (thread.model.profileId !== undefined)
      return yield* new InvalidState({
        message: "Switching uses the CLI's own sign-in; it doesn't move gateway accounts.",
      });
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
    const selected = listedRow(models, target.model);
    if (selected === undefined)
      return yield* new InvalidState({
        message: `The installed ${name} CLI does not list ${target.model}. Select a listed model, or add that exact custom ID in Settings → Agents first. No model was substituted.`,
      });
    yield* checkProfileModel(thread, target.model, selected);
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
    yield* targetHost.checkWorkspaceSwitch.pipe(
      Effect.mapError((e) => new InvalidState({ message: e.message })),
    );
  });

/**
 * Whether a fresh session can open on `target`: a model its CLI lists (on its account, a gateway
 * profile's included), an effort and a speed it offers. What a fresh session asks of a model is a
 * new thread's: it carries no session over, so none of the switch's handover checks apply. Returns
 * nothing; each refusal is an `InvalidState` the user reads.
 */
export const checkFreshTarget = (
  store: Pick<ThreadStoreShape, "listProfiles" | "getSettings">,
  hosts: AgentHosts["Service"],
  target: ModelRef,
  thread?: Pick<Thread, "profile">,
) =>
  Effect.gen(function* () {
    const name = AGENT_NAMES[target.agent];
    yield* checkProfileModel(thread, target.model);
    const models = yield* selectableModels(store, hosts, target.agent, target.profileId).pipe(
      Effect.mapError((e) => new InvalidState({ message: e.message })),
    );
    const selected = listedRow(models, target.model);
    if (selected === undefined)
      return yield* new InvalidState({
        message: `${name} does not list ${target.model} here. Select a listed model. No model was substituted.`,
      });
    yield* checkProfileModel(thread, target.model, selected);
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
  });

/**
 * How `thread` gets onto `target` when asked to: `switch` where its session can carry over
 * (`checkSwitchTarget`), else `fresh`, a fresh session that opens on it, where it can open
 * (`checkFreshTarget`). Refused, in the fresh session's words, where neither can happen.
 */
export const moveKindOf = (
  store: Pick<ThreadStoreShape, "listProfiles" | "getSettings">,
  hosts: AgentHosts["Service"],
  thread: Pick<Thread, "model" | "mode" | "profile">,
  target: ModelRef,
) =>
  checkSwitchTarget(store, hosts, thread, target).pipe(
    Effect.as("switch" as const),
    Effect.catchTag("InvalidState", () =>
      checkFreshTarget(store, hosts, target, thread).pipe(Effect.as("fresh" as const)),
    ),
  );

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
    return "Move the orchestrator from its own Continue in… sheet, in its menu or in Settings → Workspaces.";
  if (rt.closing || thread.parked) return "Unarchive this thread before switching it.";
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
  if (
    thread.forkedFrom !== undefined &&
    (thread.agentSessionId === undefined || thread.agentSessionUnused === true)
  )
    return "Send once in this fork first.";
  if (rt.reserved) return "This thread's worktree is in use. Try again in a moment.";
  return undefined;
};

const NOTE_KEY = "switch-note";

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
  readonly endLimitWait: (rt: Runtime, previous: ModelRef) => Effect.Effect<void>;
  /**
   * After a restart: reopens a `ready` switch's confirmed target under its attempt and confirms it
   * as the switch did, its mode settled before `ready` lets the handoff go (`session-switch.ts`).
   */
  readonly reopenTarget: (
    threadId: ThreadId,
    attemptId: string,
  ) => Effect.Effect<string, InvalidState | AgentUnavailable | ThreadNotFound>;
  /** Runs `effect` in the background, for as long as the runtime lives. */
  readonly background: (effect: Effect.Effect<void>) => Effect.Effect<void>;
  /** A checkout's branch, HEAD and changes, as git reports them here or on its machine. */
  readonly gitState: (cwd: string) => Effect.Effect<GitState, unknown>;
  /**
   * The delivery a role hands a switch over with instead of the thread's handoff: the
   * orchestrator's boot digest (`SessionPolicyPort.switchHandoff`); `undefined` for any other.
   */
  readonly roleHandoff: (thread: Thread) => Effect.Effect<SystemDelivery | undefined>;
}

type Outcome = ({ readonly end: ObservedTurnEnd } | { readonly failed: SystemDeliveryFailure }) & {
  readonly turnId?: TurnId | undefined;
};

/** A turn's reply as plain text: its main lane's text parts, in order. */
export const replyOf = (messages: ReadonlyArray<GramUIMessage>): string =>
  messages
    .filter(
      (message) => message.role === "assistant" && message.metadata?.parentToolUseId === undefined,
    )
    .flatMap((message) =>
      message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    )
    .join("\n\n");

const noteModeOf = (
  rt: Pick<Runtime, "status">,
  thread: Thread,
  until: number | undefined,
  wanted: boolean,
): { readonly mode: SwitchNoteMode; readonly limit?: HandoffLimit } => {
  const wait = thread.limitWait;
  const waiting = wait !== undefined && wait.cleared === undefined;
  const limitedTo = until ?? (waiting ? (wait.resetsAt ?? wait.resumeAt) : undefined);
  if (limitedTo !== undefined)
    return { mode: "limit", limit: { reason: "usage", until: limitedTo } };
  if (waiting) return { mode: "limit", limit: { reason: "usage" } };
  if (thread.lastError !== undefined || rt.status === "error")
    return {
      mode: "limit",
      limit: {
        reason: "failed",
        ...(thread.lastError === undefined ? {} : { detail: thread.lastError.text }),
      },
    };
  return { mode: wanted ? "outgoing" : "none" };
};

/**
 * A turn's whole reply as a handoff note by `by`, through `capNote` (scrubbed, then cut at
 * `HANDOFF_NOTE_MAX_CHARS`); none when it said nothing. Read by the turn's id, so a long reply keeps
 * its beginning. Any thread's switch reads its note this way, the orchestrator's checkpoint too.
 */
export const turnNote = (
  store: Pick<ThreadStoreShape, "turnMessages">,
  threadId: ThreadId,
  turnId: TurnId,
  by: AgentKind,
) =>
  store.turnMessages(threadId, turnId).pipe(
    Effect.map((messages) => {
      const text = capNote(replyOf(messages));
      return text === undefined ? undefined : ({ text, by } satisfies HandoffNote);
    }),
  );

const claimOf = (thread: Thread, attemptId: string) =>
  thread.sessionSwitch?.id === attemptId ? thread.sessionSwitch : undefined;

const dividerKey = (claim: NonNullable<Thread["sessionSwitch"]>): string =>
  claim.handoff?.divider ?? claim.id;

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
  reopenTarget,
  background,
  gitState,
  roleHandoff,
}: AgentSwitchDeps) => {
  const turnEnds = new Map<TurnId, Deferred.Deferred<Outcome>>();

  const owed = new Map<ThreadId, string>();

  const onTurnEnd = (_thread: Thread, end: ObservedTurnEnd) =>
    Effect.suspend(() => {
      const waiting = turnEnds.get(end.turnId);
      return waiting === undefined
        ? Effect.void
        : Deferred.succeed(waiting, { end, turnId: end.turnId }).pipe(Effect.asVoid);
    });

  const turnOf = (
    threadId: ThreadId,
    key: string,
    build: (turnId: TurnId, rest: DeliveryRest) => Effect.Effect<UserInput | undefined>,
    accepted: (turnId: TurnId) => Effect.Effect<void> = () => Effect.void,
    started?: (turnId: TurnId) => Effect.Effect<void>,
    failed?: SystemDelivery["failed"],
  ) =>
    Effect.gen(function* () {
      const done = yield* Deferred.make<Outcome>();
      let carried: TurnId | undefined;
      yield* runtimes.requestSystemDelivery(threadId, key, {
        build: (turnId, rest) =>
          Effect.gen(function* () {
            const input = yield* build(turnId, rest);
            if (input === undefined) {
              yield* Deferred.succeed(done, { failed: "buildFailed" });
              return undefined;
            }
            carried = turnId;
            turnEnds.set(turnId, done);
            return input;
          }),
        accepted,
        ...(started === undefined ? {} : { started }),
        failed: (turnId, reason) =>
          (failed === undefined ? Effect.void : failed(turnId, reason)).pipe(
            Effect.andThen(Deferred.succeed(done, { failed: reason, turnId: turnId ?? carried })),
            Effect.asVoid,
          ),
      });
      return yield* Deferred.await(done).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (carried !== undefined) turnEnds.delete(carried);
          }),
        ),
      );
    });

  const noteFrom = (threadId: ThreadId, outcome: Outcome, by: AgentKind) =>
    Effect.gen(function* () {
      if (
        !("end" in outcome) ||
        outcome.turnId === undefined ||
        outcome.end.synthesized ||
        outcome.end.reason !== "completed"
      )
        return undefined;
      return yield* turnNote(store, threadId, outcome.turnId, by);
    });

  const askNote = (threadId: ThreadId, attemptId: string, previous: ModelRef, target: ModelRef) =>
    Effect.gen(function* () {
      const outcome = yield* turnOf(threadId, NOTE_KEY, (turnId) =>
        Effect.gen(function* () {
          const current = yield* store.getThread(threadId).pipe(Effect.option);
          if (Option.isNone(current) || claimOf(current.value, attemptId)?.phase !== "checkpoint")
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
      if (note !== undefined) return { note };
      const why =
        "failed" in outcome
          ? `the note turn didn't run (${outcome.failed})`
          : outcome.end.reason === "completed"
            ? "the note turn ended with no reply"
            : `the note turn ended early (${outcome.end.synthesized ? "the session stopped" : outcome.end.reason})`;
      return { why };
    });

  const conversation = (threadId: ThreadId, attemptId: string, noteTurn: TurnId | undefined) =>
    Effect.gen(function* () {
      const rows = yield* store.listMessagesFrom(threadId, 0);
      const own = new Set(
        noteTurn === undefined
          ? []
          : (yield* store.turnMessages(threadId, noteTurn)).map((message) => message.id),
      );
      let after = -1;
      let earlierNote: HandoffNote | undefined;
      rows.forEach((row, index) => {
        for (const part of row.message.parts)
          if (part.type === "data-handoff" && part.data.switchId !== attemptId) {
            after = index;
            earlierNote = part.data.note;
          }
      });
      const window: ReadonlyArray<SeqMessage> = rows
        .slice(after + 1)
        .filter(
          (row) =>
            !own.has(row.message.id) &&
            !row.message.parts.some(
              (part) => part.type === "data-handoff" && part.data.switchId === attemptId,
            ),
        );
      return { messages: fromStoredMessages(window), earlierNote, sinceDivider: after >= 0 };
    });

  const factsOf = (thread: Thread, opening: string | undefined) =>
    Effect.gen(function* () {
      const checkout = effectiveCheckout(thread);
      const read = yield* Effect.exit(Effect.suspend(() => gitState(checkout.path)));
      const git = Exit.isSuccess(read) && read.value.repo ? read.value : undefined;
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
          branch: git === undefined ? checkout.branch : git.branch,
          ...(git === undefined ? {} : { head: git.head, changedFiles: git.changedFiles }),
        },
        boundPr: thread.boundPr,
        extraPrs: thread.extraPrs ?? [],
        runWatches: thread.runWatches ?? [],
        wakes,
      });
    });

  const dividerOf = (threadId: ThreadId, attemptId: string) =>
    Effect.gen(function* () {
      for (const message of yield* store.messagesWithParts(threadId, ["data-handoff"]))
        for (const part of message.parts)
          if (part.type === "data-handoff" && part.data.switchId === attemptId)
            return { messageId: message.id, id: part.id ?? "", data: part.data };
      return undefined;
    });

  const markTranscript = (
    threadId: ThreadId,
    attemptId: string,
    previous: ModelRef,
    target: ModelRef,
    agentSessionId?: string,
    carried?: Pick<Handoff, "noteMode" | "limit" | "note" | "facts">,
  ) =>
    Effect.gen(function* () {
      const data: Handoff = {
        reason: "switch",
        switchId: attemptId,
        previousAgent: previous.agent,
        previousModel: previous.model,
        model: target.model,
        ...(agentSessionId === undefined ? {} : { previousAgentSessionId: agentSessionId }),
        ...carried,
        at: yield* Clock.currentTimeMillis,
      };
      const id = randomUUID();
      yield* runtimes.emitChunk(threadId, { type: "data-handoff", id, data }).pipe(Effect.ignore);
      return { id, data };
    });

  const addNote = (threadId: ThreadId, attemptId: string, note: HandoffNote) =>
    Effect.gen(function* () {
      const divider = yield* dividerOf(threadId, attemptId);
      if (divider === undefined) return;
      yield* runtimes.updateDataPart(threadId, divider.messageId, {
        type: "data-handoff",
        id: divider.id,
        data: { ...divider.data, note },
      });
    });

  const handOver = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const thread = yield* store.getThread(threadId);
      const claim = thread.sessionSwitch;
      if (
        claim?.phase !== "ready" ||
        claim.handoff === undefined ||
        thread.parked ||
        claim.handoff.delivered !== undefined
      )
        return;
      const attemptId = claim.id;
      const key = dividerKey(claim);
      const own = yield* roleHandoff(thread);
      if (own !== undefined) return yield* handOverOwn(thread, attemptId, key, own);
      if (thread.role === "orchestrator")
        return yield* new InvalidState({
          threadId,
          message: "The orchestrator's boot digest isn't ready to hand over yet.",
        });
      const previous = claim.previous;
      const plan = claim.handoff;
      const noteMode: SwitchNoteMode = plan.note;
      const note: HandoffNote | undefined =
        plan.text === undefined ? undefined : { text: plan.text, by: previous.agent };
      const existing = yield* dividerOf(threadId, key);
      const { messages, earlierNote, sinceDivider } = yield* conversation(
        threadId,
        key,
        claim.checkpointTurnId,
      );
      const opening = (yield* store.firstMessages(threadId, 4))
        .flatMap((message) => fromStoredMessages([{ seq: 0, message }]))
        .find((message) => message.role === "user")?.text;
      const facts = existing?.data.facts ?? material(yield* factsOf(thread, opening));
      const turns = renderRecentTurns(
        messages,
        turnsBudgetTokens(noteMode),
        sinceDivider ? "this thread, since its previous switch" : "this thread",
      );
      if (existing === undefined)
        yield* markTranscript(threadId, key, previous, thread.model, claim.source?.agentSessionId, {
          noteMode,
          ...(plan.limit === undefined ? {} : { limit: plan.limit.reason }),
          ...(note === undefined ? {} : { note }),
          facts,
        });
      const text = renderHandoff({
        from: previous.agent,
        to: thread.model.agent,
        noteMode,
        note,
        earlierNote,
        limit: plan.limit,
        facts,
        turns: turns.text,
      });
      if ((yield* getRuntime(threadId)).session === undefined) return;
      const outcome = yield* turnOf(
        threadId,
        SWITCH_HANDOFF_KEY,
        () =>
          store.getThread(threadId).pipe(
            Effect.map((current) =>
              claimOf(current, attemptId)?.phase === "ready" && !current.parked
                ? { text }
                : undefined,
            ),
            Effect.orElseSucceed(() => undefined),
          ),
        (turnId) => markDelivered(threadId, attemptId, turnId),
        (turnId) => markDelivered(threadId, attemptId, turnId),
      );
      if (noteMode === "limit") {
        const written = yield* noteFrom(threadId, outcome, thread.model.agent);
        if (written !== undefined) yield* addNote(threadId, key, written);
      }
    });

  const handOverOwn = (thread: Thread, attemptId: string, key: string, own: SystemDelivery) =>
    Effect.gen(function* () {
      const threadId = thread.id;
      if ((yield* getRuntime(threadId)).session === undefined) return;
      const outcome = yield* turnOf(
        threadId,
        SWITCH_HANDOFF_KEY,
        (turnId, rest) =>
          store.getThread(threadId).pipe(
            Effect.flatMap((current) =>
              claimOf(current, attemptId)?.phase === "ready" && !current.parked
                ? own.build(turnId, rest)
                : Effect.succeed(undefined),
            ),
            Effect.orElseSucceed(() => undefined),
          ),
        (turnId) =>
          markDelivered(threadId, attemptId, turnId).pipe(Effect.andThen(own.accepted(turnId))),
        (turnId) => markDelivered(threadId, attemptId, turnId),
        own.failed,
      );
      if (claimOf(thread, attemptId)?.handoff?.note === "limit") {
        const written = yield* noteFrom(threadId, outcome, thread.model.agent);
        if (written !== undefined) yield* addNote(threadId, key, written);
      }
    });

  const markDelivered = (threadId: ThreadId, attemptId: string, turnId: TurnId) =>
    runtimes
      .updateThread(threadId, (t) => {
        const change = claimOf(t, attemptId);
        return change?.handoff === undefined || change.handoff.delivered !== undefined
          ? t
          : {
              ...t,
              sessionSwitch: { ...change, handoff: { ...change.handoff, delivered: turnId } },
            };
      })
      .pipe(Effect.ignore);

  const letGo = (threadId: ThreadId, attemptId: string) =>
    Effect.gen(function* () {
      const released = yield* runtimes.releaseSwitch(threadId, attemptId).pipe(
        Effect.as(true),
        Effect.catchTag("InvalidState", () => Effect.succeed(false)),
      );
      if (!released)
        yield* runtimes.updateThread(threadId, (t) =>
          claimOf(t, attemptId)?.phase === "ready"
            ? (({ sessionSwitch: _switch, ...rest }) => rest)(t)
            : t,
        );
      yield* afterRelease(yield* getRuntime(threadId));
    });

  const failOwed = (threadId: ThreadId, detail: string) =>
    Effect.gen(function* () {
      yield* runtimes
        .updateThread(threadId, (t) =>
          t.sessionSwitch?.phase === "ready" && t.sessionSwitch.handoff !== undefined
            ? { ...t, sessionSwitch: { ...t.sessionSwitch, phase: "failed", detail } }
            : t,
        )
        .pipe(Effect.ignore);
      yield* hub.publish({
        type: "notify",
        kind: "error",
        title: "The switch needs attention",
        body: `${detail} Queued messages are held. Try the switch again from the thread.`,
        threadId,
      });
    });

  const finishLock = makeKeyedLock<ThreadId>();
  const serially = <A, E>(threadId: ThreadId, effect: Effect.Effect<A, E>) =>
    finishLock.withLock(threadId, effect);

  const HANDOFF_TRIES = 3;

  const finish = (threadId: ThreadId): Effect.Effect<void, ThreadNotFound> =>
    serially(
      threadId,
      Effect.gen(function* () {
        for (let tries = 0; ; tries++) {
          const thread = yield* store.getThread(threadId);
          const claim = thread.sessionSwitch;
          if (claim?.phase !== "ready" || claim.handoff === undefined) {
            owed.delete(threadId);
            return;
          }
          if (thread.parked) {
            owed.set(threadId, claim.id);
            return;
          }
          owed.delete(threadId);
          if (claim.handoff.delivered !== undefined) return yield* letGo(threadId, claim.id);
          if (tries >= HANDOFF_TRIES)
            return yield* failOwed(
              threadId,
              "The new session didn't take its handoff, so nothing it held was sent.",
            );
          const reopened = yield* reopenTarget(threadId, claim.id).pipe(
            Effect.as(true),
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                yield* Effect.logWarning("a switch's new session didn't reopen").pipe(
                  Effect.annotateLogs({ threadId, cause: Cause.pretty(cause) }),
                );
                const failure = Cause.findErrorOption(cause);
                yield* failOwed(
                  threadId,
                  Option.isSome(failure)
                    ? `The new session didn't reopen: ${failure.value.message}`
                    : "The new session didn't reopen.",
                );
                return false;
              }),
            ),
          );
          if (!reopened) return;
          const given = yield* handOver(threadId).pipe(
            Effect.as(true),
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                yield* Effect.logWarning("the switched session didn't get its handoff").pipe(
                  Effect.annotateLogs({ threadId, cause: Cause.pretty(cause) }),
                );
                yield* failOwed(
                  threadId,
                  "The handoff couldn't be put together for the new session, so nothing it held was sent.",
                );
                return false;
              }),
            ),
          );
          if (!given) return;
        }
      }),
    );

  const run = (threadId: ThreadId, attemptId: string, previous: ModelRef) =>
    Effect.gen(function* () {
      const claimed = claimOf(yield* store.getThread(threadId), attemptId);
      if (
        claimed?.phase === "checkpoint" &&
        claimed.handoff?.note === "outgoing" &&
        claimed.handoff.text === undefined
      ) {
        const asked = yield* askNote(threadId, attemptId, previous, claimed.target);
        let limit: HandoffLimit | undefined;
        if (asked.note === undefined) {
          const after = yield* store.getThread(threadId);
          const found = noteModeOf(
            yield* getRuntime(threadId),
            after,
            yield* limitedUntil(after),
            true,
          );
          if (found.mode !== "limit")
            return yield* new InvalidState({
              threadId,
              message: `${AGENT_NAMES[previous.agent]} didn't write its handoff note: ${asked.why}.`,
            });
          limit = found.limit;
        }
        yield* runtimes.updateThread(threadId, (t) => {
          const change = claimOf(t, attemptId);
          return change === undefined
            ? t
            : {
                ...t,
                sessionSwitch: {
                  ...change,
                  handoff:
                    asked.note === undefined
                      ? { note: "limit", ...(limit === undefined ? {} : { limit }) }
                      : { note: "outgoing", text: asked.note.text },
                },
              };
        });
      }
      yield* runtimes.switchSession(threadId, attemptId);
      yield* endLimitWait(yield* getRuntime(threadId), previous);
      yield* finish(threadId);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const failure = Cause.findErrorOption(cause);
          const why = Option.isSome(failure)
            ? failure.value.message
            : "The switch was interrupted before the previous session stopped.";
          const current = yield* store.getThread(threadId).pipe(Effect.option);
          if (Option.isNone(current)) return;
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
                  handoff:
                    change.handoff === undefined
                      ? { note: "none" }
                      : change.handoff.note === "outgoing" && change.handoff.text === undefined
                        ? { note: "none" }
                        : (({ delivered: _delivered, ...rest }) => rest)(change.handoff),
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
      if (failed) {
        const previous = thread.sessionSwitch.previous;
        if (thread.role === "orchestrator")
          return yield* new InvalidState({
            threadId,
            message: "Retry the orchestrator's switch from its own Continue in… sheet.",
          });
        yield* checkSwitchTarget(
          store,
          hosts,
          {
            model: previous,
            mode: thread.mode,
            ...(thread.profile === undefined ? {} : { profile: thread.profile }),
          },
          target,
        );
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
      yield* runtimes.claimSessionSwitch(threadId, {
        id,
        target,
        previous: thread.model,
        mode,
        phase: "checkpoint",
        oldExited: false,
        source: sessionIdentity(thread),
        handoff: {
          note: checked.note.mode,
          ...(checked.note.limit === undefined ? {} : { limit: checked.note.limit }),
        },
      });
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
      yield* FiberMap.run(switches, threadId, run(threadId, id, thread.model));
      return yield* store.getThread(threadId);
    });

  const give = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const claim = (yield* store.getThread(threadId)).sessionSwitch;
      if (claim?.phase !== "ready" || claim.handoff === undefined) return;
      yield* endLimitWait(yield* getRuntime(threadId), claim.previous);
      yield* background(
        finish(threadId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("couldn't settle a switch").pipe(
              Effect.annotateLogs({ threadId, cause: Cause.pretty(cause) }),
            ),
          ),
        ),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("couldn't give a switch its handoff").pipe(
          Effect.annotateLogs({ threadId, cause: Cause.pretty(cause) }),
        ),
      ),
    );

  const handOverOwed = Effect.suspend(() =>
    Effect.forEach([...owed.keys()], give, { discard: true }),
  );

  const giveOwed = (threadId: ThreadId) => give(threadId);

  const resumeAtBoot = (thread: Thread) =>
    Effect.gen(function* () {
      const change = thread.sessionSwitch;
      if (change === undefined) return;
      if (
        thread.role === "orchestrator" &&
        (change.phase !== "ready" || change.handoff === undefined)
      )
        return;
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
        if (change.handoff !== undefined && change.handoff.delivered === undefined) {
          owed.set(thread.id, change.id);
          return;
        }
        if ((yield* dividerOf(thread.id, dividerKey(change))) === undefined)
          yield* markTranscript(
            thread.id,
            dividerKey(change),
            change.previous,
            change.target,
            change.source?.agentSessionId,
            {
              noteMode: change.handoff?.note ?? "none",
              ...(change.handoff?.limit === undefined
                ? {}
                : { limit: change.handoff.limit.reason }),
              ...(change.handoff?.text === undefined
                ? {}
                : { note: { text: change.handoff.text, by: change.previous.agent } }),
            },
          );
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

  const switchNotePlan: ThreadRuntimesShape["switchNotePlan"] = (threadId, wanted) =>
    Effect.gen(function* () {
      const rt = yield* getRuntime(threadId);
      const thread = yield* store.getThread(threadId);
      const until = yield* limitedUntil(thread);
      return yield* locked(
        rt,
        store
          .getThread(threadId)
          .pipe(Effect.map((current) => noteModeOf(rt, current, until, wanted))),
      );
    });

  return {
    switchAgent,
    resumeAtBoot,
    handOverOwed,
    giveOwed,
    onTurnEnd,
    switchNotePlan,
    handOverSwitch: give,
  };
};
