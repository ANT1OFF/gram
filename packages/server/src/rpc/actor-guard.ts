import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import { ServerConfig } from "../config.ts";
import { actorOf } from "../http/actor.ts";
import type { Actor, FrontedIdentityConfig } from "../http/fronted-identity.ts";
import { ThreadStore, type ActorEventEntry } from "../persistence/thread-store.ts";
import { embeddingEnabled } from "../settings/embedding.ts";

/**
 * Whether people sign in through a fronting proxy (`http/fronted-identity.ts`): configured by the
 * environment and used only while the hosted features setting (`experimental.embedding`) is on.
 * `active` is asked per request; off, the server is exactly the one that takes the launch token.
 */
export class FrontedSignIn extends Context.Service<
  FrontedSignIn,
  {
    readonly config: FrontedIdentityConfig | undefined;
    readonly active: Effect.Effect<boolean>;
  }
>()("@gram/server/FrontedSignIn") {
  /** As the environment configures it, while the hosted features setting is on. */
  static readonly layer = Layer.effect(
    FrontedSignIn,
    Effect.gen(function* () {
      const { frontedIdentity: config } = yield* ServerConfig;
      if (config === undefined) return { config, active: Effect.succeed(false) };
      const store = yield* ThreadStore;
      // Asked on every request and call, so read at most every two seconds.
      const active = yield* Effect.cachedWithTTL(
        Effect.provideService(embeddingEnabled, ThreadStore, store),
        "2 seconds",
      );
      return { config, active };
    }),
  );
  /** No fronting proxy: the launch token as ever. */
  static readonly off = Layer.succeed(FrontedSignIn, {
    config: undefined,
    active: Effect.succeed(false),
  });
}

/**
 * What a viewer may call: reads of what the workspace shows. Everything else is refused, so an
 * RPC added later is closed to viewers until it is named here. Left out on purpose, though they
 * read: anything that browses the machine outside a thread's folders (`fs.browse`, `fs.tree`,
 * `fs.list`, `fs.files`, `sessions.*`), terminals, connector and gateway configuration,
 * diagnostics, and reads that spend model usage (`thread.recap`, `thread.whyStuck`).
 */
export const VIEWER_RPCS: ReadonlySet<string> = new Set([
  "events.subscribe",
  "thread.subscribe",
  "thread.history",
  "thread.search",
  "thread.listWaits",
  "thread.suggestions",
  "threads.closed.list",
  "threads.wakes",
  "attachment.read",
  "settings.get",
  "keybindings.get",
  "labels.list",
  "palettes.list",
  "models.list",
  "projects.list",
  "workspace.list",
  "workspace.outputs",
  "docs.list",
  "docs.read",
  "memory.list",
  "memory.read",
  "memory.versions",
  "dream.list",
  "routine.list",
  "orchestrator.ledger",
  "orchestrator.watchLedger",
  "orchestrator.featureCards",
  "orchestrator.watchFeatureCards",
  "orchestrator.featureSummary",
  "orchestrator.finishedWorker",
  "orchestrator.finishedWorkers",
  "orchestrator.finishedWorkersPage",
  "git.diff",
  "git.diffChunk",
  "git.branches",
  "git.baseStatus",
  "git.upstreamStatus",
  "git.prChecks",
  "git.prDetail",
  "pr.status",
  "pr.labels.list",
  "openPrs.list",
  "reviewRequests.list",
  "worktree.list",
  "worktree.status",
  "fs.file",
  "fs.image",
  "fs.preview",
  "fs.search",
  "app.usageOverview",
  "app.usageLimitHistory",
]);

/**
 * A member's calls that go unrecorded: reads kept from viewers (see {@link VIEWER_RPCS}), what a
 * window reports of itself, what the composer keeps while someone types, and a terminal's
 * keystrokes, whose opening is recorded. Every other call outside {@link VIEWER_RPCS} is recorded,
 * so an RPC added later is recorded until it is named here.
 */
export const UNRECORDED_RPCS: ReadonlySet<string> = new Set([
  "windows.report",
  "windows.watch",
  "helper.presence",
  "helper.recordEvent",
  "helper.status",
  "composer.drafts",
  "ui.showPanel",
  "terminal.input",
  "terminal.resize",
  "terminal.list",
  "terminal.subscribe",
  "terminal.checkShell",
  "agentRuntime.list",
  "agentRuntime.installState",
  "agentRuntime.watchInstall",
  "agentRuntime.watchUpdate",
  "agents.support",
  "app.diagnostics",
  "app.launchChecks",
  "connectors.catalogue",
  "connectors.configured",
  "connectors.list",
  "dream.automaticStatus",
  "fs.browse",
  "fs.files",
  "fs.list",
  "fs.resolve",
  "fs.tree",
  "fs.vocabulary",
  "git.prCheckDiagnostic",
  "models.suggestions",
  "palette.filters",
  "pr.mergeOptions",
  "pr.reviewerSuggestions",
  "profiles.list",
  "profiles.vaultInfo",
  "projects.cloneSuggestions",
  "projects.repositories",
  "projects.scripts",
  "sessions.list",
  "sessions.preview",
  "thread.joinTargets",
  "thread.promptHistory",
  "thread.stash.list",
  "threads.usingCheckout",
  "workspace.taskPreflight",
  "worktree.cleanupPlan",
  "worktree.pendingPermissions",
  "worktree.pendingPermissionsAt",
  "worktree.size",
  "worktree.storage",
]);

export const VIEWER_REFUSAL = "read-only: a viewer can't change anything here";
export const NO_ACTOR_REFUSAL = "unauthorized: no signed-in person on this call";

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;

/** The leaves of a settings patch as dotted paths: which settings, never their values. */
const patchPaths = (patch: unknown, prefix = "", out: string[] = []): string[] => {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    if (prefix !== "") out.push(prefix);
    return out;
  }
  for (const [key, value] of Object.entries(patch)) {
    if (out.length >= 64) break;
    patchPaths(value, prefix === "" ? key : `${prefix}.${key}`, out);
  }
  return out;
};

/** The ids a payload names, by the keys the RPCs use for them. */
const ID_KEYS = [
  "requestId",
  "clientMessageId",
  "itemId",
  "taskId",
  "questionId",
  "projectId",
  "profileId",
  "labelId",
  "paletteId",
  "feature",
  "id",
] as const;

/** A decision an answer carries (allow or deny, approve or reject), never its words. */
const answerOf = (answer: unknown): Record<string, unknown> => {
  if (typeof answer !== "object" || answer === null) return {};
  const { kind, decision, scope } = answer as Record<string, unknown>;
  return {
    ...(text(kind) === undefined ? {} : { kind }),
    ...(text(decision) === undefined ? {} : { decision }),
    ...(text(scope) === undefined ? {} : { scope }),
  };
};

/**
 * What to record of a call `actor` made: one entry, or one per answer for `thread.respondMany`.
 * Only what identifies the thing acted on is kept. The actor's id is the proxy's stable id for the
 * person, so a thread's entries say who started it (`thread.create`) and who acted in it since.
 */
export const actorEventsOf = (
  actor: Actor,
  action: string,
  payload: unknown,
  at: number,
  result?: unknown,
): ReadonlyArray<ActorEventEntry> => {
  const fields =
    typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
  const entry = (source: Record<string, unknown>, data: Record<string, unknown>) => ({
    at,
    actor: { id: actor.id, name: actor.name, role: actor.role },
    action,
    // A thread a call made is known by what the call answered, so who started it is on record.
    threadId:
      text(source["threadId"]) ??
      (action === "thread.create" && typeof result === "object" && result !== null
        ? text((result as Record<string, unknown>)["id"])
        : undefined),
    workspaceId: text(source["workspaceId"]),
    data: {
      ...Object.fromEntries(
        ID_KEYS.flatMap((key) => (text(source[key]) === undefined ? [] : [[key, source[key]]])),
      ),
      ...data,
    },
  });
  if (action === "thread.respondMany" && Array.isArray(fields["answers"])) {
    return (fields["answers"] as ReadonlyArray<unknown>).flatMap((item) =>
      typeof item === "object" && item !== null
        ? [
            entry(item as Record<string, unknown>, {
              answer: answerOf((item as Record<string, unknown>)["answer"]),
            }),
          ]
        : [],
    );
  }
  if ("answer" in fields) return [entry(fields, { answer: answerOf(fields["answer"]) })];
  if (action === "settings.set") return [entry(fields, { settings: patchPaths(fields["patch"]) })];
  return [entry(fields, {})];
};

/**
 * Applied to every RPC. With fronted sign-in off it does nothing. On, a call must carry the actor
 * the auth middleware sealed onto its connection: a viewer's is refused unless it only reads, and
 * a member's that changes something is recorded with who made it, once it has succeeded.
 */
export class ActorGuard extends RpcMiddleware.Service<ActorGuard>()("@gram/server/ActorGuard") {
  static readonly layer = Layer.effect(
    ActorGuard,
    Effect.gen(function* () {
      const fronted = yield* FrontedSignIn;
      const store = yield* ThreadStore;
      return ActorGuard.of((effect, { rpc, payload, headers }) =>
        Effect.gen(function* () {
          if (!(yield* fronted.active)) return yield* effect;
          const actor = actorOf(headers);
          if (actor === undefined) return yield* Effect.die(new Error(NO_ACTOR_REFUSAL));
          const action = rpc._tag;
          if (VIEWER_RPCS.has(action)) return yield* effect;
          if (actor.role !== "member") return yield* Effect.die(new Error(VIEWER_REFUSAL));
          if (UNRECORDED_RPCS.has(action)) return yield* effect;
          // Recorded once the call has done what it does, and not interrupted between: a change
          // that happened always has its entry, and a failed call leaves none.
          return yield* Effect.uninterruptibleMask((restore) =>
            restore(effect).pipe(
              Effect.tap((result) =>
                store.appendActorEvents(actorEventsOf(actor, action, payload, Date.now(), result)),
              ),
            ),
          );
        }),
      );
    }),
  );
}
