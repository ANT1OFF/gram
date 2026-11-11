import { type ToolAudience, type OutwardGate, dreamSupportFor } from "@gram/agents";
import type { PermissionMode, Thread } from "@gram/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import type { ThreadRuntimesShape } from "./thread-runtimes-shape.ts";

/** What a thread's role adds to every agent session it opens. */
export interface SessionPolicy {
  /** Which app tools the thread is bound. */
  readonly audience: ToolAudience;
  /** Standing instructions for the agent's system prompt, passed again at every open. */
  readonly instructions?: string | undefined;
  /**
   * What the session asks the user about before it leaves the machine, whatever rules and mode
   * say: `all` a push and a new PR too, `irreversible` only what can't be taken back (merging or
   * closing a PR, a release, a workflow run, a force push). `undefined` asks about nothing. Fixed
   * when the session opens, so changing it takes a `reloadSession`.
   */
  readonly outwardGate: OutwardGate | undefined;
  /**
   * Keep the session's unprompted writes inside its cwd (`OpenSessionOptions.confineWrites`): a
   * dream's, which reads transcripts nobody vetted. Fixed when the session opens, like the gate.
   */
  readonly confineWrites?: boolean | undefined;
  /** Keep the agent's shell in the thread's folder (`OpenSessionOptions.pinCwd`). */
  readonly pinCwd?: boolean | undefined;
  /** The only MCP servers beside Gram's own (`OpenSessionOptions.mcpAllowlist`). */
  readonly mcpAllowlist?: ReadonlyArray<string> | undefined;
  /** MCP servers the session leaves out (`OpenSessionOptions.mcpDenylist`). */
  readonly mcpDenylist?: ReadonlyArray<string> | undefined;
  /** None of the user's servers without tool search (`OpenSessionOptions.mcpNoneWithoutToolSearch`). */
  readonly mcpNoneWithoutToolSearch?: boolean | undefined;
  /** Leave out the agent's blocking ask tool (`OpenSessionOptions.noBlockingAsk`). */
  readonly noBlockingAsk?: boolean | undefined;
  /** Send to the user's sessions outside Gram (`OpenSessionOptions.peerMessaging`). */
  readonly peerMessaging?: boolean | undefined;
}

/**
 * Asked with the runtime lock held, each time a session opens, so `forThread` must not call a
 * `ThreadRuntimes` method that takes that thread's lock (`send`, `status`, `setMode`…). Reading the
 * store is fine. If it dies the session opens as a plain thread with the outward gate on.
 */
export interface SessionPolicyPort {
  forThread(thread: Thread): Effect.Effect<SessionPolicy>;
  /**
   * Told once per session open, as the thread stands then (its mode is the one the session opens
   * in), under the same lock rules as `forThread`. Not called for `audienceOf`'s lookups.
   */
  opening?(thread: Thread): Effect.Effect<void>;
  /**
   * A switch's new session confirmed and runs in `thread.mode`, as it reported: the mode it should
   * run in instead before the switch lets queued input go, or `undefined` to keep it. Under the
   * same lock rules as `forThread`; the switch applies the answer itself.
   */
  modeAfterSwitch?(thread: Thread): Effect.Effect<PermissionMode | undefined>;
}

export const PLAIN_POLICY: SessionPolicy = { audience: "plain", outwardGate: undefined };

/** What a thread's session policy reads beside the policy port. */
export interface SessionPolicyDeps {
  readonly store: ThreadStoreShape;
}

/**
 * The session policy `setSessionPolicy` installs, and what it makes of each thread. Until one is
 * installed every thread is plain.
 */
export const makeSessionPolicy = ({ store }: SessionPolicyDeps) => {
  let sessionPolicy: SessionPolicyPort | undefined;
  /** Policy failure keeps strict gates, guided native approvals, and every Dream's bounded bridge. */
  const policyFor = (thread: Thread): Effect.Effect<SessionPolicy> =>
    sessionPolicy === undefined
      ? Effect.succeed(PLAIN_POLICY)
      : sessionPolicy.forThread(thread).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("session policy failed").pipe(
              Effect.annotateLogs({ threadId: thread.id, cause: Cause.pretty(cause) }),
              Effect.as<SessionPolicy>({
                audience: "plain",
                outwardGate:
                  thread.role === "dream" &&
                  dreamSupportFor(thread.model.agent, { kind: "implementation" }).mode === "guided"
                    ? undefined
                    : "all",
                ...(thread.role === "dream" ? { confineWrites: true } : {}),
              }),
            ),
          ),
        );

  /** A session of `thread` is opening; a failing port changes nothing about the open. */
  const opening = (thread: Thread): Effect.Effect<void> =>
    sessionPolicy?.opening === undefined
      ? Effect.void
      : sessionPolicy
          .opening(thread)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("session policy opening hook failed").pipe(
                Effect.annotateLogs({ threadId: thread.id, cause: Cause.pretty(cause) }),
              ),
            ),
          );

  /** The mode a switch's confirmed session moves to before its release; none if the port fails. */
  const modeAfterSwitch = (thread: Thread): Effect.Effect<PermissionMode | undefined> =>
    sessionPolicy?.modeAfterSwitch === undefined
      ? Effect.succeed(undefined)
      : sessionPolicy
          .modeAfterSwitch(thread)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("session policy switch mode hook failed").pipe(
                Effect.annotateLogs({ threadId: thread.id, cause: Cause.pretty(cause) }),
                Effect.as(undefined),
              ),
            ),
          );

  const methods: Pick<ThreadRuntimesShape, "setSessionPolicy" | "audienceOf"> = {
    setSessionPolicy: (port) =>
      Effect.sync(() => {
        sessionPolicy = port;
      }),
    audienceOf: (threadId) =>
      store.getThread(threadId).pipe(
        Effect.flatMap((thread) =>
          thread.role === "dream"
            ? Effect.succeed("dream" as const)
            : Effect.map(policyFor(thread), (policy) => policy.audience),
        ),
        Effect.orElseSucceed((): ToolAudience => "plain"),
      ),
  };

  return { policyFor, opening, modeAfterSwitch, methods };
};

/** What `makeSessionPolicy` gives the rest of `ThreadRuntimes`. */
export type SessionPolicies = ReturnType<typeof makeSessionPolicy>;
