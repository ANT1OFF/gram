// `add_worker_repo`: a worker gets a worktree in another
// repository of its workspace, after the approval an outside one needs.

import { AppToolError, MAX_EXTRA_PRS } from "@gram/contracts";
import { samePath } from "@gram/git";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { heldCheckoutPaths } from "../../runtime/create-in-checkout.ts";
import { featureBranch, refusal } from "../rules.ts";
import {
  projectOfCheckout,
  repoLabel,
  worktreesOf,
  toolError,
  type OrchestrationKit,
  underKeysOf,
} from "./kit.ts";
import { type AddedWorkerRepo, type OrchestrationShape } from "./shape.ts";
import type { Projects } from "./projects.ts";
import type { Sends } from "./sends.ts";

/** The most repos a worker spans beside its own: each wants a PR, and a thread follows `MAX_EXTRA_PRS` extras. */
export const MAX_WORKER_REPOS = MAX_EXTRA_PRS;

/** What worker repos take from project lookup and sends. */
export interface WorkerReposDeps {
  readonly outsideWorkspace: Projects["outsideWorkspace"];
  readonly repoNames: Projects["repoNames"];
  readonly guardSend: Sends["guardSend"];
  readonly resolveProject: Projects["resolveProject"];
  readonly joinWorkspace: Projects["joinWorkspace"];
  readonly noteMessage: Sends["noteMessage"];
  readonly projectCall: Projects["projectCall"];
}

/** `add_worker_repo`, its approval and its description. */
export const makeWorkerRepos = (kit: OrchestrationKit, deps: WorkerReposDeps) => {
  const {
    authorityOf,
    delegated,
    findThread,
    spawnLock,
    checkoutLock,
    checkoutKey,
    authorityKeys,
    requireAuthority,
    store,
    creator,
    runtimes,
    checkouts,
    sampleExtras,
    reload,
    orchestrationChanged,
  } = kit;
  const {
    outsideWorkspace,
    repoNames,
    guardSend,
    resolveProject,
    joinWorkspace,
    noteMessage,
    projectCall,
  } = deps;

  const addRepoNeedsApproval: OrchestrationShape["addRepoNeedsApproval"] = (callerId, input) =>
    Effect.gen(function* () {
      const authority = yield* authorityOf(callerId);
      // Somebody else's thread, or no authority: the handler refuses, and a card first would
      // only ask the user for something that then doesn't happen.
      if (authority === undefined || !(yield* delegated(callerId, input.threadId))) return false;
      const outside = yield* outsideWorkspace("add_worker_repo", [input.project], authority.state);
      return outside.length > 0;
    }).pipe(Effect.catchCause(() => Effect.succeed(true)));

  const describeAddRepo: OrchestrationShape["describeAddRepo"] = (callerId, input) =>
    Effect.gen(function* () {
      const worker = (yield* findThread(input.threadId))?.title ?? input.threadId;
      const authority = yield* authorityOf(callerId);
      const [repo] =
        authority === undefined
          ? [input.project]
          : yield* repoNames("add_worker_repo", [input.project], authority.state);
      const plain = `Give “${worker}” a worktree in ${repo ?? input.project}`;
      if (authority === undefined) return plain;
      const [outside] = yield* outsideWorkspace(
        "add_worker_repo",
        [input.project],
        authority.state,
      );
      return outside === undefined
        ? plain
        : `Add ${repoLabel(outside)} to the "${authority.state.workspace.name}" workspace, and give “${worker}” a worktree there`;
    }).pipe(
      Effect.catchCause(() => Effect.succeed(`Give a worker a worktree in ${input.project}`)),
    );

  const addWorkerRepo: OrchestrationShape["addWorkerRepo"] = (
    callerId,
    input,
  ): Effect.Effect<AddedWorkerRepo, AppToolError> => {
    return underKeysOf(
      spawnLock,
      authorityKeys(callerId),
      projectCall(input.identities, (call) =>
        Effect.gen(function* () {
          const tool = "add_worker_repo";
          const { thread: caller, state } = yield* requireAuthority(tool, callerId);
          const workspaceId = state.workspace.id;
          const target = yield* findThread(input.threadId);
          if (target === undefined || !(yield* delegated(callerId, input.threadId))) {
            return yield* toolError(
              tool,
              refusal(
                "not_your_worker",
                `${input.threadId} isn't one of your workers, so it gets no worktree from you.`,
              ),
            );
          }
          // It ends in a message to the worker, so it is held to what any such message is: not
          // while paused, and not to a worker the user has taken over.
          yield* guardSend(tool, callerId, target.id);
          const project = yield* resolveProject(tool, input.project, state, call);
          const projects = yield* store.listProjects;
          const held = [target.checkout, ...(target.extraCheckouts ?? [])];
          if (
            project.id === target.projectId ||
            held.some((checkout) => projectOfCheckout([project], checkout) !== undefined)
          ) {
            return yield* toolError(
              tool,
              refusal(
                "duplicate_repo",
                `“${target.title}” already works in ${project.name}; a worker has one worktree per repo.`,
              ),
            );
          }
          if (held.length > MAX_WORKER_REPOS) {
            return yield* toolError(
              tool,
              `“${target.title}” already spans ${held.length} repos, which is as many as one worker's pull requests can be followed in. Start another worker for ${project.name}.`,
            );
          }
          const branch =
            target.checkout.branch ??
            (target.spawnedBy === undefined ? undefined : featureBranch(target.spawnedBy.feature));
          if (branch === undefined) {
            return yield* toolError(
              tool,
              `“${target.title}” has no branch to follow into ${project.name}.`,
            );
          }
          // From git's check to the worker holding it, beside a spawn in another workspace that
          // shares this repo.
          const { checkout, updated } = yield* checkoutLock.withLock(
            yield* checkoutKey(project.root),
            Effect.gen(function* () {
              const made = yield* creator
                .prepare({ kind: "newWorktree", branch }, project.root)
                .pipe(
                  Effect.catchTag("CheckoutInUse", (e) =>
                    Effect.gen(function* () {
                      const user = (yield* store.listThreads).find((thread) =>
                        heldCheckoutPaths([thread]).some((path) => samePath(path, e.path)),
                      );
                      return yield* toolError(
                        tool,
                        user === undefined
                          ? `Branch ${branch} is already checked out in ${project.name}: ${e.message}`
                          : `Branch ${branch} is already checked out by “${user.title}” [thread ${user.id}] in ${project.name}.`,
                      );
                    }),
                  ),
                  Effect.mapError((e) =>
                    e instanceof AppToolError ? e : toolError(tool, e.message),
                  ),
                );
              const grown = yield* runtimes
                .updateThread(target.id, (current) => ({
                  ...current,
                  extraCheckouts: [...(current.extraCheckouts ?? []), made],
                }))
                .pipe(
                  Effect.catchTag("ThreadNotFound", () =>
                    checkouts
                      .discard(made)
                      .pipe(
                        Effect.andThen(
                          toolError(
                            tool,
                            `${input.threadId} was closed before it got the worktree.`,
                          ),
                        ),
                      ),
                  ),
                );
              return { checkout: made, updated: grown };
            }),
          );
          yield* sampleExtras(updated);
          yield* joinWorkspace(state, caller.id, [project]);
          // The folder is granted live where the agent can take it; the reload, once the worker is
          // idle, is for its role prompt, which lists the worktrees it holds.
          yield* runtimes.addDirectories(target.id, [checkout.path]).pipe(Effect.ignore);
          yield* reload(target.id);
          const [named] = worktreesOf(projects, [checkout]);
          const sent = yield* runtimes
            .send(target.id, {
              text: `You now also have a worktree in ${project.name}: ${checkout.path}${
                checkout.branch === undefined ? "" : ` (branch ${checkout.branch})`
              }. It is one of your folders from here on: edit and commit there, never in that repo's main checkout. If the change there needs a pull request, open one and bind it with \`pr_bind\` (its \`repo\` and \`number\`, \`add: true\`).`,
              origin: { threadId: caller.id, title: caller.title, depth: 1, role: "orchestrator" },
            })
            .pipe(Effect.mapError((e) => toolError(tool, e.message)));
          yield* noteMessage(callerId, target.id);
          yield* store.appendOrchestrationEvent(workspaceId, {
            at: yield* Clock.currentTimeMillis,
            kind: "repoAdded",
            data: { threadId: target.id, projectId: project.id, branch },
          });
          yield* orchestrationChanged(workspaceId);
          return {
            threadId: target.id,
            title: target.title,
            project: named?.project ?? project.name,
            worktree: checkout.path,
            ...(checkout.branch === undefined ? {} : { branch: checkout.branch }),
            delivered: sent.queued ? ("queued" as const) : ("sent" as const),
          };
        }),
      ),
    );
  };

  return { addRepoNeedsApproval, describeAddRepo, addWorkerRepo };
};
