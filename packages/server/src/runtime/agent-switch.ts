// Moving any thread to the other agent: the checks a target has to pass, the refusals of a thread
// that can't move now, and the switch itself, which claims the thread, stops its session, opens one
// on the target with no memory of the old one, marks the transcript and lets the queue go.

import {
  aboveHigh,
  effectiveCheckout,
  InvalidState,
  isLocalHost,
  type AgentKind,
  type Handoff,
  type ModelRef,
  type PermissionMode,
  type Thread,
  type ThreadId,
  type ThreadNotFound,
} from "@gram/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Option from "effect/Option";
import { randomUUID } from "node:crypto";
import type { AgentHosts } from "./agent-hosts.ts";
import { selectableModels } from "./model-efforts.ts";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import { locked, type GetRuntime, type Runtime } from "./runtime-state.ts";
import type { ThreadRuntimesShape } from "./thread-runtimes-shape.ts";
import { sessionIdentity } from "./session-switch.ts";
import type { EventHub } from "../events/event-hub.ts";

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
  if (rt.turn !== undefined || rt.reopening || (rt.status !== "idle" && rt.status !== "cold"))
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
    | "updateThread"
  >;
  /** Lets the queue the switch held go to the new session. */
  readonly afterRelease: (rt: Runtime) => Effect.Effect<void>;
}

/** `switchAgent`, and the boot sweep of the switches a restart cut off. */
export const makeAgentSwitch = ({
  store,
  hosts,
  hub,
  getRuntime,
  switches,
  refuseMissingFolder,
  runtimes,
  afterRelease,
}: AgentSwitchDeps) => {
  /** The divider, once per attempt: messages above it can't be rewound or forked to. */
  const markTranscript = (
    threadId: ThreadId,
    attemptId: string,
    previous: ModelRef,
    agentSessionId?: string,
  ) =>
    Effect.gen(function* () {
      const data: Handoff = {
        reason: "switch",
        switchId: attemptId,
        previousAgent: previous.agent,
        ...(agentSessionId === undefined ? {} : { previousAgentSessionId: agentSessionId }),
        at: yield* Clock.currentTimeMillis,
      };
      yield* runtimes
        .emitChunk(threadId, { type: "data-handoff", id: randomUUID(), data })
        .pipe(Effect.ignore);
    });

  /** The switch past its claim: stop, open on the target, mark, release. */
  const run = (threadId: ThreadId, attemptId: string, previous: ModelRef) =>
    Effect.gen(function* () {
      const replaced = yield* runtimes.switchSession(threadId, attemptId);
      yield* markTranscript(threadId, attemptId, previous, replaced);
      yield* runtimes.releaseSwitch(threadId, attemptId);
      yield* afterRelease(yield* getRuntime(threadId));
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

  const switchAgent: ThreadRuntimesShape["switchAgent"] = (threadId, target) =>
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
      const why = yield* locked(
        rt,
        Effect.gen(function* () {
          const current = yield* store.getThread(threadId);
          return notNow(rt, current, target, (yield* store.listRequests(threadId)).length);
        }),
      );
      if (why !== undefined) return yield* new InvalidState({ threadId, message: why });
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
      yield* FiberMap.run(switches, threadId, run(threadId, id, thread.model));
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
        if (!marked) yield* markTranscript(thread.id, change.id, change.previous);
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

  return { switchAgent, resumeAtBoot };
};
