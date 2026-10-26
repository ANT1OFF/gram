import type { MockCoreScenes } from "./mock-thread-runtime";
import type {
  GitState,
  ThreadRecap,
  TurnId,
  ThreadPlan,
  PendingRequest,
  PrStatus,
  RequestId,
  OwnPr,
  ReviewRequest,
  ThreadId,
  WorkspaceId,
  AskInput,
  WorkerQuestion,
} from "@gram/contracts";
import { askQuestion, closeQuestion, questionDate } from "@gram/contracts";
import { MOCK_DEPS_GIT, MOCK_DEPS_PLAN, MOCK_DEPS_RECAP } from "./mock-assist";
import {
  type MockBoardSimulation,
  type MockFinishedSimulation,
  type MockReleaseSimulation,
  type MockQuietBusySimulation,
  type MockWaitsSimulation,
} from "./mock-orchestration";
import {
  seedAsks,
  type MockAsksSimulation,
  type MockFailuresSimulation,
  type MockOneThreadSimulation,
} from "./mock-asks";
import type { MockReachingSimulation } from "./mock-reaching";
import type { MockWorkersSimulation } from "./mock-workers";
import { resolveMockFolder } from "./mock-fs";
import { PROJECTS } from "./mock-scripts";

// Dev and e2e scenarios MockApi tells over the orchestration mock and the other domain mocks: the
// workers, asks, waits, release and archive stories, failures, missing folders, unpushed work, a
// recap and PRs.

/**
 * Dev and e2e hook: the card the server raises when the workspace's orchestrator spawns a worker
 * in a repo Gram doesn't know yet, named by its folder. On "Allow" the repo becomes a
 * project and joins the workspace, as the server's handler does; the worker itself isn't made.
 */
export async function simulateAddRepoRequest(
  core: MockCoreScenes,
  workspaceId: WorkspaceId,
  root: string,
): Promise<RequestId> {
  const state = core.orchestration.peek().find((w) => w.workspace.id === workspaceId);
  const threadId = state?.workspace.orchestratorThreadId;
  if (state === undefined || threadId === undefined) {
    throw new Error("That workspace has no orchestrator open.");
  }
  const path = resolveMockFolder(root);
  const name = path.split("/").at(-1) ?? path;
  const request: PendingRequest = {
    kind: "approval",
    id: `r-add-repo-${core.ids()}` as RequestId,
    toolName: "mcp__gram__spawn_worker",
    displayName: "spawn_worker",
    input: {
      project: path,
      feature: "site-deploy",
      title: "Deploy the release site",
      brief: "Add the deploy definition for Gram to this repo, following its README.",
    },
    description: `Add ${name} (${path}) to the "${state.workspace.name}" workspace, and spawn a worker there for site-deploy: Deploy the release site`,
    suggestions: [],
    scopes: ["once"],
  };
  core.ask(threadId, request, (answer) => {
    if (answer.kind !== "approval" || answer.decision !== "allow") return;
    void core.projectsMock.api.addProject(path).then((project) => {
      const current = core.orchestration.peek().find((w) => w.workspace.id === workspaceId);
      if (current === undefined) return;
      const { workspace } = current;
      if (workspace.projectIds.includes(project.id)) return;
      return core.orchestration.save({
        id: workspace.id,
        name: workspace.name,
        projectIds: [...workspace.projectIds, project.id],
        homeProjectId: workspace.homeProjectId,
      });
    });
  });
  return request.id;
}

/**
 * Dev and e2e hook: the workspace's orchestrator calls `ask_user`, which every window hears of
 * through `memory.changed` alone. Returns the question's id.
 */
export function simulateAskUser(
  core: MockCoreScenes,
  workspaceId: WorkspaceId,
  input: AskInput,
): string {
  return core.dreams.editQuestions(workspaceId, (current) =>
    askQuestion(current, input, questionDate(Date.now())),
  );
}

/** Dev and e2e hook: the workspace's orchestrator calls `close_question` on `id`. */
export function simulateCloseQuestion(
  core: MockCoreScenes,
  workspaceId: WorkspaceId,
  id: string,
  answer: string,
): void {
  core.dreams.editQuestions(workspaceId, (current) =>
    closeQuestion(current, { id, answer, how: "decided" }, questionDate(Date.now())),
  );
}

/**
 * Dev and e2e hook: the ask stack's scenario (`mock-asks.ts`): the board's workspace with a
 * three-way push, a question with options, a free-form question, and an ask in a second workspace.
 */
export function simulateAsks(core: MockCoreScenes): Promise<MockAsksSimulation> {
  return seedAsks({
    board: () => core.mock.simulateOrchestration("board"),
    projects: () => core.mock.world.projects(),
    respond: (threadId, requestId, answer) => core.mock.respond(threadId, requestId, answer),
    request: (threadId, request) => core.mock.simulateRequest(threadId, request),
    armReplies: (requestId, replies) => core.composer.armAskReplies(requestId, replies),
    createThread: (input) => core.mock.createThread(input),
    updateThread: (threadId, patch) => core.mock.world.updateThread(threadId, patch),
    saveWorkspace: (input) => core.orchestration.save(input),
    openOrchestrator: (target) => core.orchestration.open(target),
  });
}

/** Dev and e2e hook: the board scenario with finished work beside it, for the tree's Done row. */
export async function simulateFinishedWork(core: MockCoreScenes): Promise<MockFinishedSimulation> {
  return core.orchestration.simulateFinished(await core.mock.simulateOrchestration("board"));
}

/**
 * Dev and e2e hook: the live stream over the finished-work board: feature cards in place of the
 * digest tables, a merge and a block as stream lines, "Since you left" and a helper sentence.
 */
export async function simulateLiveCards(core: MockCoreScenes): Promise<MockFinishedSimulation> {
  return core.orchestration.simulateLiveCards(await core.mock.simulateFinishedWork());
}

/**
 * Dev and e2e hook: the finished-work board with the ⌘J Workers list's own workers beside it: one
 * running live, one that asked a question, one merged today and three finished earlier.
 */
export async function simulateWorkers(core: MockCoreScenes): Promise<MockWorkersSimulation> {
  const finished = await core.mock.simulateFinishedWork();
  return core.orchestration.simulateWorkersList(finished, (view) =>
    core.composer.assist.simulateCatchUp(view),
  );
}

/**
 * Dev and e2e hook: the One thread proof: one board
 * workspace with every layer the new layout shows at once. The ask stack's asks, finished work,
 * live feature cards with "Since you left", and the ⌘J Workers list's live, asking and done
 * workers, all over one board rather than one each.
 */
export async function simulateOneThread(core: MockCoreScenes): Promise<MockOneThreadSimulation> {
  const board = await core.mock.simulateOrchestration("board");
  const asks = await seedAsks({
    board: () => Promise.resolve(board),
    projects: () => core.mock.world.projects(),
    respond: (threadId, requestId, answer) => core.mock.respond(threadId, requestId, answer),
    request: (threadId, request) => core.mock.simulateRequest(threadId, request),
    armReplies: (requestId, replies) => core.composer.armAskReplies(requestId, replies),
    createThread: (input) => core.mock.createThread(input),
    updateThread: (threadId, patch) => core.mock.world.updateThread(threadId, patch),
    saveWorkspace: (input) => core.orchestration.save(input),
    openOrchestrator: (target) => core.orchestration.open(target),
  });
  const finished = await core.orchestration.simulateFinished(board);
  const workers = await core.orchestration.simulateWorkersList(
    finished,
    (view) => core.composer.assist.simulateCatchUp(view),
    { liveTools: true },
  );
  core.orchestration.simulateLiveCards(finished);
  return { ...workers, asks };
}

/**
 * Dev and e2e hook: the ⌘J scenario with a worker whose worktree was cleaned up (read-only from
 * the finished list) and one idle two hours, with "Why is it stuck?" armed.
 */
export async function simulateReachingWorkers(
  core: MockCoreScenes,
): Promise<MockReachingSimulation> {
  const workers = await core.mock.simulateWorkers();
  return core.orchestration.simulateReaching(workers, (view) =>
    core.composer.assist.simulateStuck(view),
  );
}

/**
 * Dev and e2e hook: the board scenario with a worker question at each stage
 * (`simulateWorkerQuestions`): two forwarded to the user, one in triage, two closed.
 */
export async function simulateWorkerQuestions(
  core: MockCoreScenes,
): Promise<MockBoardSimulation & { readonly questions: readonly WorkerQuestion[] }> {
  const board = await core.orchestration.simulateBoard(PROJECTS.map((project) => project.id));
  return { ...board, questions: core.orchestration.simulateWorkerQuestions(board) };
}

/**
 * Dev and e2e hook: `casefiles`, a workspace with nothing to ask whose workers are at work, waiting
 * on CI, the review bot and a dependency, and stopped on a conflict: Quiet's busy count.
 */
export function simulateQuietBusy(core: MockCoreScenes): Promise<MockQuietBusySimulation> {
  return core.orchestration.simulateQuietBusy(PROJECTS.map((project) => project.id));
}

/**
 * Dev and e2e hook: the finished-work board with `casefile-cleanup` beside it, a group whose
 * workers wait on CI, the review bot, a code-owner team, a person's change request and the user.
 */
export async function simulateWorkerWaits(
  core: MockCoreScenes,
): Promise<MockFinishedSimulation & { readonly waits: MockWaitsSimulation }> {
  const finished = await core.mock.simulateFinishedWork();
  return { ...finished, waits: await core.orchestration.simulateWaits(finished) };
}

/**
 * Dev and e2e hook: the finished-work board with `release-0-8-0` beside it, a group of a release's
 * worth of features nearly all of which are merged, delivered or archived.
 */
export async function simulateReleaseGroup(
  core: MockCoreScenes,
): Promise<MockFinishedSimulation & { readonly release: MockReleaseSimulation }> {
  const finished = await core.mock.simulateFinishedWork();
  return { ...finished, release: await core.orchestration.simulateRelease(finished) };
}

/**
 * Dev and e2e hook: the finished-work board with four archived groups beside it, and a group with
 * one briefed worker to archive.
 */
export async function simulateArchivedGroups(core: MockCoreScenes): Promise<
  MockFinishedSimulation & {
    readonly archivedGroups: readonly ThreadId[];
    readonly nightly: ThreadId;
  }
> {
  const finished = await core.mock.simulateFinishedWork();
  const { archived, nightly } = await core.orchestration.simulateArchivedGroups(finished);
  return { ...finished, archivedGroups: archived, nightly };
}

/** Dev and e2e hook: the thread's folder is deleted outside the app, as the server reports it. */
export function simulateMissingFolder(
  core: MockCoreScenes,
  threadId: ThreadId,
  { branchGone }: { branchGone?: { repo: string; number: number } } = {},
) {
  const runtime = core.runtime(threadId);
  core.missingFolders.set(threadId, branchGone === undefined ? {} : { branchGone });
  const git: GitState = {
    ...(runtime.summary.git ?? {
      repo: true,
      worktree: runtime.summary.thread.checkout.kind === "worktree",
      head: "",
      changesToken: "",
      changedFiles: 0,
      behindBase: 0,
      aheadBase: 0,
      conflicts: false,
    }),
    missing: true,
  };
  runtime.summary = { ...runtime.summary, git };
  core.emit({ type: "git.state", threadId, state: git });
}

/** Dev and e2e hook: the agent commits `commits` more on the branch without pushing. */
export function simulateUnpushed(core: MockCoreScenes, threadId: ThreadId, commits: number) {
  core.pullRequests.simulateUnpushed(threadId, commits);
}

/**
 * Dev and e2e hook: the ask stack's scenario with two failures beside its asks, for the Failing
 * strip: the board's working worker stopped on a spending limit, and the in-review worker's PR
 * checks red while the user holds it (Take over), so no worker owns the fix.
 */
export async function simulateFailures(core: MockCoreScenes): Promise<MockFailuresSimulation> {
  const asks = await core.mock.simulateAsks();
  core.mock.simulateTurnError(
    asks.working,
    {
      kind: "costGuard",
      retryable: false,
      text: "The spending limit for this key was reached. Raise it, or switch the thread to your subscription.",
    },
    "Run the queue tests",
  );
  const failing = core.runtime(asks.inReview);
  const git = failing.summary.git;
  if (git?.pr !== undefined) {
    const state = { ...git, pr: { ...git.pr, checks: "failing" as const } };
    failing.summary = { ...failing.summary, git: state };
    core.emit({ type: "git.state", threadId: asks.inReview, state });
  }
  await core.orchestration.takeOver(asks.inReview);
  return { ...asks, stopped: asks.working, failing: asks.inReview };
}

export function simulateChecks(
  core: MockCoreScenes,
  threadId: ThreadId,
  checks: PrStatus["checks"],
) {
  core.pullRequests.simulateChecks(threadId, checks);
}

/**
 * Gives `threadId` a recap for its next opening, `t-deps` the design's by default, taking
 * `delayMs` to come back as a recap the server has to make does. `git` and `plan` are its
 * checkout and plan meanwhile, for the card's facts and progress.
 */
export function simulateRecap(
  core: MockCoreScenes,
  threadId: ThreadId,
  {
    recap = MOCK_DEPS_RECAP,
    git = MOCK_DEPS_GIT,
    plan = MOCK_DEPS_PLAN,
    delayMs = 0,
  }: { recap?: ThreadRecap; git?: GitState; plan?: ThreadPlan; delayMs?: number } = {},
) {
  const runtime = core.runtime(threadId);
  runtime.summary = { ...runtime.summary, git, plan };
  core.emit({ type: "git.state", threadId, state: git });
  core.emit({ type: "thread.plan", threadId, items: [], plan });
  core.composer.assist.simulate(
    {
      threadId,
      recap,
      lastActiveAt: runtime.summary.thread.lastActivityAt,
      turnId: core.ids() as TurnId,
    },
    delayMs,
  );
}

/** Dev and e2e hook: GitHub starts requesting the user's review on `request`, as the poll finds it. */
export function simulateReviewRequest(core: MockCoreScenes, request: ReviewRequest) {
  core.reviewRequests.simulate(request);
}

/** Dev/e2e hook: explicit offline poll snapshot, including empty lists. */
export function replacePrLists(
  core: MockCoreScenes,
  lists: { requests: readonly ReviewRequest[]; prs: readonly OwnPr[] },
) {
  core.reviewRequests.replace(lists);
}

export function simulateOpenPr(core: MockCoreScenes, pr: OwnPr) {
  core.reviewRequests.simulateOwn(pr);
}
