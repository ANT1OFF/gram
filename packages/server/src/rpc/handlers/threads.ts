import {
  effectiveCheckout,
  GitError,
  InvalidState,
  NotFound,
  plainWaitText,
  ThreadId,
  waitTitleOf,
  type Thread,
  type CheckoutRequest,
  type TaskChipData,
  type UserInput,
} from "@gram/contracts";
import {
  Checkpoints,
  checkpointRef,
  git as runGit,
  Pr,
  Proc,
  samePath,
  sanitizeBase,
} from "@gram/git";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { attachmentsDir, withDraftAttachments } from "../../attachments/attachments.ts";
import { ServerConfig } from "../../config.ts";
import { EventHub } from "../../events/event-hub.ts";
import { expandHome, resolveFolder } from "../../fs/folders.ts";
import { deleteMergedBranch } from "../../git/branch-cleanup.ts";
import { GitStatePublisher } from "../../git/publisher.ts";
import { HelperScheduler } from "../../helper/scheduler.ts";
import { restoreThreadWorktree } from "../../git/restore-worktree.ts";
import { Orchestration } from "../../orchestration/service.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { PlanKeeper } from "../../plans/keeper.ts";
import { ThreadPlans } from "../../plans/service.ts";
import { ThreadWaits } from "../../waits/service.ts";
import { ThreadPorts } from "../../ports/service.ts";
import { endCheckpointId } from "../../git/turn-hooks.ts";
import { closeAtRest } from "../../runtime/close-at-rest.ts";
import { TerminalGate } from "../../terminal/gate.ts";
import { makeThreadCreator } from "../../runtime/create-in-checkout.ts";
import { CheckoutService } from "../../runtime/hooks.ts";
import { ThreadRuntimes, type ForkPlan } from "../../runtime/thread-runtimes.ts";
import type { Handlers } from "./common.ts";
import { taskCheckoutRequest } from "./task-checkout.ts";

/**
 * The checkouts a close holds while it removes a worktree: the worktree `checkouts.release` deletes,
 * and the checkout the thread follows the agent in when that's elsewhere.
 */
export const heldForRemoval = (
  thread: Pick<Thread, "checkout" | "currentCheckout">,
  removing: boolean,
): Array<string> => {
  if (!removing || thread.checkout.kind !== "worktree") return [];
  const effective = effectiveCheckout(thread).path;
  return samePath(effective, thread.checkout.path)
    ? [thread.checkout.path]
    : [thread.checkout.path, effective];
};

/** A thread at `MAX_OPEN_WAITS`, as the client hears of it. */
const waitsFull = (threadId: ThreadId) => (full: { readonly open: number }) =>
  Effect.fail(
    new InvalidState({
      message: `${full.open} items already wait on you; mark one done first`,
      threadId,
    }),
  );

/** `thread.*`, `task.*` and `ui.showPanel`. */
export const threadHandlers = Effect.gen(function* () {
  const runtimes = yield* ThreadRuntimes;
  const store = yield* ThreadStore;
  const plans = yield* ThreadPlans;
  const waits = yield* ThreadWaits;
  const keeper = Option.getOrUndefined(yield* Effect.serviceOption(PlanKeeper));
  const helper = Option.getOrUndefined(yield* Effect.serviceOption(HelperScheduler));
  /** Counts what the user did with a helper's suggestion, for its keep rate. */
  const waitEvent = (event: "kept" | "dismissed" | "restored") =>
    helper === undefined ? Effect.void : helper.recordEvent("wait", event);
  const hub = yield* EventHub;
  const checkouts = yield* CheckoutService;
  const checkpoints = yield* Checkpoints;
  const config = yield* ServerConfig;
  // Absent in runtime-only test layers, where no branch is ever deleted.
  const pr = yield* Effect.serviceOption(Pr);
  const proc = yield* Effect.serviceOption(Proc);
  // Absent in runtime-only test layers, where there are no git watchers to release.
  const publisher = yield* Effect.serviceOption(GitStatePublisher);
  const releaseWatchers = Option.match(publisher, {
    onNone: () => Effect.void,
    onSome: (git) => git.sync,
  });
  // Absent in runtime-only test layers, where a close only at rest is then always refused.
  const ports = Option.getOrUndefined(yield* Effect.serviceOption(ThreadPorts));
  const gate = Option.getOrUndefined(yield* Effect.serviceOption(TerminalGate));
  // Absent in runtime-only test layers, where no thread has a role.
  const orchestration = Option.getOrUndefined(yield* Effect.serviceOption(Orchestration));
  const holdWatch = (path: string) =>
    Option.match(publisher, {
      onNone: () => Effect.succeed(Effect.void),
      onSome: (git) => git.hold(path),
    });

  /**
   * The commit `ref` names in the checkout at `path`; `undefined` when it names none there, outside
   * a repo, before a first commit, or without `Proc`. For `HEAD`, the commit rather than the thread's
   * recorded branch: a session switches branches as it works.
   */
  const commitOf = (path: string, ref: string) =>
    Option.match(proc, {
      onNone: () => Effect.succeed<string | undefined>(undefined),
      onSome: (service) =>
        Effect.gen(function* () {
          // The worktree layer's own gate first, so nothing it would refuse is resolved here.
          if ((yield* sanitizeBase(path, ref)) === undefined) return undefined;
          const out = yield* runGit(path, [
            "rev-parse",
            "--verify",
            "--quiet",
            `${ref.trim()}^{commit}`,
          ]);
          return out.status === 0 ? out.stdout.trim() || undefined : undefined;
        }).pipe(
          Effect.orElseSucceed(() => undefined),
          Effect.provideService(Proc, service),
        ),
    });

  const creator = makeThreadCreator({ store, checkouts, runtimes });
  const prepareCheckout = creator.prepare;

  /**
   * A fork's checkout other than the source's own. A new worktree branches from the source branch
   * and gets the fork point's checkpoint files when the source recorded them.
   */
  const prepareForkCheckout = (plan: ForkPlan, request: CheckoutRequest) =>
    Effect.gen(function* () {
      const { source } = plan;
      const project = (yield* store.listProjects).find((p) => p.id === source.projectId);
      if (project === undefined) {
        return yield* new NotFound({ entity: "project", id: source.projectId });
      }
      const branched =
        request.kind === "newWorktree" &&
        request.base === undefined &&
        source.checkout.branch !== undefined
          ? { ...request, base: source.checkout.branch }
          : request;
      const checkout = yield* prepareCheckout(branched, project.root).pipe(
        Effect.catchTag("CheckoutInUse", (e) =>
          Effect.fail(new InvalidState({ message: e.message })),
        ),
      );
      if (request.kind === "newWorktree" && plan.turnId !== undefined) {
        const checkpoint = plan.role === "user" ? plan.turnId : endCheckpointId(plan.turnId);
        yield* checkpoints
          .restoreFiles(checkout.path, checkpointRef(source.id, checkpoint))
          .pipe(
            Effect.catch((e) =>
              Effect.logWarning("couldn't restore the fork point's files").pipe(
                Effect.annotateLogs({ threadId: source.id, cause: e.message }),
              ),
            ),
          );
      }
      return checkout;
    });

  const setTaskStatus = (
    threadId: Parameters<typeof store.getTask>[0],
    taskId: Parameters<typeof store.getTask>[1],
    status: TaskChipData["status"],
  ) =>
    Effect.gen(function* () {
      const { messageId, task } = yield* store.getTask(threadId, taskId);
      if (task.status !== "offered") {
        return yield* new InvalidState({ message: `task is already ${task.status}`, threadId });
      }
      const next: TaskChipData = { ...task, status };
      yield* store.putTask(threadId, messageId, next);
      yield* runtimes.updateDataPart(threadId, messageId, {
        type: "data-task-chip",
        id: task.id,
        data: next,
      });
      return next;
    });

  return {
    "thread.create": ({
      projectRoot,
      checkout,
      model,
      mode,
      title,
      input,
      resumeSessionId,
      codexHome,
      draftId,
    }) =>
      Effect.gen(function* () {
        if (resumeSessionId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(resumeSessionId)) {
          return yield* new InvalidState({ message: `Not a session id: ${resumeSessionId}` });
        }
        const selected = model ?? (yield* store.getSettings).agents.defaultModel;
        // Check the folders first, so a typo reads "Folder not found" rather than a git or
        // platform failure from deeper in.
        const root = yield* resolveFolder(projectRoot);
        const request: CheckoutRequest =
          checkout.kind === "existingWorktree"
            ? { ...checkout, path: yield* resolveFolder(checkout.path) }
            : checkout;
        const resolved = yield* prepareCheckout(request, root);
        // Chosen here so the draft's staged attachments move into the thread before the first send.
        const id = Schema.decodeSync(ThreadId)(randomUUID());
        const create = (firstInput: UserInput | undefined) =>
          runtimes.create({
            id,
            projectRoot: root,
            checkout: resolved,
            ...(selected === undefined ? {} : { model: selected }),
            ...(mode === undefined ? {} : { mode }),
            ...(title === undefined ? {} : { title }),
            ...(firstInput === undefined ? {} : { input: firstInput }),
            ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
            ...(codexHome === undefined ? {} : { codexHome }),
          });
        return yield* draftId === undefined
          ? create(input)
          : withDraftAttachments(attachmentsDir(config.dataDir), draftId, id, input, create);
      }),
    "thread.send": ({ threadId, input }) => runtimes.send(threadId, input),
    "thread.steer": ({ threadId, input }) => runtimes.steer(threadId, input),
    "thread.interrupt": ({ threadId }) => runtimes.interrupt(threadId),
    "thread.resumeLimitWait": ({ threadId }) => runtimes.resumeLimitWait(threadId),
    "thread.cancelLimitWait": ({ threadId }) => runtimes.cancelLimitWait(threadId),
    "thread.stopTask": ({ threadId, taskId }) => runtimes.stopTask(threadId, taskId),
    "thread.restartSession": ({ threadId, midTurn }) => runtimes.restartSession(threadId, midTurn),
    "thread.startSession": ({ threadId }) => runtimes.startSession(threadId),
    "thread.respond": ({ threadId, requestId, answer }) =>
      runtimes.respond(threadId, requestId, answer),
    "thread.respondMany": ({ answers }) => runtimes.respondMany(answers),
    "thread.setMode": ({ threadId, mode }) => runtimes.setMode(threadId, mode),
    "thread.setModel": ({ threadId, model }) =>
      // Admission is an invariant of a role-bearing or spawned thread, so the user's own picker
      // is held to it too.
      (orchestration === undefined
        ? Effect.void
        : orchestration.checkModelChange(threadId, model)
      ).pipe(Effect.andThen(runtimes.setModel(threadId, model))),
    "thread.rename": ({ threadId, title }) =>
      runtimes
        .updateThread(threadId, (t) => ({ ...t, title, userNamed: true }))
        .pipe(Effect.asVoid),
    "thread.addDirectory": ({ threadId, path }) =>
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId);
        const expanded = expandHome(path.trim());
        const folder = yield* resolveFolder(
          isAbsolute(expanded) ? expanded : join(effectiveCheckout(thread).path, expanded),
        );
        yield* runtimes.addDirectories(threadId, [folder]);
        return folder;
      }),
    "thread.pin": ({ threadId, pinned }) =>
      runtimes.updateThread(threadId, (t) => ({ ...t, pinned })).pipe(Effect.asVoid),
    // Parking and closing drop the thread's git watcher; returning only once it's released.
    "thread.park": ({ threadId, parked }) =>
      runtimes
        .updateThread(threadId, (t) => ({ ...t, parked }))
        .pipe(Effect.andThen(releaseWatchers), Effect.asVoid),
    "thread.label": ({ threadId, labels }) =>
      Effect.gen(function* () {
        const known = new Set((yield* store.listLabels).map((l) => l.id));
        const unknown = labels.find((id) => !known.has(id));
        if (unknown !== undefined) return yield* new NotFound({ entity: "label", id: unknown });
        yield* runtimes.updateThread(threadId, (t) => ({ ...t, labels }));
      }),
    "thread.restoreWorktree": ({ threadId, fromPr }) =>
      restoreThreadWorktree(threadId, fromPr === true).pipe(
        Effect.provideService(ThreadStore, store),
        Effect.provideService(CheckoutService, checkouts),
        Option.isSome(publisher)
          ? Effect.provideService(GitStatePublisher, publisher.value)
          : (effect) => effect,
      ),
    "thread.close": ({ threadId, removeWorktree, permissionRules, onlyAtRest }) =>
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId);
        const { checkout } = thread;
        // A worktree about to be deleted is unwatched first: on Windows the native watcher can take
        // the process down when its folder goes away under it. A refused removal gets its watch back.
        yield* Effect.acquireUseRelease(
          Effect.forEach(heldForRemoval(thread, removeWorktree !== undefined), holdWatch),
          () => {
            const options = {
              ...(removeWorktree === undefined
                ? {}
                : { removeWorktree: { force: removeWorktree.force } }),
              ...(permissionRules === undefined ? {} : { permissionRules }),
            };
            return onlyAtRest === true
              ? closeAtRest(runtimes, ports, gate, threadId, options)
              : runtimes.close(threadId, options);
          },
          // Only once the close is over: a client gone mid-close ends this wait, not the close.
          (releases) =>
            runtimes.releaseAfterClose(
              threadId,
              Effect.forEach(releases, (release) => release, { discard: true }),
            ),
        );
        yield* releaseWatchers;
        const merged = removeWorktree?.deleteBranch;
        if (merged === undefined || checkout.kind !== "worktree" || checkout.branch === undefined) {
          return {};
        }
        const name = checkout.branch;
        const keep = (reason: string) => ({ branch: { name, deleted: false, reason } });
        if (checkout.repoRoot === undefined) {
          return keep("the repository's main checkout is unknown");
        }
        if (Option.isNone(pr) || Option.isNone(proc)) return keep("git and gh aren't available");
        const branch = yield* deleteMergedBranch({
          repoPath: checkout.repoRoot,
          branch: name,
          pr: merged,
        }).pipe(Effect.provideService(Pr, pr.value), Effect.provideService(Proc, proc.value));
        return { branch };
      }),
    "thread.markUnread": ({ threadId, unread }) =>
      runtimes.updateThread(threadId, (t) => ({ ...t, unread })).pipe(Effect.asVoid),
    "thread.queue.edit": ({ threadId, itemId, input }) =>
      runtimes.editQueued(threadId, itemId, input),
    "thread.queue.reorder": ({ threadId, itemIds }) => runtimes.reorderQueue(threadId, itemIds),
    "thread.queue.remove": ({ threadId, itemId }) => runtimes.removeQueued(threadId, itemId),
    "thread.queue.steer": ({ threadId, itemId }) => runtimes.steerQueued(threadId, itemId),
    "thread.setPlan": ({ threadId, plan }) =>
      store.getThread(threadId).pipe(
        Effect.andThen(plans.edit(threadId, plan)),
        Effect.map((saved) => saved ?? null),
      ),
    "thread.refreshPlan": ({ threadId, rebuild }) =>
      store.getThread(threadId).pipe(
        Effect.andThen(
          keeper === undefined ? plans.get(threadId) : keeper.refresh(threadId, { rebuild }),
        ),
        Effect.map((plan) => plan ?? null),
      ),
    "thread.resolveWait": ({ threadId, id, undo }) =>
      Effect.gen(function* () {
        yield* store.getThread(threadId);
        const { item, changed } = yield* waits
          .resolve(threadId, id, undo === true ? undefined : { by: "user", at: Date.now() })
          .pipe(Effect.catchTag("WaitsFull", waitsFull(threadId)));
        // A suggestion the user resolves is one they dismissed.
        if (changed && item.suggested === true) {
          yield* waitEvent(undo === true ? "restored" : "dismissed");
        }
        return item;
      }),
    "thread.keepWait": ({ threadId, id }) =>
      Effect.gen(function* () {
        yield* store.getThread(threadId);
        const item = yield* waits
          .keep(threadId, id)
          .pipe(Effect.catchTag("WaitsFull", waitsFull(threadId)));
        yield* waitEvent("kept");
        return item;
      }),
    "thread.addWait": ({ threadId, messageId, kind, title }) =>
      Effect.gen(function* () {
        yield* store.getThread(threadId);
        const message = yield* store.getMessage(threadId, messageId);
        if (message === undefined) {
          return yield* new NotFound({
            entity: "message",
            id: messageId,
            message: "That message isn't saved yet; try again once the reply has finished.",
          });
        }
        const named =
          title === undefined
            ? waitTitleOf(
                message.parts
                  .flatMap((part) => (part.type === "text" ? [part.text] : []))
                  .join("\n"),
              )
            : plainWaitText(title);
        if (named === undefined || named === "") {
          return yield* new InvalidState({
            message: "That message has no text to name the item by; give it a title.",
            threadId,
          });
        }
        const { item } = yield* waits
          .put(threadId, { kind: kind ?? "draft", title: named, anchor: messageId }, "user")
          .pipe(Effect.catchTag("WaitsFull", waitsFull(threadId)));
        return item;
      }),
    "thread.listWaits": ({ threadId, state }) =>
      store.getThread(threadId).pipe(Effect.andThen(store.listWaits(threadId, state ?? "open"))),
    "thread.markCompleted": ({ threadId, completed }) =>
      runtimes.markCompleted(threadId, completed ? "user" : undefined).pipe(Effect.asVoid),
    "thread.subscribe": ({ threadId, afterRev, from }) =>
      hub.threadFeed(
        threadId,
        runtimes.replay(threadId, afterRev, from),
        runtimes.replay(threadId),
      ),
    "thread.history": ({ threadId, before }) => runtimes.history(threadId, before),
    "thread.rewind": ({ threadId, toMessageId, files }) =>
      Effect.gen(function* () {
        const target = yield* runtimes.rewindTarget(threadId, toMessageId);
        let restoreFiles: Effect.Effect<void, GitError> | undefined;
        if (files) {
          if (target.turnId === undefined) {
            return yield* new InvalidState({ message: "that message has no checkpoint", threadId });
          }
          // A user message keeps its turn's starting files; an agent reply keeps where the turn ended.
          const checkpoint =
            target.role === "user" ? target.turnId : endCheckpointId(target.turnId);
          restoreFiles = Effect.suspend(() =>
            checkpoints
              .restoreFiles(target.cwd, checkpointRef(threadId, checkpoint))
              .pipe(Effect.mapError((e) => new GitError({ message: e.message }))),
          );
        }
        yield* runtimes.rewind(threadId, target, restoreFiles);
      }),

    "thread.fork": ({ threadId, fromMessageId, checkout, title }) =>
      Effect.gen(function* () {
        const plan = yield* runtimes.forkTarget(threadId, fromMessageId);
        const prepared =
          checkout === undefined
            ? plan.source.checkout
            : yield* prepareForkCheckout(plan, checkout);
        return yield* runtimes.fork(plan, { checkout: prepared, title });
      }),

    "task.accept": ({ threadId, taskId }) =>
      Effect.gen(function* () {
        const parent = yield* store.getThread(threadId);
        const { task } = yield* store.getTask(threadId, taskId);
        const project = (yield* store.listProjects).find((p) => p.id === parent.projectId);
        if (project === undefined) {
          return yield* new NotFound({ entity: "project", id: parent.projectId });
        }
        // Where the parent is working now, not where it was created: a thread that moved into
        // another worktree offers its chips from there, and `current` means beside it.
        const own = effectiveCheckout(parent);
        // A base the chip names is where the task starts, or the task doesn't start. It is resolved
        // here, in the parent's own worktree, to the commit it names there, and that commit is what
        // is branched from: the worktree layer resolves a base again from the project root, where
        // `HEAD` and the like name something else, and it drops a base it can't use and branches
        // from the default instead, which is right for a hint and would start a typo's follow-up on
        // unrelated code, looking fine.
        const base = task.base === undefined ? undefined : yield* commitOf(own.path, task.base);
        if (task.base !== undefined && task.checkout !== "current" && base === undefined) {
          return yield* new InvalidState({
            message: `Can't start this task: "${task.base}" isn't a branch or commit in this repository.`,
          });
        }
        const { base: _named, ...unbased } = task;
        const request = taskCheckoutRequest(
          base === undefined ? unbased : { ...unbased, base },
          yield* commitOf(own.path, "HEAD"),
        );
        const start = {
          model: parent.model,
          mode: parent.mode,
          title: task.title,
          input: { text: task.prompt },
        };
        const accept = setTaskStatus(threadId, taskId, "accepted").pipe(Effect.asVoid);
        if (request === undefined) {
          const checkout = yield* resolveFolder(own.path).pipe(Effect.as(own));
          yield* accept;
          return yield* runtimes.create({ ...start, projectRoot: project.root, checkout });
        }
        // The path `spawn_worker` starts its workers by: one guard, one set of errors.
        return yield* creator
          .createIn(request, project.root, start, () => accept)
          .pipe(
            Effect.catchTag("CheckoutInUse", (e) =>
              Effect.fail(new InvalidState({ message: e.message })),
            ),
          );
      }),
    "task.dismiss": ({ threadId, taskId }) =>
      setTaskStatus(threadId, taskId, "dismissed").pipe(
        Effect.asVoid,
        Effect.catchTag("InvalidState", () => Effect.void),
      ),

    "ui.showPanel": ({ threadId, panel, target }) =>
      Effect.gen(function* () {
        yield* store.getThread(threadId);
        yield* hub.publish({
          type: "ui.showPanel",
          threadId,
          panel,
          ...(target === undefined ? {} : { target }),
        });
      }),
  } satisfies Partial<Handlers>;
});
