import {
  type DreamId,
  effectiveCheckout,
  isPersonalSetting,
  settingsPatchPaths,
  type SettingsPatch,
  type ThreadId,
  type WorkspaceId,
} from "@gram/contracts";
import { ANSWER_OVER_HTTP } from "../embedding/answer-proof.ts";
import { ActingPerson } from "../embedding/person.ts";
import {
  anyPrivate,
  type Level,
  NOT_READABLE,
  ONLY_READS,
  privacyOf,
  privacyOfWorkspace,
  type Reader,
  ReadingAs,
  readableByOf,
  pathsMentioned,
  readableByOfWorkspace,
  readerMay,
  sharesRepoWithUnreadable,
  workspacesMentioned,
  threadsMentioned,
  touchesUnreadable,
  withoutUnreadable,
} from "../embedding/readable-by.ts";
import { isAbsolute, resolve } from "node:path";
import {
  holderOf,
  mayReachThread,
  NOT_YOUR_MACHINE,
  ownersOf,
  RoutedFor,
} from "../host/ownership.ts";
import { RemoteHosts } from "../host/remote-hosts.ts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as RpcSchema from "effect/rpc/RpcSchema";
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
 * What a viewer may call: reads of what the workspace shows, each scoped to a thread or a
 * workspace by its id. Everything else is refused, so an RPC added later is closed to viewers
 * until it is named here. Before naming one, read its handler: it must take no path of the
 * caller's choosing (git runs a folder's own configuration), spend no model usage, call no
 * provider with the server's credentials, and write nothing. Left out for those reasons, though
 * they read: `fs.browse`, `fs.tree`, `fs.list`, `fs.files`, `sessions.*`, `worktree.*`,
 * `git.branches` and the other git calls that take a path, pull request lookups, terminals,
 * connector and gateway configuration, diagnostics, and `thread.recap`, `thread.whyStuck`,
 * `thread.suggestions` and `orchestrator.featureSummary`, which ask a model, and `models.list`,
 * which asks the agents' own accounts. A viewer still gets
 * git and pull request state, and suggestions, as events.
 *
 * The RPC server calls a handler before this guard wraps what it returns, so a handler must do
 * its work in the effect or stream it returns, never while building it.
 */
export const VIEWER_RPCS: ReadonlySet<string> = new Set([
  "events.subscribe",
  "thread.subscribe",
  "thread.history",
  "thread.search",
  "thread.listWaits",
  "threads.closed.list",
  "threads.wakes",
  "attachment.read",
  "settings.get",
  "keybindings.get",
  "labels.list",
  "people.names",
  "palettes.list",
  "projects.list",
  "projects.folderSettings",
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
  "orchestrator.finishedWorker",
  "orchestrator.finishedWorkers",
  "orchestrator.finishedWorkersPage",
  "git.diff",
  "git.diffChunk",
  "thread.savedDiff",
  "fs.file",
  "fs.image",
  "fs.search",
  "app.usageLimitHistory",
]);

/**
 * What only the deployment sets up on a server people sign in to: a member's call is refused, and
 * the deployment supplies these from outside (`docs/EMBEDDING.md`, settings supplied from outside)
 * instead. Each acts on the server itself rather than on a person's work: the agent CLIs it
 * installs, its gateway keys and connectors, its own settings, keybindings and palettes, the agent
 * sessions in its own accounts, its diagnostics and logs, and programs it would start for a local
 * user. A headless server's disk holds nobody's work either ({@link memberMay}).
 */
export const DEPLOYMENT_RPCS: ReadonlySet<string> = new Set([
  "agentRuntime.cancel",
  "agentRuntime.cancelUpdate",
  "agentRuntime.install",
  "agentRuntime.rollback",
  "agentRuntime.update",
  "agentRuntime.useSource",
  "app.diagnostics",
  "app.diagnosticsReport",
  "app.keptHostStop",
  "app.openExternal",
  "app.openLogsFolder",
  "connectors.add",
  "connectors.authenticate",
  "connectors.reconnect",
  "connectors.remove",
  "connectors.setEnabled",
  "connectors.signIn",
  "editor.open",
  "fs.reveal",
  "issues.file",
  "issues.preview",
  "keybindings.set",
  "palettes.remove",
  "palettes.upsert",
  "profiles.discoverModels",
  "profiles.importKey",
  "profiles.openRouterFinish",
  "profiles.openRouterSignIn",
  "profiles.remove",
  "profiles.seed",
  "profiles.setKey",
  "profiles.upsert",
  "profiles.vaultInfo",
  // Trusting a folder lets its own settings and CLAUDE.md run for every session in it.
  "projects.setFolderTrust",
  "sessions.delete",
  "sessions.list",
  "sessions.preview",
  // Its personal settings, a person's own view, are theirs to set (`setsOnlyOwnView`).
  "settings.set",
]);

/**
 * What a member may call beyond a viewer's reads: their work in threads, workspaces, pull requests
 * and pages. Every RPC is in exactly one of {@link VIEWER_RPCS}, this and {@link DEPLOYMENT_RPCS}
 * (`actor-guard.test.ts`), and a member's call outside the first two is refused, so an RPC added
 * later is closed to members until it is named here.
 */
export const MEMBER_RPCS: ReadonlySet<string> = new Set([
  "agentRuntime.installState",
  "agentRuntime.list",
  "agentRuntime.watchInstall",
  "agentRuntime.watchUpdate",
  "agents.support",
  "app.handshake",
  "app.keptHost",
  "app.launchChecks",
  "app.usageOverview",
  "attachment.upload",
  "browserView.control",
  "browserView.input",
  "browserView.subscribe",
  "composer.drafts",
  "connectors.catalogue",
  "connectors.configured",
  "connectors.list",
  "docs.save",
  "dream.adopt",
  "dream.automaticStatus",
  "dream.cancel",
  "dream.discard",
  "dream.merge",
  "dream.preview",
  "dream.review",
  "dream.start",
  "fs.browse",
  "fs.files",
  "fs.list",
  "fs.preview",
  "fs.resolve",
  "fs.tree",
  "fs.vocabulary",
  "git.baseStatus",
  "git.branches",
  "git.fastForward",
  "git.fetchBase",
  "git.prApplySuggestion",
  "git.prCheckDiagnostic",
  "git.prChecks",
  "git.prDetail",
  "git.prReplyThread",
  "git.prRequestRereview",
  "git.prRerunChecks",
  "git.prResolveThread",
  "git.prReview",
  "git.push",
  "git.refresh",
  "git.upstreamStatus",
  "git.upstreamSync",
  "git.verifyState",
  "helper.presence",
  "helper.recordEvent",
  "helper.status",
  "labels.remove",
  "labels.upsert",
  "memory.delete",
  "memory.restore",
  "memory.write",
  "models.list",
  "models.suggestions",
  "openPrs.list",
  "orchestrator.archiveFeature",
  "orchestrator.cancelSwitch",
  "orchestrator.featureSummary",
  "orchestrator.handoff",
  "orchestrator.open",
  "orchestrator.releaseHeldBrief",
  "orchestrator.renameFeature",
  "orchestrator.retrySwitch",
  "orchestrator.setCharter",
  "orchestrator.setFeaturePaused",
  "orchestrator.setGroup",
  "orchestrator.setPaused",
  "orchestrator.setStage",
  "orchestrator.switch",
  "pages.list",
  "pages.open",
  "pages.pin",
  "pages.showOffer",
  "pages.unpin",
  "palette.filters",
  "pr.bind",
  "pr.bindExtra",
  "pr.checkout",
  "pr.close",
  "pr.create",
  "pr.draft",
  "pr.hide",
  "pr.labels.add",
  "pr.labels.list",
  "pr.labels.remove",
  "pr.merge",
  "pr.mergeOptions",
  "pr.promote",
  "pr.ready",
  "pr.reopen",
  "pr.requestReview",
  "pr.reviewerSuggestions",
  "pr.setExtraMonitor",
  "pr.setMonitor",
  "pr.showHidden",
  "pr.status",
  "pr.unbind",
  "pr.unbindExtra",
  "pr.updateBranch",
  "profiles.list",
  "projects.add",
  "projects.clone",
  "projects.cloneSuggestions",
  "projects.forget",
  "projects.origins",
  "projects.repositories",
  "projects.saveScripts",
  "projects.scripts",
  "projects.setBookmarked",
  "question.answer",
  "request.noticeTitle",
  "request.replies",
  "reviewRequests.list",
  "reviewRequests.refresh",
  "routine.run",
  "task.accept",
  "task.dismiss",
  "terminal.checkShell",
  "terminal.close",
  "terminal.input",
  "terminal.list",
  "terminal.open",
  "terminal.resize",
  "terminal.subscribe",
  "thread.addDirectory",
  "thread.addWait",
  "thread.browserStatus",
  "thread.cancelLimitWait",
  "thread.cancelWake",
  "thread.catchUp",
  "thread.close",
  "thread.create",
  "thread.createFromProfile",
  "thread.detach",
  "thread.fork",
  "thread.interrupt",
  "thread.joinTargets",
  "thread.joinWorkspace",
  "thread.keepWait",
  "thread.label",
  "thread.markCompleted",
  "thread.markUnread",
  "thread.park",
  "thread.pin",
  "thread.promptHistory",
  "thread.queue.edit",
  "thread.queue.remove",
  "thread.queue.reorder",
  "thread.queue.steer",
  "thread.recap",
  "thread.refreshPlan",
  "thread.rename",
  "thread.resolveWait",
  "thread.respond",
  "thread.respondMany",
  "thread.restartSession",
  "thread.restoreFromBranch",
  "thread.restoreWorktree",
  "thread.resumeAfterMachineLost",
  "thread.resumeLimitWait",
  "thread.rewind",
  "thread.send",
  "thread.setBabysit",
  "thread.setBrowser",
  "thread.setMode",
  "thread.setModel",
  "thread.setPlan",
  "thread.setReviewMonitor",
  "thread.snooze",
  "thread.startFreshOn",
  "thread.startSession",
  "thread.stash.add",
  "thread.stash.list",
  "thread.stash.remove",
  "thread.stash.take",
  "thread.steer",
  "thread.stopTask",
  "thread.suggestions",
  "thread.switchAgent",
  "thread.undoTurn",
  "thread.whyStuck",
  "threads.closed.reopen",
  "threads.reorder",
  "threads.usingCheckout",
  "ui.showPanel",
  "windows.report",
  "windows.watch",
  "workerQuestion.answer",
  "workerQuestion.dismiss",
  "workspace.remove",
  "workspace.save",
  "workspace.startTask",
  "workspace.taskPreflight",
  "worktree.cleanUp",
  "worktree.cleanupPlan",
  "worktree.list",
  "worktree.pendingPermissions",
  "worktree.pendingPermissionsAt",
  "worktree.remove",
  "worktree.size",
  "worktree.status",
  "worktree.storage",
]);

/**
 * What reaches this server's own disk rather than a thread's folder. Not `projects.clone`: on a
 * headless server it clones nothing and takes no path, only files the repository's origin under
 * the data folder (`fileOrigin`), and the machine a thread is placed on clones it with its own
 * credentials. That is how New project adds a repository there.
 */
const SERVER_DISK: ReadonlySet<string> = new Set(["fs.browse", "fs.tree", "projects.add"]);
/** The listings that reach this server's own disk when they name no thread. */
const SERVER_DISK_UNLESS_THREAD: ReadonlySet<string> = new Set(["fs.list", "fs.files"]);

/**
 * Whether a member may make this call on a server people sign in to: one of theirs or a viewer's.
 * On a headless server, which runs no work itself, its disk is nobody's work: nothing browses it,
 * adds or clones a project onto it, or lists it but by a thread's folder.
 */
export const memberMay = (action: string, payload: unknown, headless: boolean): boolean => {
  if (!VIEWER_RPCS.has(action) && !MEMBER_RPCS.has(action)) return false;
  if (!headless) return true;
  if (SERVER_DISK.has(action)) return false;
  if (!SERVER_DISK_UNLESS_THREAD.has(action)) return true;
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as Record<string, unknown>)["threadId"] === "string"
  );
};

export const DEPLOYMENT_REFUSAL =
  "not yours to change: this server's own setup comes from its deployment, not from the people signed in to it";

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
  "terminal.input",
  "browserView.subscribe",
  "browserView.input",
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
  "models.list",
  "models.suggestions",
  "pr.mergeOptions",
  "pr.reviewerSuggestions",
  "profiles.list",
  "profiles.vaultInfo",
  "projects.cloneSuggestions",
  "projects.origins",
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

/** The threads a call's payload names by id, which the call acts on. */
const threadsNamed = (payload: unknown): ReadonlyArray<ThreadId> => {
  if (typeof payload !== "object" || payload === null) return [];
  const fields = payload as Record<string, unknown>;
  const named: Array<ThreadId> = [];
  for (const key of ["threadId", "orchestratorThreadId"])
    if (typeof fields[key] === "string") named.push(fields[key] as ThreadId);
  if (Array.isArray(fields["threadIds"]))
    for (const id of fields["threadIds"]) if (typeof id === "string") named.push(id as ThreadId);
  return named;
};

/**
 * The workspaces a call's payload names by id, top-level or as its `target`: a workspace's call
 * acts on its orchestrator (a task, a charter, a pause), so that thread's owners must make it.
 */
const workspacesNamed = (payload: unknown): ReadonlyArray<WorkspaceId> => {
  if (typeof payload !== "object" || payload === null) return [];
  const fields = payload as Record<string, unknown>;
  const target = fields["target"];
  return [
    fields["workspaceId"],
    typeof target === "object" && target !== null
      ? (target as Record<string, unknown>)["workspaceId"]
      : undefined,
  ].filter((id): id is WorkspaceId => typeof id === "string");
};

/**
 * Whether a call is `settings.set` of nothing but the caller's own view (`PERSONAL_SETTINGS`):
 * written to their own rows, so a viewer may make it, and nobody's is recorded.
 */
export const setsOnlyOwnView = (action: string, payload: unknown): boolean => {
  if (action !== "settings.set" || typeof payload !== "object" || payload === null) return false;
  const patch = (payload as Record<string, unknown>)["patch"];
  if (typeof patch !== "object" || patch === null) return false;
  const paths = settingsPatchPaths(patch as SettingsPatch);
  return paths.length > 0 && paths.every(isPersonalSetting);
};

/**
 * The calls that list folders and files: what they list of a folder above a thread the caller may
 * not see leaves that thread's folder out (`embedding/readable-by.ts`).
 */
export const LISTING_RPCS: ReadonlySet<string> = new Set([
  "fs.browse",
  "fs.tree",
  "fs.list",
  "fs.files",
  "fs.search",
  "worktree.list",
]);

export const VIEWER_REFUSAL = "read-only: a viewer can't change anything here";
export const NO_ACTOR_REFUSAL = "unauthorized: no signed-in person on this call";

/** A word from a fixed set (a kind, a decision), not free text. */
const text = (value: unknown): string | undefined =>
  typeof value === "string" && /^[A-Za-z]{1,32}$/.test(value) ? value : undefined;

/** The leaves of a settings patch as dotted paths: which settings, never their values. */
const patchPaths = (patch: unknown, prefix = "", out: string[] = []): string[] => {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    if (prefix !== "") out.push(prefix);
    return out;
  }
  for (const [key, value] of Object.entries(patch)) {
    if (out.length >= 64) break;
    // A settings key is a name from the schema; anything else is a record's key, which is data.
    const name = /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(key) ? key : "*";
    patchPaths(value, prefix === "" ? name : `${prefix}.${name}`, out);
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
  "id",
] as const;

/** An id as the app makes them: nothing a person would type a sentence into. */
const idText = (value: unknown): string | undefined =>
  typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;

/** The most entries one call leaves, however many answers it carries. */
const MAX_ENTRIES_PER_CALL = 200;

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
 * Only what identifies the thing acted on is kept, and only where it has the shape of an id. The actor's id is the proxy's stable id for the
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
      idText(source["threadId"]) ??
      (action === "thread.create" && typeof result === "object" && result !== null
        ? idText((result as Record<string, unknown>)["id"])
        : undefined),
    workspaceId: idText(source["workspaceId"]),
    data: {
      ...Object.fromEntries(
        ID_KEYS.flatMap((key) => (idText(source[key]) === undefined ? [] : [[key, source[key]]])),
      ),
      ...data,
    },
  });
  if (action === "thread.respondMany" && Array.isArray(fields["answers"])) {
    return (fields["answers"] as ReadonlyArray<unknown>)
      .slice(0, MAX_ENTRIES_PER_CALL)
      .flatMap((item) =>
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
      // Absent in guard-only test layers, which run no headless server.
      const headless =
        Option.getOrUndefined(yield* Effect.serviceOption(ServerConfig))?.headless === true;
      // Who each joined machine was started for, where one was. Absent in tests with no machines.
      const machines = Option.getOrUndefined(yield* Effect.serviceOption(RemoteHosts))?.machines;
      const ownerOf = ownersOf(machines);
      /**
       * Whether a thread the call acts on is on a machine `person` may not reach: the threads it
       * names, and each named workspace's orchestrator, which its workers share an owner with
       * (`host/ownership.ts`). The one rule, `mayReachThread`, as the caller.
       */
      const onAnothersMachine = (person: string | undefined, payload: unknown) =>
        Effect.gen(function* () {
          // Looked up only while some machine is someone's, or closed (`holderOf`).
          if (machines?.list().some((machine) => holderOf(machine) !== undefined) !== true)
            return false;
          const threads = [...threadsNamed(payload)];
          for (const workspaceId of workspacesNamed(payload)) {
            const state = yield* store.getWorkspace(workspaceId).pipe(Effect.option);
            const holder =
              state._tag === "Some" ? state.value.workspace.orchestratorThreadId : undefined;
            if (holder !== undefined) threads.push(holder);
          }
          for (const threadId of threads)
            if (!(yield* mayReachThread(store.getThread, ownerOf, threadId))) return true;
          return false;
        }).pipe(Effect.provideService(RoutedFor, { person }));
      /**
       * Whether the call names a thread `reader` may not see (`embedding/readable-by.ts`): one it
       * names anywhere in its payload, or a named workspace's orchestrator, whose workers have its
       * reader. Asked of every call, a read or a change, before it runs.
       */
      const namesUnreadable = (reader: Reader, payload: unknown, level: Level = "act") =>
        Effect.gen(function* () {
          if (!anyPrivate()) return false;
          for (const threadId of threadsMentioned(payload))
            if (!readerMay(reader, level === "read" ? privacyOf(threadId) : readableByOf(threadId)))
              return true;
          // A dream is its workspace's: its id names the workspace as much as the workspace's own.
          const dreamWorkspaces: Array<string> = [];
          const dreamId =
            typeof payload === "object" && payload !== null
              ? (payload as Record<string, unknown>)["dreamId"]
              : undefined;
          if (typeof dreamId === "string") {
            const dream = yield* store.getDream(dreamId as DreamId).pipe(Effect.option);
            if (dream._tag === "Some") dreamWorkspaces.push(dream.value.workspaceId);
          }
          for (const workspaceId of new Set([
            ...workspacesNamed(payload),
            ...workspacesMentioned(payload),
            ...dreamWorkspaces,
          ])) {
            const state = yield* store.getWorkspace(workspaceId as WorkspaceId).pipe(Effect.option);
            const holder =
              state._tag === "Some" ? state.value.workspace.orchestratorThreadId : undefined;
            if (
              !readerMay(
                reader,
                level === "read"
                  ? privacyOfWorkspace(workspaceId, holder)
                  : readableByOfWorkspace(workspaceId, holder),
              )
            )
              return true;
          }
          return false;
        });
      /**
       * Whether the call names a path, of its own choosing or against a thread it names, inside a
       * folder of a thread `reader` may not see (`touchesUnreadable`): by any spelling, a link
       * that leads there or `..` included, whatever the call does with it.
       */
      const pathsUnreadable = (
        reader: Reader,
        payload: unknown,
        sharedToo = false,
        level: Level = "act",
      ) =>
        Effect.gen(function* () {
          if (!anyPrivate()) return false;
          const bases: Array<string> = [];
          for (const threadId of threadsMentioned(payload)) {
            const thread = yield* store.getThread(threadId).pipe(Effect.option);
            if (thread._tag === "Some")
              bases.push(
                effectiveCheckout(thread.value).path,
                ...(thread.value.extraCheckouts ?? []).map((extra) => extra.path),
              );
          }
          const paths = pathsMentioned(payload, bases);
          // Behind a proxy, nor a repository such a thread has a checkout of: another checkout
          // of it, a branch list, a worktree list share that thread's `.git` and its commits.
          return (
            touchesUnreadable(reader, paths, level) ||
            (sharedToo && sharesRepoWithUnreadable(reader, paths, level))
          );
        });
      /** The folder a listing's relative entries are under: its own path, or its thread's. */
      const listedUnder = (payload: unknown) =>
        Effect.gen(function* () {
          const fields =
            typeof payload === "object" && payload !== null
              ? (payload as Record<string, unknown>)
              : {};
          const path = typeof fields["path"] === "string" ? fields["path"] : undefined;
          if (path !== undefined && isAbsolute(path)) return path;
          const threadId = fields["threadId"];
          if (typeof threadId !== "string") return path;
          const thread = yield* store.getThread(threadId as ThreadId).pipe(Effect.option);
          if (thread._tag === "None") return undefined;
          return resolve(effectiveCheckout(thread.value).path, path ?? ".");
        });
      /**
       * `effect` with what a listing shows of folders above a thread `reader` may not see taken
       * out (`withoutUnreadable`): the thread's folder isn't listed, nor anything in it.
       */
      const listedFor = <A, E, R>(
        reader: Reader,
        action: string,
        payload: unknown,
        effect: Effect.Effect<A, E, R>,
        level: Level = "act",
      ): Effect.Effect<A, E, R> =>
        !LISTING_RPCS.has(action)
          ? effect
          : Effect.flatMap(effect, (result) =>
              anyPrivate()
                ? Effect.map(
                    listedUnder(payload),
                    (base) => withoutUnreadable(reader, result, base, level) as A,
                  )
                : Effect.succeed(result),
            );
      return ActorGuard.of((call, { rpc, payload, headers }) =>
        Effect.gen(function* () {
          // A machine started for one person is reached only for them, whatever the route
          // (`host/ownership.ts`): an RPC with no signed-in person is no one's.
          if (!(yield* fronted.active)) {
            // Nor does it read a thread readable by one person: it has no subject to be them.
            const nobody: Reader = { subject: undefined };
            if (
              (yield* namesUnreadable(nobody, payload)) ||
              (yield* pathsUnreadable(nobody, payload))
            )
              return yield* Effect.die(new Error(NOT_READABLE));
            if (!VIEWER_RPCS.has(rpc._tag) && (yield* onAnothersMachine(undefined, payload)))
              return yield* Effect.die(new Error(NOT_YOUR_MACHINE));
            return yield* listedFor(
              nobody,
              rpc._tag,
              payload,
              call.pipe(
                Effect.provideService(RoutedFor, { person: undefined }),
                Effect.provideService(ReadingAs, nobody),
              ),
            );
          }
          const actor = actorOf(headers);
          if (actor === undefined) return yield* Effect.die(new Error(NO_ACTOR_REFUSAL));
          // A thread readable by one person is theirs alone to change, member or viewer, and
          // theirs and its readers' to read (`Thread.readers`). A call that only reads is judged
          // as a read; any other as acting, which its readers may not.
          const reader: Reader = { subject: actor.id };
          const action = rpc._tag;
          const reads = VIEWER_RPCS.has(action) || setsOnlyOwnView(action, payload);
          if (
            (yield* namesUnreadable(reader, payload, "read")) ||
            (yield* pathsUnreadable(reader, payload, true, "read"))
          )
            return yield* Effect.die(new Error(NOT_READABLE));
          if (
            !reads &&
            ((yield* namesUnreadable(reader, payload, "act")) ||
              (yield* pathsUnreadable(reader, payload, true, "act")))
          )
            return yield* Effect.die(new Error(ONLY_READS));
          // The call runs as this person, for what asks who acted (`embedding/person.ts`).
          const effect = listedFor(
            reader,
            rpc._tag,
            payload,
            call.pipe(
              Effect.provideService(ActingPerson, actor.id),
              Effect.provideService(RoutedFor, { person: actor.id }),
              Effect.provideService(ReadingAs, reader),
            ),
            reads ? "read" : "act",
          );
          if (reads) return yield* effect;
          if (actor.role !== "member") return yield* Effect.die(new Error(VIEWER_REFUSAL));
          // A member works in threads and workspaces; the server's own setup is its deployment's.
          if (!memberMay(action, payload, headless))
            return yield* Effect.die(new Error(DEPLOYMENT_REFUSAL));
          // A socket can't carry what the proxy signs for one answer: those come over HTTP.
          if (action === "thread.respond" || action === "thread.respondMany")
            return yield* Effect.die(new Error(ANSWER_OVER_HTTP));
          // A thread on a machine started for one person changes only for that person: what they
          // send it runs there (`host/ownership.ts`). Reading it stays a viewer's read, above.
          if (yield* onAnothersMachine(actor.id, payload))
            return yield* Effect.die(new Error(NOT_YOUR_MACHINE));
          if (UNRECORDED_RPCS.has(action)) return yield* effect;
          const record = (outcome?: "failed" | "interrupted", result?: unknown) =>
            store.appendActorEvents(
              actorEventsOf(actor, action, payload, Date.now(), result).map((entry) =>
                outcome === undefined
                  ? entry
                  : { ...entry, data: { ...entry.data, [outcome]: true } },
              ),
            );
          // A stream runs for as long as its caller listens, so what it starts is recorded first.
          if (RpcSchema.isStreamSchema(rpc.successSchema))
            return yield* Effect.andThen(record(), effect);
          // Recorded once the call has ended, and not interrupted between: a change that happened
          // always has its entry. A call that failed, or that its caller cut off, may have
          // changed something on the way, so it is recorded as that.
          return yield* Effect.uninterruptibleMask((restore) =>
            restore(effect).pipe(
              Effect.onExit((exit) =>
                Exit.isSuccess(exit)
                  ? record(undefined, exit.value)
                  : record(Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : "failed"),
              ),
            ),
          );
        }),
      );
    }),
  );
}
