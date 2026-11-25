import { basename } from "node:path";
import {
  hostOf,
  LOCAL_HOST_ID,
  type Checkout,
  type QueueItemId,
  type ThreadId,
  type Thread,
  type ThreadWorktreeHook,
  type WorktreeHookKind,
  type WorktreeHookOutcome,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import { type Runtime, locked } from "./runtime-state.ts";
import type { TurnLifecycle } from "./turn-lifecycle.ts";
import type { RemoteHostsShape } from "../host/remote-hosts.ts";
import { isProvisioned } from "../host/paired-machines.ts";
import { RESUME_TIMEOUT_MS, sanitizeHookText } from "../host/worktree-hook-runner.ts";
import type { HostWorktreeHooks } from "../host/worktree-hooks.ts";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import { folderBringsNothing, projectFolderTrusted } from "../settings/folder-trust.ts";
import type { ThreadRuntimesShape } from "./thread-runtimes-shape.ts";
import { worktreeHookConsent } from "./worktree-hook-consent.ts";

const owned = (thread: Thread) =>
  [thread.checkout, ...(thread.extraCheckouts ?? [])].filter(
    (checkout) => checkout.kind === "worktree",
  );

export const hasWorkerWorktree = (thread: Thread) =>
  thread.spawnedBy !== undefined && owned(thread).length > 0;

export const hasWorktreeActivation = (thread: Thread) =>
  hasWorkerWorktree(thread) ||
  owned(thread).some((checkout) => checkout.worktreeSetup !== undefined);

export const isWorktreeWake = (key: string | undefined) =>
  key !== undefined && /^(?:wake|dependency|ci|pr-review|pr-comment|run):/.test(key);

const outcome = (
  status: WorktreeHookOutcome["status"],
  reason?: string,
  failure?: WorktreeHookOutcome["failure"],
): WorktreeHookOutcome => ({
  status,
  durationMs: 0,
  log: "",
  ...(reason === undefined ? {} : { reason }),
  ...(failure === undefined ? {} : { failure }),
});

const unavailable = () =>
  outcome("failed", "Worktree hooks are unavailable on this machine.", "unavailable");
const interrupted = () => outcome("failed", "The previous hook was interrupted.", "interrupted");
const STORED_LOG_CHARS = 16 * 1024;
const storedResult = (result: ThreadWorktreeHook["result"]): ThreadWorktreeHook["result"] => {
  if (result.status === "running" || result.log.length <= STORED_LOG_CHARS) return result;
  const margin = STORED_LOG_CHARS / 2;
  return {
    ...result,
    log: `${result.log.slice(0, margin)}\n[Output shortened.]\n${result.log.slice(-margin)}`,
  };
};
const saved = (thread: Thread, checkout: Checkout, kind: WorktreeHookKind) =>
  thread.worktreeHooks?.find(
    (entry) =>
      entry.checkout === checkout.path &&
      entry.kind === kind &&
      entry.generation === (checkout.worktreeSetup?.generation ?? "existing"),
  );

export const worktreeNotice = (items: readonly ThreadWorktreeHook[]): string | undefined => {
  const notes = items.flatMap(({ checkout, kind, path, result }) =>
    result.status === "failed" || result.status === "skipped"
      ? [
          `${sanitizeHookText(basename(checkout)).slice(0, 100)} ${path ?? kind}: ${result.reason ?? "The hook did not run."}`,
        ]
      : [],
  );
  return notes.length === 0
    ? undefined
    : `Gram worktree status. See Worktree hooks in the thread for details.\n${notes.join("\n")}`;
};

export const makeWorktreeActivations = (deps: {
  readonly local: HostWorktreeHooks;
  readonly remote?: RemoteHostsShape;
  readonly dataDir: string;
  readonly store: Pick<
    ThreadStoreShape,
    "getThread" | "updateThread" | "getWorkspace" | "listProjects"
  >;
  readonly publish: (thread: Thread) => Effect.Effect<void>;
  readonly ask: ThreadRuntimesShape["requestApproval"];
}) => {
  const hostFor = (checkout: Checkout) =>
    Effect.gen(function* () {
      const host = hostOf(checkout);
      if (host === LOCAL_HOST_ID)
        return { hooks: deps.local, host, hosted: false, name: "This machine" };
      const machine = deps.remote?.machines.list().find((each) => each.id === host);
      if (deps.remote === undefined || machine === undefined) return undefined;
      const connection = yield* deps.remote
        .connection(host)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (connection?.worktreeHooks === undefined) return undefined;
      return {
        hooks: connection.worktreeHooks,
        host,
        name: machine.name,
        hosted: isProvisioned(machine) || machine.via !== undefined,
      };
    });

  const record = (
    thread: Thread,
    checkout: Checkout,
    kind: WorktreeHookKind,
    path: string | undefined,
    result: ThreadWorktreeHook["result"],
  ) => {
    const entry = {
      checkout: checkout.path,
      kind,
      generation: checkout.worktreeSetup?.generation ?? "existing",
      ...(path === undefined ? {} : { path }),
      result: storedResult(result),
    } satisfies ThreadWorktreeHook;
    return deps.store
      .updateThread(thread.id, (current) => ({
        ...current,
        worktreeHooks: [
          ...(current.worktreeHooks ?? []).filter(
            (each) => each.checkout !== entry.checkout || each.kind !== entry.kind,
          ),
          entry,
        ],
      }))
      .pipe(
        Effect.tap(deps.publish),
        Effect.as(entry),
        Effect.orElseSucceed(() => entry),
      );
  };

  const plan = (thread: Thread, checkout: Checkout, kind: WorktreeHookKind) =>
    Effect.gen(function* () {
      const mark = (path: string | undefined, result: WorktreeHookOutcome) =>
        record(thread, checkout, kind, path, result);
      const revision = kind === "setup" ? checkout.worktreeSetup?.revision : undefined;
      if (kind === "setup" && revision === undefined) return yield* mark(undefined, unavailable());
      if (checkout.untrusted === true)
        return yield* mark(
          undefined,
          outcome("skipped", "Gram does not run hooks in an untrusted checkout."),
        );
      const location = yield* hostFor(checkout);
      if (location === undefined) return yield* mark(undefined, unavailable());
      const request = {
        checkout: checkout.path,
        kind,
        ...(revision === undefined ? {} : { revision }),
      };
      const inspection = yield* location.hooks
        .inspect(request)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (inspection === undefined) return yield* mark(undefined, unavailable());
      if (inspection.status === "absent") {
        if (kind === "setup" || saved(thread, checkout, kind) !== undefined)
          yield* mark(undefined, outcome("absent"));
        return undefined;
      }
      if (inspection.status !== "found")
        return yield* mark(
          undefined,
          outcome(inspection.status === "invalid" ? "failed" : "skipped", inspection.reason),
        );

      const projects = yield* deps.store.listProjects;
      const project =
        checkout === thread.checkout
          ? projects.find((candidate) => candidate.id === thread.projectId)
          : projects.find(
              (candidate) =>
                candidate.root === checkout.repoRoot ||
                (checkout.cloneIdentity !== undefined &&
                  candidate.originIdentity === checkout.cloneIdentity),
            );
      const repository = checkout.cloneIdentity ?? project?.id;
      if (!location.hosted) {
        const trusted = () =>
          deps.store.listProjects.pipe(
            Effect.map((current) => {
              const folder = current.find((candidate) => candidate.id === project?.id);
              return (
                folder !== undefined &&
                projectFolderTrusted(
                  folder,
                  location.host === LOCAL_HOST_ID ? folderBringsNothing(folder.root) : () => false,
                )
              );
            }),
          );
        if (repository === undefined || !(yield* trusted()))
          return yield* mark(
            inspection.path,
            outcome("skipped", "Trust the project folder to run this hook."),
          );
        const consent = yield* worktreeHookConsent({
          dataDir: deps.dataDir,
          thread,
          host: location.host,
          machine: location.name,
          repository,
          kind,
          path: inspection.path,
          fingerprint: inspection.fingerprint,
          script: inspection.script,
          ask: deps.ask,
        });
        if (consent !== "allow" || !(yield* trusted()))
          return yield* mark(
            inspection.path,
            outcome(
              "skipped",
              consent === "deny"
                ? "The user declined this hook revision."
                : "Gram could not establish consent for this hook revision.",
            ),
          );
      }
      const workspace =
        thread.workspaceId === undefined
          ? undefined
          : yield* deps.store.getWorkspace(thread.workspaceId).pipe(
              Effect.map((state) => state.workspace),
              Effect.orElseSucceed(() => undefined),
            );

      return (deadline?: number) =>
        Effect.gen(function* () {
          const fresh = yield* deps.store
            .getThread(thread.id)
            .pipe(Effect.orElseSucceed(() => undefined));
          const stillOwned =
            fresh !== undefined &&
            !fresh.parked &&
            owned(fresh).some(
              (current) =>
                current.path === checkout.path &&
                hostOf(current) === location.host &&
                current.untrusted !== true &&
                current.worktreeSetup?.generation === checkout.worktreeSetup?.generation &&
                current.cloneIdentity === checkout.cloneIdentity,
            );
          if (!stillOwned) return undefined;
          const reachable = yield* hostFor(checkout);
          if (reachable === undefined || reachable.hosted !== location.hosted)
            return yield* mark(inspection.path, unavailable());
          yield* record(thread, checkout, kind, inspection.path, { status: "running" });
          const budgetMs = deadline === undefined ? undefined : Math.max(0, deadline - Date.now());
          let cleanupReported = false;
          const run = reachable.hooks.run(
            {
              ...request,
              revision: inspection.revision,
              fingerprint: inspection.fingerprint,
              ...(budgetMs === undefined ? {} : { budgetMs }),
              ...(!location.hosted || kind !== "setup"
                ? {}
                : {
                    ...(checkout.worktreeSetup === undefined
                      ? {}
                      : { generation: checkout.worktreeSetup.generation }),
                    ...(checkout.cloneIdentity === undefined
                      ? {}
                      : { repository: checkout.cloneIdentity }),
                    ...(workspace === undefined ? {} : { workspace: workspace.id }),
                    ...(workspace?.environment === undefined
                      ? {}
                      : { environment: workspace.environment }),
                  }),
            },
            (result) =>
              mark(inspection.path, result).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    cleanupReported = true;
                  }),
                ),
                Effect.asVoid,
              ),
          );
          const result = yield* run.pipe(
            Effect.orElseSucceed(unavailable),
            Effect.onInterrupt(() =>
              cleanupReported
                ? Effect.void
                : mark(
                    inspection.path,
                    outcome(
                      "failed",
                      "The hook was interrupted and the host did not confirm cleanup.",
                      "interrupted",
                    ),
                  ),
            ),
          );
          return yield* mark(inspection.path, result);
        });
    });

  const finish = (run: Effect.Success<ReturnType<typeof plan>>, deadline?: number) =>
    typeof run === "function" ? run(deadline) : Effect.succeed(run);

  const setup = (thread: Thread) =>
    Effect.gen(function* () {
      const items: ThreadWorktreeHook[] = [];
      for (const checkout of owned(thread)) {
        if (checkout.worktreeSetup === undefined) continue;
        const previous = saved(thread, checkout, "setup");
        const item =
          previous === undefined
            ? yield* finish(yield* plan(thread, checkout, "setup"))
            : previous.result.status === "running"
              ? yield* record(thread, checkout, "setup", previous.path, interrupted())
              : previous;
        if (item !== undefined) items.push(item);
      }
      return items;
    });

  const resume = (thread: Thread) =>
    Effect.gen(function* () {
      if (!hasWorkerWorktree(thread)) return [];
      const runs = yield* Effect.forEach(
        owned(thread),
        (checkout) => plan(thread, checkout, "resume"),
        { concurrency: 4 },
      );
      const deadline = Date.now() + RESUME_TIMEOUT_MS;
      const results = yield* Effect.forEach(runs, (run) => finish(run, deadline), {
        concurrency: 4,
      });
      return results.filter((item) => item !== undefined);
    });

  return { setup, resume };
};

export const sessionWorktreeActivation = (
  activations: ReturnType<typeof makeWorktreeActivations> | undefined,
  rt: Runtime,
  thread: Thread,
) => {
  const enabled = activations !== undefined && hasWorktreeActivation(thread);
  const resumeFirst = thread.agentSessionId === undefined || rt.restartMarker === "asked";
  const results: ThreadWorktreeHook[] = [];
  if (enabled) rt.activeWorktreeHook = true;
  const ended = () => {
    if (enabled) rt.activeWorktreeHook = undefined;
  };
  return {
    ended,
    beforeOpen: Effect.gen(function* () {
      if (!enabled) return;
      yield* locked(rt, Effect.void);
      results.push(...(yield* activations.setup(thread)));
      if (resumeFirst) results.push(...(yield* activations.resume(thread)));
    }),
    beforeAdmission: (reattached: boolean) =>
      Effect.gen(function* () {
        if (enabled && !resumeFirst && !reattached)
          results.push(...(yield* activations.resume(thread)));
      }),
    admitted: (reattached: boolean) => {
      ended();
      if (!enabled || !hasWorkerWorktree(thread)) return;
      const note = worktreeNotice(results);
      if (note !== undefined) rt.worktreeHookNote = note;
      const next = rt.queue[0]?.id;
      if (
        (resumeFirst || !reattached) &&
        next !== undefined &&
        isWorktreeWake(rt.noticeKeys.get(next))
      )
        rt.resumedWorktreeNotice = next;
    },
  };
};

export const makeWarmWorktreeWake = ({
  store,
  worktreeActivations,
  worktreeWakes,
  setStatus,
  becomeIdle,
}: {
  readonly store: Pick<ThreadStoreShape, "getThread">;
  readonly worktreeActivations: ReturnType<typeof makeWorktreeActivations> | undefined;
  readonly worktreeWakes: FiberMap.FiberMap<ThreadId>;
  readonly setStatus: TurnLifecycle["setStatus"];
  readonly becomeIdle: (rt: Runtime) => Effect.Effect<void>;
}) => {
  const startWorktreeWake = (rt: Runtime, item: QueueItemId): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      if (worktreeActivations === undefined) return false;
      const thread = yield* store
        .getThread(rt.threadId)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (thread === undefined || !hasWorkerWorktree(thread)) return false;
      rt.activeWorktreeHook = true;
      yield* setStatus(rt, "starting");
      const work = Effect.gen(function* () {
        const note = worktreeNotice(yield* worktreeActivations.resume(thread));
        yield* locked(
          rt,
          Effect.gen(function* () {
            rt.activeWorktreeHook = undefined;
            rt.resumedWorktreeNotice = item;
            if (note !== undefined) rt.worktreeHookNote = note;
            if (!rt.closing && rt.session !== undefined) yield* becomeIdle(rt);
          }),
        );
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            rt.activeWorktreeHook = undefined;
          }),
        ),
      );
      yield* FiberMap.run(worktreeWakes, rt.threadId, work);
      return true;
    });
  return startWorktreeWake;
};
