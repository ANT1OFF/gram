import {
  type BrowserScope,
  type BrowserSurfaces,
  type ToolAudience,
  type OutwardGate,
  dreamSupportFor,
} from "@gram/agents";
import {
  effectiveCheckout,
  hostOf,
  AgentUnavailable,
  type PermissionMode,
  type Thread,
  type ThreadId,
  type ThreadNotFound,
} from "@gram/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import { withProfile } from "../thread-profiles/policy.ts";
import type { SystemDelivery } from "./system-delivery.ts";
import { browserStatus } from "./browser-status.ts";
import { makeResumePlans } from "./history-plans.ts";
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
  /** One more MCP server, by address (`OpenSessionOptions.mcpServer`). */
  readonly mcpServer?: { readonly name: string; readonly url: string } | undefined;
  /** MCP servers the session leaves out (`OpenSessionOptions.mcpDenylist`). */
  readonly mcpDenylist?: ReadonlyArray<string> | undefined;
  /** None of the user's servers without tool search (`OpenSessionOptions.mcpNoneWithoutToolSearch`). */
  readonly mcpNoneWithoutToolSearch?: boolean | undefined;
  /** Leave out the agent's blocking ask tool (`OpenSessionOptions.noBlockingAsk`). */
  readonly noBlockingAsk?: boolean | undefined;
  /** Send to the user's sessions outside Gram (`OpenSessionOptions.peerMessaging`). */
  readonly peerMessaging?: boolean | undefined;
  /**
   * Drive the user's browser (`OpenSessionOptions.browser`): the thread was given it, or is an
   * orchestrator where `workspaces.orchestratorBrowser` is on, and its agent's consent allows.
   */
  readonly browser?: boolean | undefined;
  /** With `browser`, the surfaces it keeps (`OpenSessionOptions.browserSurfaces`); absent, all. */
  readonly browserSurfaces?: BrowserSurfaces | undefined;
  /** With `browser`, what it is limited to (`OpenSessionOptions.browserScope`); absent, no limit. */
  readonly browserScope?: BrowserScope | undefined;
  /** With `browser`, each action asks first (`OpenSessionOptions.browserAsk`). */
  readonly browserAsk?: boolean | undefined;
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
  /**
   * A role whose switch hands over through a delivery of its own: the orchestrator's boot digest,
   * which carries the note and the last exchanges with the user. The switch sends it as its handoff
   * (`SWITCH_HANDOFF_KEY`), owed, retried and released as any thread's; `undefined` for a role
   * whose new session takes the thread's handoff.
   */
  switchHandoff?(thread: Thread): Effect.Effect<SystemDelivery | undefined>;
  /**
   * Why an archived thread may not come back now, or nothing: asked before any edit that
   * unarchives one is stored, whoever makes it. Reads the store only.
   */
  reviving?(thread: Thread): Effect.Effect<string | undefined>;
  /**
   * Why no session may open for this thread where its folder is, or nothing: asked each time a
   * session opens, before `opening` is told, under the same lock rules as `forThread`.
   */
  admitting?(thread: Thread): Effect.Effect<string | undefined>;
}

/**
 * Whether the row being written is still the thread a decision was made for: the same
 * orchestrator's, with its folder on the same machine. A decision made for a row that has since
 * changed hands or moved is no decision for the row as it stands.
 */
export const sameWorkerAndMachine = (row: Thread, decided: Thread): boolean =>
  row.spawnedBy?.threadId === decided.spawnedBy?.threadId &&
  hostOf(effectiveCheckout(row)) === hostOf(effectiveCheckout(decided));

const NOT_ADMITTED = "Whether this thread may run where its folder is couldn't be decided now.";

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
  const { resumeOptions } = makeResumePlans({ store });
  let sessionPolicy: SessionPolicyPort | undefined;
  const policyFor = (thread: Thread): Effect.Effect<SessionPolicy> =>
    Effect.map(rolePolicyFor(thread), (policy) => withProfile(policy, thread));

  const rolePolicyFor = (thread: Thread): Effect.Effect<SessionPolicy> =>
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

  const admitted = (thread: Thread): Effect.Effect<void, AgentUnavailable> =>
    sessionPolicy?.admitting === undefined
      ? Effect.void
      : sessionPolicy.admitting(thread).pipe(
          Effect.catchCause(() => Effect.succeed<string | undefined>(NOT_ADMITTED)),
          Effect.flatMap((refused) =>
            refused === undefined
              ? Effect.void
              : Effect.fail(
                  new AgentUnavailable({
                    agent: thread.model.agent,
                    reason: "startup-failed",
                    message: refused,
                  }),
                ),
          ),
        );

  const opening = (thread: Thread): Effect.Effect<void, AgentUnavailable> =>
    Effect.andThen(admitted(thread), told(thread));

  const told = (thread: Thread): Effect.Effect<void> =>
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

  const switchHandoff = (thread: Thread): Effect.Effect<SystemDelivery | undefined> =>
    sessionPolicy?.switchHandoff === undefined
      ? Effect.succeed(undefined)
      : sessionPolicy.switchHandoff(thread);

  const methods: Pick<
    ThreadRuntimesShape,
    "setSessionPolicy" | "audienceOf" | "browserStatusOf"
  > & {
    /**
     * The thread as it stands, and the edit to store for it: `edit` itself, or, where it would
     * unarchive a thread the policy says may not come back (`reviving`), `edit` with the thread
     * kept archived. A policy that dies keeps it archived too, and so does a row that changed
     * hands or moved between the decision and its writing (`sameWorkerAndMachine`).
     */
    readonly unparking: (
      threadId: ThreadId,
      edit: (thread: Thread) => Thread,
    ) => Effect.Effect<readonly [Thread, (thread: Thread) => Thread], ThreadNotFound>;
  } = {
    unparking: (threadId, edit) =>
      Effect.gen(function* () {
        const before = yield* store.getThread(threadId);
        const asked = sessionPolicy?.reviving;
        if (asked === undefined || before.parked !== true || edit(before).parked === true)
          return [before, edit] as const;
        const refused = yield* asked(before).pipe(
          Effect.catchCause(() => Effect.succeed<string | undefined>("undecided")),
        );
        if (refused === undefined)
          return [
            before,
            (row: Thread) =>
              row.parked !== true || sameWorkerAndMachine(row, before)
                ? edit(row)
                : { ...edit(row), parked: true },
          ] as const;
        yield* Effect.logWarning("an archived thread was kept archived").pipe(
          Effect.annotateLogs({ threadId, reason: refused }),
        );
        return [before, (thread: Thread) => ({ ...edit(thread), parked: true })] as const;
      }),
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
    browserStatusOf: (threadId) =>
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId);
        const settings = yield* store.getSettings;
        const resume = yield* resumeOptions(thread, undefined);
        return browserStatus(thread, settings, yield* policyFor(thread), resume);
      }),
  };

  return { policyFor, opening, modeAfterSwitch, switchHandoff, methods };
};

/** What `makeSessionPolicy` gives the rest of `ThreadRuntimes`. */
export type SessionPolicies = ReturnType<typeof makeSessionPolicy>;
