// When a session restarts on its own: an MCP config change it reads, once it is at rest.

import {
  type AgentUnavailable,
  type ThreadId,
  type McpTarget,
  mcpTargetOf,
  type ThreadStatus,
  type GramUIMessage,
  type AgentKind,
  type ProfileId,
  type SessionRestartReason,
  type Thread,
  InvalidState,
  restartOnMcpChangeOn,
  effectiveCheckout,
} from "@gram/contracts";
import { samePath } from "@gram/git";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Clock from "effect/Clock";
import * as FiberMap from "effect/FiberMap";
import { type Runtime, locked, type GetRuntime } from "./runtime-state.ts";
import type { AgentHosts } from "./agent-hosts.ts";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import type { EventHubShape } from "../events/event-hub.ts";
import type { Dispatch } from "./runtime-observer.ts";
import type { TurnLifecycle } from "./turn-lifecycle.ts";
import type * as Semaphore from "effect/Semaphore";
import { missingThreadFolder } from "../fs/folders.ts";
import type { ThreadRuntimesShape } from "./thread-runtimes-shape.ts";
import type { CheckoutServiceShape } from "./hooks.ts";

/** A change to an agent's own MCP config, as `mcpConfigChanged` takes it. */
export interface McpConfigChange {
  readonly agent: McpTarget;
  /** The project folder, for a change only sessions running there read; absent reaches them all. */
  readonly folder?: string | undefined;
  /** Only these threads, of those it reaches: the ones a live fix didn't reach. */
  readonly threads?: ReadonlyArray<ThreadId> | undefined;
  /** Threads it reaches that have the change already, reloaded live. */
  readonly except?: ReadonlyArray<ThreadId> | undefined;
  /**
   * Restart whatever `agents.restartOnMcpChange` says: the change is to these threads' own setup,
   * such as their workspace's connector set, which the user changed for them.
   */
  readonly always?: boolean | undefined;
}

/** Whether the session of a thread on `agent`, running in `folder`, reads what `change` touched. */
export const mcpChangeReaches = (
  change: McpConfigChange,
  session: { readonly threadId: ThreadId; readonly agent: string; readonly folder: string },
) =>
  mcpTargetOf(session.agent) === change.agent &&
  (change.folder === undefined || samePath(change.folder, session.folder)) &&
  (change.threads === undefined || change.threads.includes(session.threadId)) &&
  !(change.except ?? []).includes(session.threadId);

/** What `restartReady` reads of a thread's runtime. */
export interface RestartReadiness {
  readonly status: ThreadStatus;
  readonly hasSession: boolean;
  /** A reopen, close or `whileAtRest` has the session, or a reopen waits for the next idle. */
  readonly busyElsewhere: boolean;
  readonly turnOpen: boolean;
  /** Queued items, the launch and system deliveries still to go. */
  readonly waiting: number;
  readonly backgroundTasks: number;
  readonly subagentsRunning: boolean;
  readonly openRequests: number;
}

/**
 * Whether a session marked to restart on its own may go now: at rest with nothing left to run,
 * since a restart stops whatever the session still has going. `error` is a turn that failed, at
 * rest too.
 */
export const restartReady = (rt: RestartReadiness) =>
  rt.hasSession &&
  (rt.status === "idle" || rt.status === "error") &&
  !rt.busyElsewhere &&
  !rt.turnOpen &&
  rt.waiting === 0 &&
  rt.backgroundTasks === 0 &&
  !rt.subagentsRunning &&
  rt.openRequests === 0;

/** A message that is only a `session-restart` divider, which no agent message stands behind. */
export const isRestartMarker = (message: GramUIMessage) =>
  message.parts.length > 0 && message.parts.every((part) => part.type === "data-session-restart");

/**
 * How long a pending restart holds off once the last background task ends: the agent may start a
 * turn to report on it, and Claude's starts about 30 ms after the task leaves its list
 * (`p14-background-shells.jsonl`), when the thread still looks at rest.
 */
export const BACKGROUND_SETTLE = Duration.seconds(5);

/** What restarting or reopening a session reads and changes beside a thread's `Runtime`. */
export interface SessionRestartsDeps {
  readonly store: ThreadStoreShape;
  readonly hub: EventHubShape;
  readonly hosts: AgentHosts["Service"];
  readonly runtimes: ReadonlyMap<ThreadId, Runtime>;
  readonly dispatch: Dispatch;
  readonly reopens: FiberMap.FiberMap<ThreadId>;
  readonly setStatus: TurnLifecycle["setStatus"];
  readonly stopSession: TurnLifecycle["stopSession"];
  readonly failUnavailable: TurnLifecycle["failUnavailable"];
  readonly openSession: (
    rt: Runtime,
    thread: Thread,
    resumeAt?: string,
    switchAttempt?: string,
  ) => Effect.Effect<void, AgentUnavailable>;
}

/** A session's restart once it is at rest, and the reopen a changed checkout or model waits for. */
export const makeSessionRestarts = ({
  store,
  hub,
  hosts,
  runtimes,
  dispatch,
  reopens,
  setStatus,
  stopSession,
  failUnavailable,
  openSession,
}: SessionRestartsDeps) => {
  /** Has the agent's host drop what it keeps across sessions for `profileId`: `AgentHost.reloadConfig`. */
  const reloadHostConfig = (agent: AgentKind, profileId: ProfileId | undefined) =>
    hosts.get(agent).pipe(
      Effect.option,
      Effect.flatMap((host) =>
        Option.isSome(host) && host.value.reloadConfig !== undefined
          ? host.value.reloadConfig(profileId)
          : Effect.void,
      ),
    );

  /** Called with the runtime lock held. */
  const setPendingRestart = (rt: Runtime, reason: SessionRestartReason | undefined) =>
    Effect.suspend(() => {
      if (rt.pendingRestart === reason) return Effect.void;
      rt.pendingRestart = reason;
      return hub.publish({
        type: "thread.pendingRestart",
        threadId: rt.threadId,
        ...(reason === undefined ? {} : { reason }),
      });
    });

  /**
   * Called with the runtime lock held, wherever the thread may have come to rest: restarts a
   * session `mcpConfigChanged` marked once `restartReady` holds, by `restartSession`'s path.
   */
  const restartIfPending = (rt: Runtime): Effect.Effect<void> =>
    Effect.gen(function* () {
      const reason = rt.pendingRestart;
      if (reason === undefined) return;
      const ready = restartReady({
        status: rt.status,
        hasSession: rt.session !== undefined,
        busyElsewhere:
          rt.reopening || rt.reopenOnIdle || rt.closing || rt.reserved || rt.agentRunning,
        turnOpen: rt.turn !== undefined,
        waiting: rt.queue.length + rt.deliveries.size + (rt.launch === undefined ? 0 : 1),
        backgroundTasks: rt.background.length,
        subagentsRunning: rt.activity.subagentsRunning,
        openRequests: 0,
      });
      if (!ready || (yield* store.listRequests(rt.threadId)).length > 0) return;
      const now = yield* Clock.currentTimeMillis;
      if (
        rt.tasksEndedAt !== undefined &&
        now - rt.tasksEndedAt < Duration.toMillis(BACKGROUND_SETTLE)
      ) {
        return;
      }
      // A policy change during an open may still need a restart on the child acquired after the
      // initial invalidation. Retire that current child before closing this session's hold;
      // held siblings keep it alive, and this restart waits for its owning exit.
      if (rt.session?.configCurrent !== undefined && (yield* rt.session.configCurrent)) {
        const thread = yield* store.getThread(rt.threadId).pipe(Effect.orDie);
        const owner = rt.session.configOwner;
        yield* reloadHostConfig(thread.model.agent, thread.model.profileId);
        // Some siblings may already have consumed the pending edit on this fresh child. Mark
        // only its exact holders again, outside our lock, so they release it once safely idle.
        if (owner !== undefined) {
          for (const sibling of runtimes.values()) {
            if (sibling === rt || sibling.session?.configOwner !== owner) continue;
            yield* dispatch(
              sibling.threadId,
              "shared config restart",
              locked(
                sibling,
                Effect.gen(function* () {
                  if (
                    sibling.closing ||
                    sibling.status === "ended" ||
                    sibling.session?.configOwner !== owner
                  )
                    return;
                  yield* setPendingRestart(sibling, "mcpConfig");
                  yield* restartIfPending(sibling);
                }),
              ),
            );
          }
        }
      }
      yield* setPendingRestart(rt, undefined);
      rt.restartMarker = reason;
      yield* reopenNow(rt);
    });

  /**
   * Called with the runtime lock held. Reopens the session so it picks up a new checkout or granted
   * folders, resuming the conversation; mid-turn it waits for the next idle.
   */
  const reopenWhenIdle = (rt: Runtime): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (rt.session === undefined) {
        rt.reopenOnIdle = false;
        return;
      }
      if (rt.status !== "idle" || rt.turn !== undefined) {
        rt.reopenOnIdle = true;
        return;
      }
      yield* reopenNow(rt);
    });

  /**
   * Called with the runtime lock held, on a live session with no turn open. Closes the session and
   * opens it again on the same conversation, reading the thread as it is then.
   */
  const reopenNow = (rt: Runtime): Effect.Effect<void> =>
    Effect.gen(function* () {
      rt.reopenOnIdle = false;
      rt.reopening = true;
      // Sends queue while `starting`, and go out once the reopened session is idle.
      yield* setStatus(rt, "starting");
      yield* FiberMap.run(
        reopens,
        rt.threadId,
        Effect.gen(function* () {
          yield* stopSession(rt, "recover");
          yield* locked(
            rt,
            Effect.gen(function* () {
              // A close that began meanwhile has the session; it would outlive the thread.
              if (rt.closing) return;
              const thread = yield* store.getThread(rt.threadId).pipe(Effect.orDie);
              yield* openSession(rt, thread).pipe(
                Effect.catchTag("AgentUnavailable", (e) => failUnavailable(rt, e)),
              );
            }),
          );
        }).pipe(
          // Set back by the new session's install; this covers a reopen that never got that far.
          Effect.ensuring(
            Effect.sync(() => {
              if (rt.session === undefined) rt.reopening = false;
            }),
          ),
        ),
      );
    });

  return { reloadHostConfig, setPendingRestart, restartIfPending, reopenWhenIdle, reopenNow };
};

/** What `makeSessionRestarts` gives the rest of `ThreadRuntimes`. */
export type SessionRestarts = ReturnType<typeof makeSessionRestarts>;

/** What the restart `ThreadRuntimes` methods read beside the restarts themselves. */
export interface RestartMethodsDeps {
  readonly store: ThreadStoreShape;
  readonly hub: EventHubShape;
  readonly checkouts: CheckoutServiceShape;
  readonly hosts: AgentHosts["Service"];
  readonly runtimes: ReadonlyMap<ThreadId, Runtime>;
  readonly getRuntime: GetRuntime;
  readonly sessions: FiberMap.FiberMap<ThreadId>;
  readonly switchGenerations: ReadonlyMap<ThreadId, string>;
  readonly switchConfigLock: Semaphore.Semaphore;
  readonly reloadHostConfig: SessionRestarts["reloadHostConfig"];
  readonly setPendingRestart: SessionRestarts["setPendingRestart"];
  readonly restartIfPending: SessionRestarts["restartIfPending"];
  readonly reopenWhenIdle: SessionRestarts["reopenWhenIdle"];
  readonly reopenNow: SessionRestarts["reopenNow"];
  readonly setStatus: TurnLifecycle["setStatus"];
  readonly stopSession: TurnLifecycle["stopSession"];
  readonly failUnavailable: TurnLifecycle["failUnavailable"];
  readonly publishUpsert: TurnLifecycle["publishUpsert"];
  readonly openSession: (
    rt: Runtime,
    thread: Thread,
    resumeAt?: string,
    switchAttempt?: string,
  ) => Effect.Effect<void, AgentUnavailable>;
  readonly interrupt: ThreadRuntimesShape["interrupt"];
}

/** The `ThreadRuntimes` methods that reload, restart, start or replace a thread's session. */
export const makeRestartMethods = ({
  store,
  hub,
  checkouts,
  hosts,
  runtimes,
  getRuntime,
  sessions,
  switchGenerations,
  switchConfigLock,
  reloadHostConfig,
  setPendingRestart,
  restartIfPending,
  reopenWhenIdle,
  reopenNow,
  setStatus,
  stopSession,
  failUnavailable,
  publishUpsert,
  openSession,
  interrupt,
}: RestartMethodsDeps): Pick<
  ThreadRuntimesShape,
  "mcpConfigChanged" | "reloadSession" | "restartSession" | "startSession" | "freshSession"
> => ({
  reloadSession: (threadId) =>
    Effect.gen(function* () {
      const generation = switchGenerations.get(threadId);
      const rt = yield* getRuntime(threadId);
      return yield* locked(
        rt,
        Effect.gen(function* () {
          if (
            switchGenerations.get(threadId) !== generation ||
            (yield* store.getThread(threadId)).sessionSwitch !== undefined
          )
            return "noSession" as const;
          if (rt.session === undefined) {
            // An open in flight read its policy before this change: it reopens at its first idle.
            if (!rt.closing && (rt.status === "starting" || rt.reopening)) {
              rt.reopenOnIdle = true;
              return "reopening" as const;
            }
            return "noSession" as const;
          }
          yield* reopenWhenIdle(rt);
          return "reopening" as const;
        }),
      );
    }),
  restartSession: (threadId, midTurn = "afterTurn") =>
    Effect.gen(function* () {
      const rt = yield* getRuntime(threadId);
      const refuse = (message: string) =>
        new InvalidState({ message, threadId, status: rt.status });
      /** Asked first and again under the lock, so a refusal leaves the host's cache alone. */
      const refusal = () =>
        rt.closing || rt.status === "ended"
          ? refuse("the thread is closed")
          : rt.status === "starting" || rt.reopening
            ? refuse("the session is still starting; restart it once it is up")
            : rt.reserved
              ? refuse("its worktree is being worked on")
              : undefined;
      const early = refusal();
      if (early !== undefined) return yield* early;
      const generation = switchGenerations.get(threadId);
      const before = yield* store.getThread(threadId);
      if (before.sessionSwitch !== undefined)
        return yield* refuse("An orchestrator switch owns this session. Review its status first.");
      if (!(yield* checkouts.present(before.checkout.path))) {
        return yield* refuse(missingThreadFolder(before.checkout.path));
      }
      // Before the session stops, so the one that opens next is the first to find the host
      // without what it kept: a shared server, the resolved executable.
      const next = yield* locked(
        rt,
        Effect.gen(function* () {
          const refused = refusal();
          if (refused !== undefined) return yield* refused;
          if (
            switchGenerations.get(threadId) !== generation ||
            (yield* store.getThread(threadId)).sessionSwitch !== undefined
          )
            return yield* refuse(
              "The orchestrator changed while this restart waited. Review its current session and try again.",
            );
          yield* reloadHostConfig(before.model.agent, before.model.profileId);
          // This restart reads the config as it is now, which is all a pending one waits for.
          yield* setPendingRestart(rt, undefined);
          if (rt.session === undefined) {
            const thread = yield* store.getThread(threadId);
            const conversation =
              (thread.agentSessionId !== undefined && thread.agentSessionUnused !== true) ||
              thread.forkedFrom !== undefined;
            if (!conversation) return "noSession" as const;
            rt.restartMarker = "asked";
            yield* openSession(rt, thread).pipe(
              Effect.catchTag("AgentUnavailable", (e) => failUnavailable(rt, e)),
            );
            return "restarting" as const;
          }
          rt.restartMarker = "asked";
          // At rest after a failed turn the session is `error` with nothing open: as good as idle.
          if (rt.turn === undefined && (rt.status === "idle" || rt.status === "error")) {
            yield* reopenNow(rt);
            return "restarting" as const;
          }
          rt.reopenOnIdle = true;
          return midTurn === "interrupt" ? ("interrupt" as const) : ("afterTurn" as const);
        }),
      );
      if (next !== "interrupt") return next;
      // The turn ends as interrupted, and its end reopens the session (`becomeIdle`).
      yield* interrupt(threadId);
      return "restarting" as const;
    }),
  startSession: (threadId) =>
    Effect.gen(function* () {
      const rt = yield* getRuntime(threadId);
      const refuse = (message: string) =>
        new InvalidState({ message, threadId, status: rt.status });
      const before = yield* store.getThread(threadId);
      // Dreams read unvetted transcripts and run only as their pass opens them.
      if (before.role === "dream") return yield* refuse("a dream's session opens only for its run");
      if (!(yield* checkouts.present(before.checkout.path))) {
        return yield* refuse(missingThreadFolder(before.checkout.path));
      }
      return yield* locked(
        rt,
        Effect.gen(function* () {
          if (rt.closing || rt.status === "ended") return yield* refuse("the thread is closed");
          if (rt.session !== undefined || rt.status === "starting" || rt.reopening) {
            return "open" as const;
          }
          if (rt.reserved) return yield* refuse("its worktree is being worked on");
          // The session's first idle would send it: a turn, which this open must never be.
          if (rt.queue.length > 0 || rt.launch !== undefined) {
            return yield* refuse("a message waits to be sent; sending it starts the session");
          }
          const thread = yield* store.getThread(threadId);
          if (thread.parked) return yield* refuse("the thread is archived");
          yield* openSession(rt, thread).pipe(
            Effect.catchTag("AgentUnavailable", (e) => failUnavailable(rt, e)),
          );
          return "starting" as const;
        }),
      );
    }),
  mcpConfigChanged: (change) =>
    switchConfigLock.withPermits(1)(
      Effect.gen(function* () {
        if (change.always !== true && !restartOnMcpChangeOn(yield* store.getSettings)) return [];
        // A host-wide invalidation also retires siblings, so don't touch either switch harness.
        const held = (yield* store.listThreads).find(
          (thread) =>
            thread.sessionSwitch !== undefined &&
            (thread.sessionSwitch.previous.agent === change.agent ||
              thread.sessionSwitch.target.agent === change.agent),
        );
        if (held !== undefined) {
          yield* hub.publish({
            type: "notify",
            kind: "info",
            threadId: held.id,
            title: "Session refresh waits for the orchestrator switch",
            body: "Your configuration was saved. Retry session refresh once the orchestrator switch is resolved.",
          });
          return [];
        }
        const reached: Array<{ readonly rt: Runtime; readonly thread: Thread }> = [];
        // A copy: the loop yields, and a thread created meanwhile reads the new config anyway.
        for (const rt of Array.from(runtimes.values())) {
          // A cold thread opens on the config as it is then; a starting one may have read the old.
          const live = rt.session !== undefined || rt.reopening || rt.status === "starting";
          if (!live || rt.closing || rt.status === "ended") continue;
          const thread = yield* store.getThread(rt.threadId).pipe(Effect.option);
          if (Option.isNone(thread)) continue;
          const agent = rt.agent ?? thread.value.model.agent;
          const folder = effectiveCheckout(thread.value).path;
          if (!mcpChangeReaches(change, { threadId: rt.threadId, agent, folder })) continue;
          reached.push({ rt, thread: thread.value });
        }
        // Once, before any of them reopens: Codex's sessions share a server per
        // profile, and each would otherwise retire the one the last restart started. Every server
        // the host keeps goes, one only cold threads were on included, or the next to open would
        // find the config it started with.
        const host = yield* hosts.get(change.agent).pipe(Effect.option);
        if (Option.isSome(host) && host.value.reloadAllConfig !== undefined) {
          yield* host.value.reloadAllConfig;
        } else {
          const profiles = new Map(
            reached.map(({ rt, thread }) => [
              `${rt.agent ?? thread.model.agent}:${thread.model.profileId ?? ""}`,
              [rt.agent ?? thread.model.agent, thread.model.profileId] as const,
            ]),
          );
          for (const [agent, profileId] of profiles.values()) {
            yield* reloadHostConfig(agent, profileId);
          }
        }
        for (const { rt } of reached) {
          yield* locked(
            rt,
            Effect.gen(function* () {
              yield* setPendingRestart(rt, "mcpConfig");
              yield* restartIfPending(rt);
            }),
          );
        }
        if (reached.length > 0) {
          yield* Effect.logInfo("sessions restart once idle for an MCP config change").pipe(
            Effect.annotateLogs({ agent: change.agent, threads: reached.length }),
          );
        }
        return reached.map(({ rt }) => rt.threadId);
      }),
    ),
  freshSession: (threadId) =>
    Effect.gen(function* () {
      const rt = yield* getRuntime(threadId);
      const before = yield* locked(
        rt,
        Effect.gen(function* () {
          const thread = yield* store.getThread(threadId);
          if (thread.sessionSwitch !== undefined)
            return yield* new InvalidState({
              threadId,
              message: "Resolve the orchestrator switch before starting a fresh session.",
            });
          const refuse = (message: string) =>
            new InvalidState({ message, threadId, status: rt.status });
          if (rt.closing) return yield* refuse("the thread is closing");
          const free = rt.status === "idle" || rt.status === "cold" || rt.status === "error";
          if (rt.turn !== undefined || !free) {
            return yield* refuse("a fresh session has to wait until the agent is idle");
          }
          if (thread.forkedFrom !== undefined) {
            return yield* refuse("a fork reopens from its source, so it can't start afresh");
          }
          // As in `reopenWhenIdle`: sends queue while `starting`, so none reaches the session
          // that is about to stop, and they go out once the new one is idle.
          yield* setStatus(rt, "starting");
          return thread;
        }),
      );
      // The rewind-to-the-first-message path, without the truncation: stop, forget the session,
      // open. With no `agentSessionId` and no `forkedFrom`, `resumeOptions` resumes nothing.
      yield* stopSession(rt, "rewind");
      yield* locked(
        rt,
        Effect.gen(function* () {
          // A close that began meanwhile has the session; it would outlive the thread.
          if (rt.closing) return;
          const thread = yield* store.updateThread(threadId, (t) => {
            const { agentSessionId, agentSessionUnused, codexHome, ...rest } = t;
            void agentSessionId;
            void agentSessionUnused;
            void codexHome;
            return rest;
          });
          yield* publishUpsert(thread);
          // The context meter was the old session's; the first turn of the new one refills it.
          rt.usage = undefined;
          yield* openSession(rt, thread).pipe(
            Effect.catchTag("AgentUnavailable", (e) => failUnavailable(rt, e)),
          );
        }),
      );
      return before.agentSessionId;
    }).pipe(
      Effect.onError(() =>
        Effect.suspend(() => {
          const rt = runtimes.get(threadId);
          if (rt === undefined) return Effect.void;
          return locked(
            rt,
            Effect.gen(function* () {
              if (
                !rt.closing &&
                rt.status === "starting" &&
                !FiberMap.hasUnsafe(sessions, threadId)
              )
                yield* setStatus(rt, "cold");
            }),
          );
        }),
      ),
    ),
});
