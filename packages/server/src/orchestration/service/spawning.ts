// Spawning: `spawn_worker` and the user's start of a worker, from
// the approval an outside repo or a gated mode needs, through the gates near a limit, to the thread,
// its worktrees and its brief.

import type { makeSpawnBreaker } from "../spawn-breaker.ts";
import {
  AppToolError,
  autonomyOf,
  briefFooterOf,
  effectiveCheckout,
  InvalidState,
  type Checkout,
  type ModelRef,
  type Project,
  type ProjectId,
  type ReasoningVariant,
  type Thread,
  type ThreadId,
  type UserInput,
  type WorkspaceId,
} from "@gram/contracts";
import { samePath } from "@gram/git";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { sameTaskModel } from "../task-selection.ts";
import { heldCheckoutPaths } from "../../runtime/create-in-checkout.ts";
import { selectableModels } from "../../runtime/model-efforts.ts";
import { limitQueuedNote } from "../../runtime/limit-wait.ts";
import { finishedWorkers } from "../ledger.ts";
import { type RouteOffer } from "../limit-pause.ts";
import { withBriefFooter } from "../user-words.ts";
import { emptyWorkerMemo, withNotes, workerThreadId, type WorkerMemo } from "../outbox.ts";
import {
  budgetVerdict,
  featureBranch,
  featureSlug,
  taskFeature,
  refusal,
  regroup,
  scopeOverlap,
  startModeFor,
  USER_HOLD_IDLE_MS,
  workerModelLabel,
  workerModelVerdict,
} from "../rules.ts";
import {
  projectOfCheckout,
  repoLabel,
  worktreesOf,
  workerModel,
  toolError,
  gateHoldsIn,
  type OrchestrationKit,
  underKeysOf,
} from "./kit.ts";
import {
  type SpawnWorkerInput,
  type HeldSpawn,
  type WorkerWorktree,
  type SpawnedWorker,
  type OrchestrationShape,
} from "./shape.ts";
import type { LedgerWatch } from "./ledger-watch.ts";
import type { Projects } from "./projects.ts";
import type { TaskStartup } from "./task-startup.ts";
import type { Workers } from "./workers.ts";
import type { HeldSpawns } from "./held-spawns.ts";

const spawnedResult = (
  worker: Thread,
  projects: ReadonlyMap<ProjectId, Project>,
): SpawnedWorker => {
  const checkout = effectiveCheckout(worker);
  const alsoIn = worktreesOf(projects.values(), worker.extraCheckouts ?? []).map(
    ({ project, path, branch }): WorkerWorktree => ({
      project,
      worktree: path,
      ...(branch === undefined ? {} : { branch }),
    }),
  );
  return {
    threadId: worker.id,
    title: worker.title,
    feature: worker.spawnedBy?.feature ?? "",
    project: projects.get(worker.projectId)?.name ?? "",
    ...(checkout.branch === undefined ? {} : { branch: checkout.branch }),
    worktree: checkout.path,
    ...(alsoIn.length === 0 ? {} : { alsoIn }),
    model: workerModelLabel(worker.model),
    mode: worker.mode,
  };
};

/** What spawning takes from the rest of the service. */
export interface SpawningDeps {
  readonly outsideWorkspace: Projects["outsideWorkspace"];
  readonly survey: LedgerWatch["survey"];
  readonly repoNames: Projects["repoNames"];
  readonly joinWorkspace: Projects["joinWorkspace"];
  readonly resolveProject: Projects["resolveProject"];
  readonly taskWorkers: TaskStartup["taskWorkers"];
  readonly armHold: Workers["armHold"];
  readonly projectCall: Projects["projectCall"];
  readonly pausedSpawnGate: HeldSpawns["pausedSpawnGate"];
  readonly spawnBreaker: Effect.Success<ReturnType<typeof makeSpawnBreaker>>;
  readonly routeGate: HeldSpawns["routeGate"];
  readonly holdGate: HeldSpawns["holdGate"];
  readonly routeHeld: HeldSpawns["routeHeld"];
  readonly limitGate: HeldSpawns["limitGate"];
  readonly routePaused: HeldSpawns["routePaused"];
}

/** Spawning workers. */
export const makeSpawning = (kit: OrchestrationKit, deps: SpawningDeps) => {
  const {
    authorityOf,
    requireAuthority,
    rosterHere,
    spawnLock,
    checkoutLock,
    checkoutKey,
    authorityKeys,
    store,
    readOutbox,
    findThread,
    workerWorkspaces,
    parkedWorkers,
    updateOutbox,
    runtimes,
    sampleExtras,
    orchestrationChanged,
    retryingIn,
    nativeGateReady,
    hosts,
    creator,
    checkouts,
    openedInAuto,
  } = kit;
  const {
    outsideWorkspace,
    survey,
    repoNames,
    joinWorkspace,
    resolveProject,
    taskWorkers,
    armHold,
    projectCall,
    pausedSpawnGate,
    spawnBreaker,
    routeGate,
    holdGate,
    routeHeld,
    limitGate,
    routePaused,
  } = deps;

  const spawnNeedsApproval: OrchestrationShape["spawnNeedsApproval"] = (callerId, input) =>
    Effect.gen(function* () {
      const authority = yield* authorityOf(callerId);
      // Without authority the handler refuses; a card first would only ask for nothing.
      if (authority === undefined) return false;
      const { state } = authority;
      const outside = yield* outsideWorkspace(
        "spawn_worker",
        [input.project, ...(input.alsoIn ?? [])],
        state,
      );
      if (outside.length > 0) return true;
      const { budget } = yield* survey(state, false);
      return !budgetVerdict({ charter: state.charter, liveWorkers: budget.liveWorkers }).ok;
    }).pipe(Effect.catchCause(() => Effect.succeed(true)));

  const describeSpawn: OrchestrationShape["describeSpawn"] = (callerId, input) =>
    Effect.gen(function* () {
      const authority = yield* authorityOf(callerId);
      const named = [input.project, ...(input.alsoIn ?? [])];
      const repos = (
        authority === undefined ? named : yield* repoNames("spawn_worker", named, authority.state)
      ).join(", ");
      const plain = `Spawn a worker in ${repos} for ${input.feature}: ${input.title}`;
      if (authority === undefined) return plain;
      const { state } = authority;
      const outside = yield* outsideWorkspace(
        "spawn_worker",
        [input.project, ...(input.alsoIn ?? [])],
        state,
      );
      if (outside.length > 0) {
        return `Add ${outside.map(repoLabel).join(" and ")} to the "${state.workspace.name}" workspace, and spawn a worker there for ${input.feature}: ${input.title}`;
      }
      const { budget } = yield* survey(state, false);
      return !budgetVerdict({ charter: state.charter, liveWorkers: budget.liveWorkers }).ok
        ? `${budget.liveWorkers} workers are live and the charter allows ${budget.maxConcurrentWorkers}. Allow one more, in ${repos} for ${input.feature}: ${input.title}`
        : plain;
    }).pipe(
      Effect.catchCause(() =>
        Effect.succeed(`Spawn a worker in ${input.project} for ${input.feature}`),
      ),
    );

  const checkWorkerModel: OrchestrationShape["checkWorkerModel"] = (callerId, model) =>
    Effect.gen(function* () {
      const tool = "set_thread_model";
      const { thread, state } = yield* requireAuthority(tool, callerId);
      // By its full label: the target's agent kind is fixed, and a bare id may be another kind's.
      const picked = yield* workerModel(
        tool,
        thread,
        state.charter,
        workerModelLabel(model),
        state.charter.workerModels === undefined
          ? undefined
          : yield* rosterHere(state.charter.workerModels, state.charter),
      );
      // A switch is to the model named or not at all; the default stands in only for a spawn.
      if (picked.instead !== undefined) {
        return yield* toolError(
          tool,
          refusal(
            "not_admitted",
            `${picked.instead.of} is unavailable here (${picked.instead.why}), so the worker stays on its model.`,
          ),
        );
      }
    });

  /**
   * `spawn_worker`, and the user's own worker from New task (`byUser`): that one takes the user's
   * input as it came, attachments and all, with no origin, so it starts held as theirs and
   * the runtime titles it from its first line. A pause or a rate limit is the orchestrator's to
   * wait out, not the user's.
   */
  const spawnFor = (
    callerId: ThreadId,
    input: SpawnWorkerInput,
    byUser?: { readonly id: ThreadId; readonly input: UserInput; readonly model?: ModelRef },
  ): Effect.Effect<SpawnedWorker, AppToolError> => {
    let recorded: { key: string; id: ThreadId; workspaceId: WorkspaceId } | undefined;
    return underKeysOf(
      spawnLock,
      authorityKeys(callerId),
      projectCall(input.identities, (call) =>
        Effect.gen(function* () {
          const tool = "spawn_worker";
          const { thread: caller, state } = yield* requireAuthority(tool, callerId);
          const workspaceId = state.workspace.id;
          if (byUser === undefined && state.paused !== undefined) {
            return yield* toolError(
              tool,
              refusal(
                "paused",
                `Orchestration is paused (${state.paused.reason}), so no worker is spawned. Only the user can resume it; end your turn.`,
              ),
            );
          }
          const projects = new Map((yield* store.listProjects).map((p) => [p.id, p]));
          // A retry, or a call the last run crashed in, finds the worker by the id its request
          // gives it, and makes it under that id if the first attempt got no further.
          const requestedId =
            byUser !== undefined || input.clientRequestId === undefined
              ? undefined
              : ((yield* readOutbox(workspaceId)).requests[input.clientRequestId] ??
                workerThreadId(workspaceId, input.clientRequestId));
          const brief: UserInput = {
            text: input.brief,
            origin: { threadId: caller.id, title: caller.title, depth: 1, role: "orchestrator" },
          };
          const existing = requestedId === undefined ? undefined : yield* findThread(requestedId);
          if (existing !== undefined) {
            if (existing.spawnedBy === undefined || existing.workspaceId !== workspaceId) {
              return yield* toolError(
                tool,
                refusal(
                  "not_your_worker",
                  `clientRequestId ${input.clientRequestId} made “${existing.title}” [thread ${existing.id}], which is no longer one of your workers. Use a new id for a new worker.`,
                ),
              );
            }
            // A spawn ends with its audit entry; without one, a crash cut short what comes after the
            // thread row, and this finishes it as the first call would have. With one, the worker is
            // left as it is now, a group the user moved it to since included.
            const finished = (yield* store.listOrchestrationEvents(
              workspaceId,
              existing.createdAt,
            )).some(
              (event) =>
                event.kind === "spawn" &&
                (event.data as { readonly threadId?: unknown } | null)?.threadId === existing.id,
            );
            workerWorkspaces.set(existing.id, workspaceId);
            if (existing.parked) parkedWorkers.add(existing.id);
            if (!finished) {
              const now = yield* Clock.currentTimeMillis;
              // The memo may already exist, made by the brief's turn start before the crash, so
              // the call's scope is filled in rather than the memo written whole.
              const scope =
                input.scope === undefined || input.scope.length === 0 ? undefined : input.scope;
              yield* updateOutbox(workspaceId, (outbox) => {
                const memo = outbox.workers[existing.id];
                if (memo !== undefined && (scope === undefined || memo.scope !== undefined)) {
                  return [outbox, undefined];
                }
                const next: WorkerMemo = {
                  ...(memo ?? emptyWorkerMemo(now)),
                  ...(scope === undefined ? {} : { scope }),
                };
                return [
                  { ...outbox, workers: { ...outbox.workers, [existing.id]: next } },
                  undefined,
                ];
              });
              const held = [existing.checkout, ...(existing.extraCheckouts ?? [])].flatMap(
                (checkout) => {
                  const project = projectOfCheckout(projects.values(), checkout);
                  return project === undefined ? [] : [project];
                },
              );
              yield* joinWorkspace(state, caller.id, held);
              const group = input.group === undefined ? undefined : featureSlug(input.group);
              if (group !== undefined) {
                yield* joinGroup(workspaceId, existing.spawnedBy.feature, group);
              }
              const briefed =
                (yield* store.listMessages(existing.id)).some((m) => m.role === "user") ||
                (yield* store.listQueue(existing.id)).length > 0;
              if (!briefed) {
                yield* runtimes
                  .send(existing.id, brief)
                  .pipe(Effect.mapError((e) => toolError(tool, e.message)));
              }
              yield* sampleExtras(existing);
              const [own, ...others] = held;
              yield* store.appendOrchestrationEvent(workspaceId, {
                at: now,
                kind: "spawn",
                data: {
                  threadId: existing.id,
                  feature: existing.spawnedBy.feature,
                  projectId: existing.projectId,
                  ...(existing.checkout.branch === undefined
                    ? {}
                    : { branch: existing.checkout.branch }),
                  ...(own === undefined || others.length === 0
                    ? {}
                    : { alsoIn: others.map((other) => other.id) }),
                  ...(group === undefined ? {} : { group }),
                },
              });
              yield* orchestrationChanged(workspaceId);
            }
            return { ...spawnedResult(existing, projects), existing: true as const };
          }
          const limited = byUser === undefined ? retryingIn(workspaceId) : undefined;
          if (limited !== undefined) {
            const name = (yield* findThread(limited))?.title || limited;
            return yield* toolError(
              tool,
              refusal(
                "rate",
                `"${name}" (${limited}) is being rate limited, so no worker is spawned until it clears. End your turn; a digest will follow.`,
              ),
            );
          }
          const slug = featureSlug(input.feature);
          const branch =
            input.branch?.trim() || (slug === undefined ? undefined : featureBranch(slug));
          if (slug === undefined || branch === undefined) {
            return yield* toolError(
              tool,
              refusal(
                "invalid_feature",
                `"${input.feature}" isn't a usable feature name. Use a short slug such as mail-trigger.`,
              ),
            );
          }
          if (byUser === undefined && state.pausedFeatures?.includes(slug) === true) {
            return yield* toolError(
              tool,
              refusal(
                "feature_paused",
                `The user paused feature ${slug}, so no worker is spawned for it. Only the user can resume it; a digest says when they do.`,
              ),
            );
          }
          const group = input.group === undefined ? undefined : featureSlug(input.group);
          if (input.group !== undefined && group === undefined) {
            return yield* toolError(
              tool,
              refusal(
                "invalid_group",
                `"${input.group}" isn't a usable group name. Use a short slug such as release-0-4.`,
              ),
            );
          }
          const project = yield* resolveProject(tool, input.project, state, call);
          const others: Array<Project> = [];
          for (const named of input.alsoIn ?? []) {
            const other = yield* resolveProject(tool, named, state, call);
            if (other.id === project.id || others.some((known) => known.id === other.id)) {
              return yield* toolError(
                tool,
                refusal(
                  "duplicate_repo",
                  `alsoIn names ${other.name} twice, or as the worker's own project. Name each repo once: the main one as project, the rest in alsoIn.`,
                ),
              );
            }
            others.push(other);
          }
          const found = yield* survey(state, true);
          // At the concurrency cap, or outside the workspace: the approval gate asked the user
          // before this handler ran (`spawnNeedsApproval`), and they said yes to this one. Nothing
          // else about a spawn is rationed.
          const settings = yield* store.getSettings;
          // Without a roster the one model is the orchestrator's own, which it runs on.
          const picked =
            byUser === undefined
              ? yield* workerModel(
                  tool,
                  caller,
                  state.charter,
                  input.model,
                  state.charter.workerModels === undefined
                    ? undefined
                    : yield* rosterHere(state.charter.workerModels, state.charter),
                )
              : {
                  // The user's pick, checked against the roster as it runs now, else its default.
                  model: yield* taskWorkers(state.charter, caller.model, byUser.model).pipe(
                    Effect.mapError((error) => toolError(tool, error.message)),
                    Effect.flatMap((workers) =>
                      workers.worker === undefined
                        ? Effect.fail(
                            toolError(tool, workers.refusal ?? "No worker model can run here."),
                          )
                        : Effect.succeed(workers.worker),
                    ),
                  ),
                  instead: undefined,
                };
          const chosen = picked.model;
          if (byUser?.model !== undefined && !sameTaskModel(chosen, byUser.model))
            return yield* toolError(
              tool,
              "The task's selected worker changed. Check the task preview and start again.",
            );
          const mode = startModeFor(chosen.agent, settings, state.charter);
          const verdict = workerModelVerdict({
            model: chosen,
            autonomy: autonomyOf(state.charter),
            gateReady: yield* nativeGateReady(chosen.agent),
            hasGatewayProfile:
              chosen.profileId !== undefined &&
              (yield* store.listProfiles).some((profile) => profile.id === chosen.profileId),
            mode,
            gateHoldsInMode: gateHoldsIn(chosen.agent, mode),
          });
          if (!verdict.ok) return yield* toolError(tool, refusal(verdict.code, verdict.reason));
          const efforts =
            input.effort === undefined
              ? []
              : yield* selectableModels(store, hosts, chosen.agent, chosen.profileId).pipe(
                  Effect.map((models) => models.find((m) => m.id === chosen.model)?.efforts ?? []),
                  Effect.orElseSucceed((): ReadonlyArray<ReasoningVariant> => []),
                );
          const warnings: Array<string> = [];
          if (picked.instead !== undefined) {
            warnings.push(
              `${picked.instead.of} is unavailable here (${picked.instead.why}), so this worker runs on ${workerModelLabel(chosen)}. Tell the user.`,
            );
          }
          const effort =
            input.effort !== undefined && efforts.includes(input.effort) ? input.effort : undefined;
          if (input.effort !== undefined && effort === undefined) {
            warnings.push(`${chosen.model} doesn't take effort ${input.effort}; it was left out.`);
          }
          // A charter entry comes whole, its effort included. Without a list the model is the
          // orchestrator's own, whose effort was chosen for orchestrating and isn't handed on.
          const { variant: _variant, ...bare } = chosen;
          const model: ModelRef =
            effort !== undefined
              ? { ...bare, variant: effort }
              : state.charter.workerModels === undefined
                ? bare
                : chosen;

          const finished = finishedWorkers(found.features);
          const siblings = found.workers.filter(
            (worker) => worker.projectId === project.id && !finished.has(worker.id),
          );
          const readAlso: Array<string> = [];
          for (const id of input.readAlso ?? []) {
            const sibling = found.workers.find((worker) => worker.id === id);
            if (sibling === undefined) {
              return yield* toolError(
                tool,
                refusal(
                  "not_your_worker",
                  `readAlso names ${id}, which isn't one of your workers.`,
                ),
              );
            }
            readAlso.push(effectiveCheckout(sibling).path);
          }
          if (input.scope !== undefined && input.scope.length > 0) {
            for (const sibling of siblings) {
              const shared = scopeOverlap(
                input.scope,
                found.outbox.workers[sibling.id]?.scope ?? [],
              );
              if (shared.length > 0 && found.outbox.workers[sibling.id]?.scope !== undefined) {
                warnings.push(
                  `Advisory scope overlap with “${sibling.title}” [thread ${sibling.id}] on ${shared.map((path) => path || "the whole repo").join(", ")}; this does not establish a git conflict or coordination blocker.`,
                );
              }
            }
          }

          const request = {
            kind: "newWorktree" as const,
            branch,
            ...(input.base === undefined ? {} : { base: input.base }),
          };
          const prepareIn = (repo: Project) =>
            creator.prepare(request, repo.root).pipe(
              Effect.catchTag("CheckoutInUse", (e) =>
                Effect.gen(function* () {
                  const user = (yield* store.listThreads).find((thread) =>
                    heldCheckoutPaths([thread]).some((held) => samePath(held, e.path)),
                  );
                  return yield* toolError(
                    tool,
                    user === undefined
                      ? `Branch ${branch} is already checked out in ${repo.name}: ${e.message}`
                      : `Branch ${branch} is already checked out by “${user.title}” [thread ${user.id}] in ${repo.name}. Message that worker, or pass another branch.`,
                  );
                }),
              ),
              Effect.mapError((e) => (e instanceof AppToolError ? e : toolError(tool, e.message))),
            );
          if (requestedId !== undefined && input.clientRequestId !== undefined) {
            const key = input.clientRequestId;
            recorded = { key, id: requestedId, workspaceId };
            yield* updateOutbox(workspaceId, (outbox) => [
              outbox.requests[key] === requestedId
                ? outbox
                : { ...outbox, requests: { ...outbox.requests, [key]: requestedId } },
              undefined,
            ]);
          }
          // From git's check to the thread holding them, beside a spawn in another workspace that
          // shares these repos.
          const worker = yield* checkoutLock.withLocks(
            yield* Effect.forEach([project, ...others], (repo) => checkoutKey(repo.root)),
            Effect.gen(function* () {
              const checkout = yield* prepareIn(project);
              const extraCheckouts: Array<Checkout> = [];
              for (const other of others) {
                // No half-made worker: a repo that refuses takes the worktrees made so far with it.
                const made = yield* prepareIn(other).pipe(
                  Effect.catch((e) =>
                    Effect.forEach([checkout, ...extraCheckouts], checkouts.discard, {
                      discard: true,
                    }).pipe(
                      Effect.andThen(
                        toolError(
                          tool,
                          `No worker was started, because ${other.name} couldn't give it a worktree: ${e.message}`,
                        ),
                      ),
                    ),
                  ),
                );
                extraCheckouts.push(made);
              }
              return yield* runtimes
                .create({
                  projectRoot: project.root,
                  checkout,
                  model,
                  mode,
                  workspaceId,
                  spawnedBy: { threadId: caller.id, feature: slug },
                  extraCheckouts,
                  additionalDirectories: [
                    ...extraCheckouts.map((extra) => extra.path),
                    ...readAlso,
                  ],
                  ...(byUser === undefined
                    ? {
                        title: input.title.trim(),
                        input: brief,
                      }
                    : { id: byUser.id, input: byUser.input }),
                  ...(requestedId === undefined ? {} : { id: requestedId }),
                })
                .pipe(
                  // The user's retry names the same feature, whose worktree would be in the way.
                  Effect.onError(() =>
                    byUser === undefined
                      ? Effect.void
                      : Effect.forEach([checkout, ...extraCheckouts], checkouts.discard, {
                          discard: true,
                        }),
                  ),
                  Effect.mapError((e) => toolError(tool, e.message)),
                );
            }),
          );

          workerWorkspaces.set(worker.id, workspaceId);
          if (mode === "auto") openedInAuto.add(worker.id);
          const now = yield* Clock.currentTimeMillis;
          yield* updateOutbox(workspaceId, (outbox) => [
            withNotes(
              {
                ...outbox,
                workers: {
                  ...outbox.workers,
                  [worker.id]: {
                    ...emptyWorkerMemo(now),
                    ...(input.scope === undefined || input.scope.length === 0
                      ? {}
                      : { scope: input.scope }),
                    ...(byUser === undefined ? {} : { userIntervened: true, userInputAt: now }),
                  },
                },
              },
              byUser === undefined
                ? []
                : [
                    `The user started "${worker.title}" [thread ${worker.id}] in ${project.name} themselves, for feature ${slug}. It is theirs until it reports, they hand it back, or it sits idle ${USER_HOLD_IDLE_MS / 60_000} minutes; follow its pull request like your own workers'.`,
                  ],
            ),
            undefined,
          ]);
          if (byUser !== undefined) yield* armHold(worker.id, USER_HOLD_IDLE_MS);
          yield* joinWorkspace(state, caller.id, [project, ...others]);
          if (group !== undefined) yield* joinGroup(workspaceId, slug, group);
          yield* sampleExtras(worker);
          yield* store.appendOrchestrationEvent(workspaceId, {
            at: now,
            kind: "spawn",
            data: {
              threadId: worker.id,
              feature: slug,
              projectId: project.id,
              branch,
              ...(others.length === 0 ? {} : { alsoIn: others.map((other) => other.id) }),
              ...(group === undefined ? {} : { group }),
            },
          });
          yield* orchestrationChanged(workspaceId);
          // A repo registered by this call isn't in the list read before it.
          for (const known of [project, ...others]) projects.set(known.id, known);
          // Spawned on a login at its limit: the brief waits in the worker's queue for the reset.
          const limitWait = (yield* findThread(worker.id))?.limitWait;
          return {
            ...spawnedResult(worker, projects),
            ...(warnings.length === 0 ? {} : { warning: warnings.join(" ") }),
            ...(limitWait === undefined ? {} : { queued: limitQueuedNote(limitWait, now) }),
          };
        }),
      ).pipe(
        // A spawn that failed before its thread existed leaves no request to find it by, so a
        // branch it gave up can go to another worker without stranding a retry of this one.
        Effect.onError(() => (recorded === undefined ? Effect.void : forgetRequest(recorded))),
      ),
    );
  };

  const forgetRequest = (request: { key: string; id: ThreadId; workspaceId: WorkspaceId }) =>
    Effect.gen(function* () {
      if ((yield* findThread(request.id)) !== undefined) return;
      yield* updateOutbox(request.workspaceId, (outbox) => {
        if (outbox.requests[request.key] !== request.id) return [outbox, undefined];
        const { [request.key]: _, ...requests } = outbox.requests;
        return [{ ...outbox, requests }, undefined];
      });
    });

  /** Puts a feature in a group, making the group if need be; a no-op when it is there already. */
  const joinGroup = (workspaceId: WorkspaceId, feature: string, group: string) =>
    store
      .updateWorkspace(workspaceId, (current) => {
        const before = current.groups ?? {};
        const groups = regroup(before, feature, group);
        return groups === before ? current : { ...current, groups };
      })
      .pipe(Effect.ignore);

  const spawnWorker: OrchestrationShape["spawnWorker"] = (callerId, input) =>
    pausedSpawnGate(callerId, input).pipe(
      Effect.andThen(spawnBreaker.gate(callerId, input)),
      Effect.flatMap((held): Effect.Effect<HeldSpawn | RouteOffer | undefined> =>
        held === undefined ? routeGate(callerId, input) : Effect.succeed(held),
      ),
      Effect.flatMap(
        (offer): Effect.Effect<SpawnedWorker | HeldSpawn | RouteOffer, AppToolError> =>
          offer !== undefined
            ? Effect.succeed(offer)
            : holdGate(callerId, input).pipe(
                Effect.flatMap(
                  (held): Effect.Effect<SpawnedWorker | HeldSpawn | RouteOffer, AppToolError> =>
                    held !== undefined
                      ? routeHeld(callerId, input, held)
                      : limitGate(callerId, input).pipe(
                          Effect.matchEffect({
                            onFailure: (refused) => routePaused(callerId, input, refused),
                            onSuccess: () => spawnFor(callerId, input),
                          }),
                        ),
                ),
              ),
      ),
    );

  const briefFooter: OrchestrationShape["briefFooter"] = (callerId) =>
    authorityOf(callerId).pipe(
      Effect.map((authority) =>
        authority === undefined ? undefined : briefFooterOf(authority.state.charter),
      ),
    );

  const startWorker: OrchestrationShape["startWorker"] = (workspaceId, input) =>
    Effect.gen(function* () {
      const state = yield* store.getWorkspace(workspaceId);
      const holder = state.workspace.orchestratorThreadId;
      if (holder === undefined || (yield* findThread(holder)) === undefined) {
        return yield* new InvalidState({
          message: "This workspace has no orchestrator open to follow the worker.",
        });
      }
      if (!state.workspace.projectIds.includes(input.projectId)) {
        return yield* new InvalidState({
          message: `That repo isn't one of the "${state.workspace.name}" workspace's.`,
        });
      }
      const taken = new Set(
        (yield* store.listThreads).flatMap((thread) =>
          thread.workspaceId === workspaceId && thread.spawnedBy !== undefined
            ? [thread.spawnedBy.feature]
            : [],
        ),
      );
      const feature = taskFeature(input.input.text, taken);
      // The workspace's standing instructions reach a worker the user starts too.
      const text = withBriefFooter(input.input.text, briefFooterOf(state.charter));
      const spawned = yield* spawnFor(
        holder,
        {
          project: input.projectId,
          feature,
          title: feature,
          brief: text,
          ...(input.base === undefined ? {} : { base: input.base }),
        },
        {
          id: input.id,
          input: { ...input.input, text },
          ...(input.model === undefined ? {} : { model: input.model }),
        },
      ).pipe(
        // Worded for the orchestrator, whose code the user has no use for.
        Effect.mapError((e) => new InvalidState({ message: e.message.replace(/^[a-z_]+: /, "") })),
      );
      return yield* store.getThread(spawned.threadId);
    });

  return {
    spawnNeedsApproval,
    describeSpawn,
    checkWorkerModel,
    spawnFor,
    joinGroup,
    spawnWorker,
    briefFooter,
    startWorker,
  };
};
