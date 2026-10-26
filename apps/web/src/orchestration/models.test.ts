import type {
  ApprovalRequest,
  Dream,
  DreamFileDiff,
  DreamId,
  DreamResolution,
  FeatureLedgerEntry,
  FeatureStage,
  GitState,
  OrchestratorLedger,
  PendingRequest,
  Project,
  ProjectId,
  RequestId,
  Thread,
  ThreadId,
  ThreadStatus,
  ThreadSummary,
  WorkerLedgerEntry,
  WorkerPr,
  WorkerState,
  WorkspaceId,
  WorkspaceState,
} from "@gram/contracts";
import { DEFAULT_CHARTER, DEFAULT_ORCHESTRATOR_MODEL, newWorkspaceCharter } from "@gram/contracts";
import { describe, expect, it, vi } from "vitest";

import { canonicalJson } from "@/lib/canonical-json";
import { agoText } from "@/lib/time";
import { useAttentionStore } from "@/sidebar/attention";
import { rollupOf, splitForTree } from "@/sidebar/grouping";
import { closeThread, useThreadsStore } from "@/stores/threads";
import { contextPercent } from "@/thread/context-usage";

import {
  freshSessionPct,
  HANDOFF_GIVE_UP_MS,
  handoffRunning,
  boardWorkspaceFor,
  leastAdvanced,
  liveWorkerState,
  liveWorkerEntry,
  reportLine,
  sectionsOf,
  TIDY_UP_MESSAGE,
  tidyUpBlocked,
  workerCount,
  workerRepoNames,
  workerTitle,
} from "./board-model";
import {
  answerGroup,
  failureText,
  groupInbox,
  inboxEntries,
  type InboxEntry,
  type RespondMany,
} from "./inbox-model";
import { createLedgerWatch } from "./ledger-watch";
import { removalLines, workersText, workspaceRemoval } from "./remove-workspace-model";
import {
  charterOf,
  createInput,
  emptyNewWorkspace,
  firstMessageOf,
  startFrom,
  toggleRepo,
  workspaceNameFor,
} from "./new-workspace-model";
import {
  adoptState,
  conflictsToMerge,
  withAskedMerges,
  diffSides,
  backlogSuggestion,
  budgetOf,
  dreamActions,
  dreamFailureText,
  dreamKindLabel,
  dreamStatus,
  presentDreamStatus,
  presentFileStatus,
  memoryIsEmpty,
  memoryPathProblem,
  memorySize,
  openQuestions,
  parseQuestions,
  perRepoOf,
  planLines,
  previewTotals,
  resolutionsToSend,
  reviewFiles,
  reviewSummary,
  sideLabel,
  startableScope,
  tokensText,
  type DreamStartGate,
  type ScopedPreview,
} from "./memory-model";
import {
  addStep,
  createStageHolds,
  draftOfStage,
  groupSlug,
  ledgerWithStage,
  moveStep,
  optimisticStage,
  removeStep,
  STAGE_STALE_MS,
  stageOf,
  stageTitle,
  stepperModel,
  validatePlanDraft,
  withStage,
  type PlanDraft,
} from "./stage-model";
import {
  featureFinished,
  orchestratorRowTitle,
  treeThreads,
  workingCount,
  midTurnWorkers,
  workspaceStatus,
  workspaceTrees,
  type TreeFeature,
} from "./tree-model";
import {
  defaultTaskTarget,
  reposWithoutWorkspace,
  settledTaskTarget,
  taskRepos,
} from "./task-model";
import { prWait, reviewerName, workerWait, type WaitInput } from "./wait-model";

const ws = "w-1" as WorkspaceId;
const orchestratorId = "t-orch" as ThreadId;

const worker = (
  id: string,
  feature: string,
  state: WorkerState,
  extra: Partial<WorkerLedgerEntry> = {},
): WorkerLedgerEntry => ({
  feature,
  projectId: "p-api" as ProjectId,
  project: "api",
  threadId: id as ThreadId,
  title: `Title of ${id}`,
  state,
  status: "idle",
  pendingRequests: [],
  changedFiles: 0,
  overlapsWith: [],
  userIntervened: false,
  messagesFromOrchestrator: 0,
  ...extra,
});

const feature = (name: string, state: WorkerState, workers: WorkerLedgerEntry[]) =>
  ({ feature: name, state, workers }) satisfies FeatureLedgerEntry;

const pr = (number: number) => ({ repo: "example/api", number });
const stateOf = (id: string) => ({ workspace: { id: id as WorkspaceId } }) as WorkspaceState;

/** An open PR ready to merge, `over` laid on it; an `undefined` there takes the field away. */
const open = (over: { readonly [K in keyof WorkerPr]?: WorkerPr[K] | undefined } = {}) =>
  Object.fromEntries(
    Object.entries({
      repo: "example/api",
      number: 7,
      state: "open",
      checks: "passing",
      verdictOnHead: "approved",
      botOnHead: "reviewed",
      mergeState: "CLEAN",
      ...over,
    }).filter(([, value]) => value !== undefined),
  ) as WorkerPr;
const tag = (shown: WorkerPr) => {
  const wait = prWait(shown);
  return `${wait.bucket}: ${wait.tag}`;
};
const ledgerRow = (state: WorkerState, over: Partial<WaitInput> = {}): WaitInput => ({
  state,
  status: "idle",
  pendingRequests: [],
  ...over,
});
const wait = (input: WaitInput, ...live: [WorkerState?, ThreadStatus?]) => {
  const { bucket, tag: shown } = workerWait(input, ...live);
  return shown === undefined ? bucket : `${bucket}: ${shown}`;
};

/** A dream of `w1` as the dreams list holds it. */
const pastDream = (overrides: Partial<Dream>): Dream => ({
  id: "dream-0001" as DreamId,
  workspaceId: "w1" as WorkspaceId,
  kind: "dream",
  mode: "review",
  status: "completed",
  inputs: { memoryVersion: "0006", threadIds: [], agentSessions: [] },
  model: { agent: "claude", model: "opus" },
  outputDir: "/d",
  createdAt: 1,
  ...overrides,
});

describe("what a worker waits on", () => {
  it("waits on checks while CI or the review bot is still to have its say", () => {
    expect(tag(open({ checks: "pending" }))).toBe("checks: CI pending");
    // A red check nobody requires doesn't hold it.
    expect(tag(open({ checks: "passing (not required: failing)" }))).toBe("person: merge decision");
    expect(tag(open({ checks: "failing" }))).toBe("checks: CI failing");
    const noVerdict = { verdictOnHead: undefined, botOnHead: undefined };
    expect(tag(open(noVerdict))).toBe("person: merge decision");
    expect(tag(open({ ...noVerdict, botOnHead: "reviewing" }))).toBe("checks: bot reviewing");
    // A bot that only commented on the head is done; a lookup that didn't read reviews can't say.
    expect(tag(open({ ...noVerdict, botOnHead: "reviewed" }))).toBe("person: merge decision");
    expect(tag(open({ ...noVerdict, reviewUnread: true }))).toBe("person: merge decision");
    expect(tag(open({ verdictOnHead: "changesRequested" }))).toBe("checks: bot: changes");
    expect(tag(open({ mergeState: "BEHIND" }))).toBe("checks: behind base");
    expect(tag(open({ mergeState: "DIRTY" }))).toBe("checks: conflicts");
    expect(tag(open({ mergeState: undefined }))).toBe("checks: checking");
    // Gram merges it once ready, unless it is held, or short of what its merge gate takes:
    // the bot's approval of the head, a merge state GitHub merges, and a head not refused before.
    expect(tag(open({ mergeWhenReady: {} }))).toBe("checks: merge armed");
    expect(tag(open({ mergeWhenReady: { hold: "after the release" } }))).toBe("person: held");
    expect(tag(open({ mergeWhenReady: { refused: true } }))).toBe("person: merge refused");
    expect(tag(open({ verdictOnHead: undefined, mergeWhenReady: {} }))).toBe("checks: merge armed");
    expect(tag(open({ mergeState: "HAS_HOOKS", mergeWhenReady: {} }))).toBe("person: you: merge");
    expect(tag(open({ mergeState: "UNSTABLE", mergeWhenReady: {} }))).toBe("checks: merge armed");
  });

  it("names the person a PR waits on: code owners first, then reviewers, then you", () => {
    const blocked = { mergeState: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" };
    const team = { kind: "team" as const, name: "example/platform", codeOwner: true as const };
    const mona = { kind: "user" as const, name: "mona" };
    expect(reviewerName(team)).toBe("@platform");
    expect(tag(open({ ...blocked, reviewRequests: [mona, team] }))).toBe(
      "person: @platform review",
    );
    expect(prWait(open({ ...blocked, reviewRequests: [team] })).detail).toBe(
      "#7 in example/api waits on a code-owner review from @platform.",
    );
    expect(tag(open({ ...blocked, reviewRequests: [mona] }))).toBe("person: @mona review");
    expect(tag(open(blocked))).toBe("person: review required");
    expect(
      tag(
        open({
          mergeState: "BLOCKED",
          reviewDecision: "CHANGES_REQUESTED",
          changesRequestedBy: ["jordan"],
        }),
      ),
    ).toBe("person: @jordan: changes");
    expect(tag(open({ mergeState: "BLOCKED", reviewDecision: "CHANGES_REQUESTED" }))).toBe(
      "person: changes requested",
    );
    expect(tag(open({ mergeState: "BLOCKED" }))).toBe("checks: merge blocked");
    expect(tag(open({ mergeState: "BLOCKED", reviewRequests: [mona] }))).toBe(
      "person: @mona review",
    );
    expect(tag(open())).toBe("person: merge decision");
  });

  it("reads a worker's requests, run, reports and every open PR, a person over checks", () => {
    const question = { kind: "question", ageMin: 1 };
    expect(wait(ledgerRow("needsUser", { pendingRequests: [question] }))).toBe(
      "person: you: answer",
    );
    expect(wait(ledgerRow("working"), "needsUser", "needsApproval")).toBe("person: you: approve");
    // Answered a moment ago: the live status wins over the ledger's stale request.
    expect(
      wait(ledgerRow("needsUser", { pendingRequests: [question] }), "working", "running"),
    ).toBe("working");
    expect(wait(ledgerRow("merged"), "merged", "running")).toBe("working");
    expect(wait(ledgerRow("merged"))).toBe("done: merged");
    expect(wait(ledgerRow("archived"))).toBe("done: archived");
    expect(wait(ledgerRow("archived", { status: "error" }))).toBe("done: archived");
    expect(wait(ledgerRow("archived", { pendingRequests: [question] }))).toBe(
      "person: you: answer",
    );
    expect(wait(ledgerRow("done"))).toBe("done: reported done");
    expect(wait(ledgerRow("error"))).toBe("person: stopped");
    expect(wait(ledgerRow("blocked"))).toBe("person: blocked");
    expect(wait(ledgerRow("question"))).toBe("person: question");
    // A blocked report beside an open PR still stands, which the ledger's state doesn't say.
    const onCi = open({ checks: "pending" });
    expect(wait(ledgerRow("inReview", { pr: onCi }))).toBe("checks: CI pending");
    expect(wait(ledgerRow("inReview", { pr: onCi, reportStands: true }))).toBe("person: blocked");
    // A PR in another repo waiting on its code owners outweighs one on CI.
    const elsewhere = open({
      number: 8,
      mergeState: "BLOCKED",
      reviewDecision: "REVIEW_REQUIRED",
      reviewRequests: [{ kind: "team", name: "web-owners", codeOwner: true }],
    });
    const across = ledgerRow("inReview", {
      pr: onCi,
      alsoIn: [{ projectId: "p-web" as ProjectId, project: "web", pr: elsewhere, changedFiles: 1 }],
    });
    expect(wait(across)).toBe("person: @web-owners review");
    // A merged sibling holds nothing; a PR not looked up yet waits on the lookup.
    expect(
      wait(ledgerRow("inReview", { pr: onCi, morePrs: [{ ...elsewhere, state: "merged" }] })),
    ).toBe("checks: CI pending");
    expect(wait(ledgerRow("inReview"))).toBe("checks: looking up");
    expect(wait(ledgerRow("briefed"))).toBe("working");
  });
});

describe("board columns", () => {
  it("put every worker state in exactly one of four columns, by what it waits on", () => {
    const table: Record<WorkerState, string> = {
      briefed: "working",
      working: "working",
      needsUser: "person",
      blocked: "person",
      question: "person",
      error: "person",
      inReview: "checks",
      done: "done",
      readyToMerge: "checks",
      delivered: "done",
      merged: "done",
      archived: "done",
    };
    for (const [state, column] of Object.entries(table)) {
      expect(workerWait(worker("a", "f", state as WorkerState)).bucket, state).toBe(column);
    }
    // A state this build doesn't know rests under Working, and is what its group reads as.
    expect(workerWait(worker("a", "f", "shipped" as WorkerState)).bucket).toBe("working");
    expect(leastAdvanced(["merged", "shipped" as WorkerState])).toBe("shipped");
  });

  it("lay the thread's live status over the ledger's state", () => {
    const cases: [WorkerState, ThreadStatus | undefined, WorkerState][] = [
      ["working", undefined, "working"],
      ["working", "needsApproval", "needsUser"],
      ["inReview", "needsInput", "needsUser"],
      ["working", "error", "error"],
      // An archived worker's old child error is history; an actual later turn revives the work.
      ["archived", "error", "archived"],
      ["archived", "running", "working"],
      ["archived", "needsApproval", "needsUser"],
      // Answered a moment ago: the ledger still says it waits, the thread says it runs.
      ["needsUser", "running", "working"],
      ["error", "running", "working"],
      // A failure that stands across a restart, or while nothing has run since.
      ["error", "cold", "error"],
      ["error", "idle", "error"],
      ["inReview", "idle", "inReview"],
      ["blocked", "idle", "blocked"],
    ];
    for (const [ledger, status, expected] of cases) {
      expect(liveWorkerState(ledger, status), `${ledger} + ${status}`).toBe(expected);
    }
  });

  it("counts a feature list's workers", () => {
    const features = [
      feature("mail-trigger", "needsUser", [
        worker("a", "mail-trigger", "working"),
        worker("b", "mail-trigger", "needsUser"),
        worker("c", "mail-trigger", "inReview", { pr: pr(1) }),
      ]),
      feature("paging", "inReview", [
        worker("d", "paging", "inReview", { pr: pr(2) }),
        worker("e", "paging", "readyToMerge", { pr: pr(3) }),
      ]),
      feature("solo", "merged", [worker("f", "solo", "merged", { pr: pr(4) })]),
      feature("local", "delivered", [
        worker("g", "local", "delivered"),
        worker("h", "local", "delivered"),
      ]),
      feature("mixed", "delivered", [
        worker("i", "mixed", "delivered"),
        worker("j", "mixed", "merged", { pr: pr(5) }),
        worker("k", "mixed", "merged", { pr: pr(6) }),
      ]),
    ];
    expect(workerCount(features)).toBe(11);
  });

  it("words a card's report on one line, cut to fit", () => {
    expect(reportLine("Done.\n\n  **Not markdown**  ")).toBe("Done. **Not markdown**");
    expect(reportLine("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
  });

  it("titles a worker by its thread's live title, else the ledger's", () => {
    expect(workerTitle({ title: "From the ledger" }, { thread: { title: "Renamed" } })).toBe(
      "Renamed",
    );
    expect(workerTitle({ title: "From the ledger" }, undefined)).toBe("From the ledger");
  });

  it("offers a fresh session from 90 % context, and knows a handoff by the session it leaves", () => {
    expect(freshSessionPct(undefined)).toBeUndefined();
    expect(freshSessionPct({ contextTokens: 100_000 })).toBeUndefined();
    expect(freshSessionPct({ contextTokens: 144_000, contextWindow: 200_000 })).toBeUndefined();
    expect(freshSessionPct({ contextTokens: 178_000, contextWindow: 200_000 })).toBeUndefined();
    expect(freshSessionPct({ contextTokens: 180_000, contextWindow: 200_000 })).toBe(90);
    expect(freshSessionPct({ contextTokens: 184_000, contextWindow: 200_000 })).toBe(92);
    expect(freshSessionPct({ contextTokens: 900_000, contextWindow: 200_000 })).toBe(100);
    // The usage bar's own percent, so the offer and the bar never disagree.
    const nearlyFull = { contextTokens: 181_100, contextWindow: 200_000 };
    expect(freshSessionPct(nearlyFull)).toBe(contextPercent(nearlyFull));

    const mark = { fromSession: "s-1", startedAt: 1_000 };
    expect(handoffRunning(undefined, { agentSessionId: "s-1" }, 2_000)).toBe(false);
    expect(handoffRunning(mark, undefined, 2_000)).toBe(false);
    expect(handoffRunning(mark, { agentSessionId: "s-1" }, 2_000)).toBe(true);
    expect(handoffRunning(mark, { agentSessionId: "s-2" }, 2_000)).toBe(false);
    expect(handoffRunning(mark, { agentSessionId: "s-1" }, 1_000 + HANDOFF_GIVE_UP_MS)).toBe(false);
    // A thread that had no session yet is handed off once it has one.
    expect(handoffRunning({ fromSession: undefined, startedAt: 0 }, {}, 1)).toBe(true);
  });

  it("offers Tidy up only while there is an orchestrator that can take a message", () => {
    expect(tidyUpBlocked(undefined)).toBe("No orchestrator yet: open it first");
    expect(tidyUpBlocked({ status: "ended" })).toBe("The orchestrator thread has ended");
    for (const status of ["cold", "idle", "running", "needsApproval"] as const) {
      expect(tidyUpBlocked({ status })).toBeUndefined();
    }
    for (const part of ["archive", "groups", "stages", "questions", "memory", "a few lines"]) {
      expect(TIDY_UP_MESSAGE).toContain(part);
    }
  });

  it("deal features into group bands ahead of the ungrouped, in the ledger's order", () => {
    const rows = [
      { feature: "solo", group: undefined, state: "working" },
      { feature: "paging", group: "q4", state: "briefed" },
      { feature: "mail", group: "q4", state: "inReview" },
      { feature: "stray", group: "unlisted", state: "merged" },
    ] as const;
    const stage: FeatureStage = { stage: "merge", setBy: "orchestrator", setAt: 0 };
    const sections = sectionsOf(rows, [
      { group: "empty", features: ["nobody-yet"], state: "briefed" },
      { group: "q4", features: ["mail", "paging"], state: "briefed", stage },
    ]);
    expect(sections.groups.map((g) => [g.group, g.rows.map((r) => r.feature)])).toEqual([
      ["q4", ["mail", "paging"]],
      // Named by a feature only: still a band, with the state worked out from its rows.
      ["unlisted", ["stray"]],
    ]);
    expect(sections.groups[0]?.stage).toBe(stage);
    expect(sections.groups[1]?.state).toBe("merged");
    expect(sections.ungrouped.map((r) => r.feature)).toEqual(["solo"]);
    // A board with no groups is the rows it always was.
    expect(sectionsOf(rows.slice(0, 1))).toEqual({ groups: [], ungrouped: rows.slice(0, 1) });
    expect(leastAdvanced(["merged", "needsUser", "working"])).toBe("needsUser");
    expect(leastAdvanced(["merged", "delivered", "archived"])).toBe("delivered");
    expect(leastAdvanced([])).toBeUndefined();
  });

  it("names a worker's repos, its own and the others it works in", () => {
    const web = {
      projectId: "p-web" as ProjectId,
      project: "web",
      branch: "feat/mail",
      pr: { repo: "example/web", number: 88 },
      changedFiles: 2,
    };
    const docs = { projectId: "p-docs" as ProjectId, project: "docs", changedFiles: 1 };
    const checkout = {
      kind: "worktree",
      path: "/code/api/.wt/mail",
      repoRoot: "/code/api",
    } as const;
    expect(workerRepoNames({ checkout }, undefined)).toBeUndefined();
    expect(workerRepoNames({ checkout }, { project: "api", alsoIn: [web, docs] })).toEqual({
      primary: "api",
      others: ["web", "docs"],
    });
    // Before the ledger arrives the extra worktrees' folders name them.
    expect(
      workerRepoNames(
        { checkout, extraCheckouts: [{ kind: "worktree", path: "/code/web/.wt/mail/" }] },
        undefined,
      ),
    ).toEqual({ primary: "api", others: ["mail"] });
  });

  it("open the current thread's workspace, else the first", () => {
    const workspaces = [stateOf("w-1"), stateOf("w-2")];
    expect(boardWorkspaceFor(undefined, [])).toBeUndefined();
    expect(boardWorkspaceFor(undefined, workspaces)).toBe("w-1");
    expect(boardWorkspaceFor({ workspaceId: "w-2" as WorkspaceId }, workspaces)).toBe("w-2");
    expect(boardWorkspaceFor({ workspaceId: "w-gone" as WorkspaceId }, workspaces)).toBe("w-1");
    expect(boardWorkspaceFor({}, workspaces)).toBe("w-1");
  });
});

const push = (id: string, command = "git push -u origin feat/x"): ApprovalRequest => ({
  kind: "approval",
  id: id as RequestId,
  toolName: "Bash",
  displayName: "Bash",
  input: { command },
  suggestions: [],
});

const thread = (
  id: string,
  status: ThreadStatus,
  fields: Partial<Thread> = {},
  pendingRequests: readonly PendingRequest[] = [],
): ThreadSummary => ({
  status,
  pendingRequests,
  queue: [],
  thread: {
    id: id as ThreadId,
    projectId: "p-api" as ProjectId,
    title: `Title of ${id}`,
    userNamed: false,
    model: { agent: "claude", model: "opus" },
    mode: "default",
    checkout: { kind: "main", path: "/repo" },
    labels: [],
    pinned: false,
    parked: false,
    unread: false,
    createdAt: 0,
    lastActivityAt: 0,
    workspaceId: ws,
    ...fields,
  },
});

const spawned = (name: string) => ({ spawnedBy: { threadId: orchestratorId, feature: name } });
const workspace: WorkspaceState = {
  workspace: {
    id: ws,
    name: "platform",
    projectIds: ["p-api" as ProjectId],
    homeProjectId: "p-api" as ProjectId,
    orchestratorThreadId: orchestratorId,
    createdAt: 0,
  },
  charter: { maxConcurrentWorkers: 10 },
};

const { orchestratorThreadId: _holder, ...unheld } = workspace.workspace;
const vacantWorkspace: WorkspaceState = { ...workspace, workspace: unheld };

const statusOf = (threads: ThreadSummary[], counts = {}) =>
  workspaceStatus(workspaceTrees([workspace], threads)[0]!, counts);

/** A badge for the PR a worker follows beside its own, `example/web#7`. */
const extraBadge = (state: "OPEN" | "MERGED" | "CLOSED") => ({
  number: 7,
  state,
  url: "https://github.com/example/web/pull/7",
  title: "Web side",
  isDraft: false,
  checks: "passing" as const,
  headMatches: true,
  aheadOfPr: false,
});

const mailFeature = (workers: ThreadSummary[], state?: WorkerState): TreeFeature => ({
  feature: "mail",
  workers,
  ...(state === undefined ? {} : { state }),
});

/** The split between the workspace's tree and the listed threads, as the threads store holds them now. */
const sidebarNow = () =>
  splitForTree(Object.values(useThreadsStore.getState().byId), new Set([ws]));

describe("workspace tree", () => {
  const orchestrator = thread("t-orch", "idle", { role: "orchestrator" });
  const a = thread("t-a", "running", { ...spawned("mail"), createdAt: 2 });
  const b = thread("t-b", "needsApproval", { ...spawned("mail"), createdAt: 1 }, [push("r-b")]);
  const c = thread("t-c", "idle", { ...spawned("paging"), createdAt: 3 });
  const dream = thread("t-dream", "running", { role: "dream" });
  const elsewhere = thread("t-x", "idle", {
    ...spawned("mail"),
    workspaceId: "w-2" as WorkspaceId,
  });

  it("nests workers under features under the orchestrator, in spawn order", () => {
    const [tree] = workspaceTrees([workspace], [a, b, c, orchestrator, dream, elsewhere]);
    expect(tree?.orchestrator).toBe(orchestrator);
    expect(tree?.features.map((f) => [f.feature, f.workers.map((w) => w.thread.id)])).toEqual([
      ["mail", ["t-b", "t-a"]],
      ["paging", ["t-c"]],
    ]);
    expect(tree?.others).toEqual([dream]);
    expect(treeThreads(tree!).map((s) => s.thread.id)).toEqual([
      "t-orch",
      "t-dream",
      "t-b",
      "t-a",
      "t-c",
    ]);
  });

  it("drops a closed worker from every grouping once its close returns", async () => {
    // Archived by the orchestrator, then closed by the user, and no `thread.removed` reaches us.
    const archived = thread("t-arch", "idle", { ...spawned("release"), parked: true });
    const { workspaceId: _ws, ...plain } = thread("t-own", "idle").thread;
    const listed: ThreadSummary = { ...thread("t-own", "idle"), thread: plain };
    useThreadsStore.setState({
      byId: Object.fromEntries([orchestrator, c, archived, listed].map((s) => [s.thread.id, s])),
    });
    expect(sidebarNow().tree.map((s) => s.thread.id)).toContain("t-arch");

    const api = { closeThread: vi.fn(() => Promise.resolve({})) };
    await closeThread(api, archived.thread.id);

    expect(api.closeThread.mock.calls).toEqual([["t-arch"]]);
    const split = sidebarNow();
    expect(split.tree.map((s) => s.thread.id)).not.toContain("t-arch");
    expect(split.listed.map((s) => s.thread.id)).toEqual(["t-own"]);
    // The server's own `thread.removed`, arriving late, finds nothing left to drop.
    useThreadsStore.getState().applyEvent({ type: "thread.removed", threadId: archived.thread.id });
    expect(Object.keys(useThreadsStore.getState().byId)).toEqual(["t-orch", "t-c", "t-own"]);

    // Removed by its event while the close was answering, then reopened from another window
    // under the same id: the close's late answer leaves the reopened thread be.
    const reopened = { ...c, thread: { ...c.thread, title: "Reopened" } };
    const answer = Promise.withResolvers<object>();
    const slow = { closeThread: () => answer.promise };
    const closing = closeThread(slow, c.thread.id);
    useThreadsStore.getState().applyEvent({ type: "thread.removed", threadId: c.thread.id });
    useThreadsStore.getState().applyEvent({ type: "thread.upsert", thread: reopened.thread });
    answer.resolve({});
    await closing;
    expect(useThreadsStore.getState().byId[c.thread.id]?.thread.title).toBe("Reopened");

    // A resync snapshot that skipped the removal brings the reopen, with its new `createdAt`.
    const again = Promise.withResolvers<object>();
    const resynced = closeThread({ closeThread: () => again.promise }, c.thread.id);
    const reborn = { ...reopened, thread: { ...reopened.thread, createdAt: 99 } };
    useThreadsStore.getState().applyEvent({ type: "threads.snapshot", threads: [reborn] });
    again.resolve({});
    await resynced;
    expect(useThreadsStore.getState().byId[c.thread.id]?.thread.createdAt).toBe(99);
    useThreadsStore.setState({ byId: {} });
  });

  it("counts the workers mid-turn a pause lets finish, never the orchestrator or a dream", () => {
    const byId = Object.fromEntries([a, b, c, orchestrator, dream].map((s) => [s.thread.id, s]));
    // The running worker and the one stopped in its turn on an ask, as their paused rows say
    // "stopping"; the idle one is not mid-turn.
    expect(midTurnWorkers(byId, ws)).toBe(2);
    expect(midTurnWorkers({ [dream.thread.id]: dream }, ws)).toBe(0);
    expect(midTurnWorkers(byId, "w-2")).toBe(0);
  });

  it("counts the threads working under an orchestrator, its own turn and background work too", () => {
    // A running worker and a running dream; the orchestrator and the rest rest.
    const [tree] = workspaceTrees([workspace], [a, b, c, orchestrator, dream]);
    expect(workingCount(tree!)).toBe(2);
    // A subagent's live line keeps a resting thread working, and an emptied one stops it.
    expect(workingCount(tree!, { "t-orch": "Explore: reading the ledger" })).toBe(3);
    const lingering = thread("t-orch", "idle", { role: "orchestrator" });
    const [stale] = workspaceTrees(
      [workspace],
      [{ ...lingering, activity: "Explore: reading the ledger" }, c],
    );
    expect(workingCount(stale!)).toBe(1);
    expect(workingCount(stale!, { "t-orch": "" })).toBe(0);
    const shelled: ThreadSummary = {
      ...c,
      background: [{ taskId: "b1", kind: "shell", description: "pnpm test", startedAt: 0 }],
    };
    const [starting] = workspaceTrees(
      [workspace],
      [thread("t-orch", "starting", { role: "orchestrator" }), shelled],
    );
    expect(workingCount(starting!)).toBe(2);
    expect(workingCount(workspaceTrees([workspace], [orchestrator, c])[0]!)).toBe(0);
  });

  it("gives a workspace its most urgent status", () => {
    expect(statusOf([orchestrator, b])).toBe("needsYou");
    expect(statusOf([orchestrator, c], { questions: 1 })).toBe("needsYou");
    expect(statusOf([orchestrator, c], { working: 1 })).toBe("working");
    const reviewing = { ...c, git: { repo: true, pr: { state: "OPEN" } } } as ThreadSummary;
    expect(statusOf([orchestrator, reviewing])).toBe("inReview");
    expect(statusOf([orchestrator, c])).toBe("idle");
    // The ledger rolls a feature up to its least advanced worker; the open PR still counts.
    const building = thread("t-build", "idle", { ...spawned("paging"), createdAt: 4 });
    const [tree] = workspaceTrees([workspace], [orchestrator, reviewing, building]);
    const rolledUp = {
      ...tree!,
      features: tree!.features.map((f) => ({ ...f, state: "working" as const })),
    };
    expect(workspaceStatus(rolledUp)).toBe("inReview");
    // A PR the worker follows beside its own counts the same.
    const following = {
      ...c,
      git: {
        repo: true,
        extraPrs: [{ url: "https://github.com/example/web/pull/7", state: "OPEN" }],
      },
    } as unknown as ThreadSummary;
    const [beside] = workspaceTrees([workspace], [orchestrator, following, building]);
    expect(
      workspaceStatus({
        ...beside!,
        features: beside!.features.map((f) => ({ ...f, state: "working" as const })),
      }),
    ).toBe("inReview");
    const parked = thread("t-orch", "idle", { role: "orchestrator", parked: true });
    expect(statusOf([parked, b])).toBe("parked");
    // A parked worker's request is set aside with it.
    const setAside = thread("t-b", "needsApproval", { ...spawned("mail"), parked: true }, [
      push("r-b"),
    ]);
    expect(statusOf([orchestrator, setAside])).toBe("idle");
  });

  it("parks a workspace by its orchestrator's own flag only", () => {
    const parked = thread("t-orch", "idle", { role: "orchestrator", parked: true });
    expect(statusOf([parked, a])).toBe("parked");
    // A parked worker is just finished.
    expect(statusOf([orchestrator, { ...a, thread: { ...a.thread, parked: true } }])).toBe("idle");
  });

  it("says what removing a workspace closes, deletes and keeps", () => {
    const inWorktree = thread("t-w", "idle", {
      ...spawned("mail"),
      checkout: { kind: "worktree", path: "/repo/.worktrees/mail", branch: "feat/mail" },
    });
    const removal = workspaceRemoval(workspace, [orchestrator, a, inWorktree, dream, elsewhere]);
    expect(removal.orchestrator).toBe(orchestrator);
    expect(removal.workers.map((w) => w.thread.id)).toEqual(["t-a", "t-w", "t-x"]);
    expect(removal.passes).toEqual([dream]);
    expect(workersText(removal)).toBe("its 3 workers");
    const kept = removalLines(removal, false);
    expect(kept.happens).toEqual([
      "The orchestrator stops and its thread closes.",
      "Its 3 workers stay open as ordinary threads, answering to no one.",
      "Its dream pass stops and closes, since a dream can't be reviewed without its workspace.",
      "Its charter, stages, groups, worker reports, dreams and history are deleted. This can't be undone.",
    ]);
    expect(kept.kept[0]).toBe("The workers' worktrees and branches stay on disk, commits and all.");
    expect(kept.kept.join(" ")).toContain("memory, open questions included, stays");
    expect(removalLines(removal, true).happens[1]).toBe("Its 3 workers stop and close.");

    // A workspace nobody orchestrates has only its record to lose.
    const vacant = workspaceRemoval(vacantWorkspace, [a]);
    expect(workersText(vacant)).toBeUndefined();
    expect(removalLines(vacant, false).happens).toEqual([
      "Its charter, stages, groups, worker reports, dreams and history are deleted. This can't be undone.",
    ]);
    const one = workspaceRemoval(workspace, [orchestrator, a]);
    expect(removalLines(one, true).happens[1]).toBe("Its worker stops and closes.");
    expect(removalLines(one, false).kept[0]).toContain("memory");
  });

  it("names an orchestrator's row after its workspace, unless the thread was renamed", () => {
    // Opened as "Orchestrator · api", and the workspace renamed since.
    expect(orchestratorRowTitle("Orchestrator · api", "platform")).toBe("platform");
    expect(orchestratorRowTitle("Release train", "platform")).toBe("Release train");
    // With the workspace unknown, the name it was opened under.
    expect(orchestratorRowTitle("Orchestrator · api")).toBe("api");
    expect(orchestratorRowTitle("Release train")).toBe("Release train");
  });

  it("lifts a tree to Needs you for what waits on the orchestrator, not for its checkout's PR", () => {
    useAttentionStore.setState({ loaded: true, acknowledged: {} });
    const red = {
      repo: true,
      pr: {
        number: 9,
        state: "OPEN",
        url: "https://github.com/example/api/pull/9",
        title: "Old branch",
        isDraft: false,
        checks: "failing",
        headMatches: true,
        aheadOfPr: false,
      },
    } as GitState;
    const [own] = workspaceTrees([workspace], [{ ...orchestrator, git: red }, c]);
    expect(rollupOf(treeThreads(own!))).toBe("idle");
    const [under] = workspaceTrees([workspace], [orchestrator, { ...c, git: red }]);
    expect(rollupOf(treeThreads(under!))).toBe("needsYou");
    const asking = thread("t-orch", "needsApproval", { role: "orchestrator" }, [push("r-o")]);
    const [waiting] = workspaceTrees([workspace], [{ ...asking, git: red }, c]);
    expect(rollupOf(treeThreads(waiting!))).toBe("needsYou");
  });

  it("takes each feature's state from the ledger, and does without until it arrives", () => {
    const ledger = { features: [feature("mail", "needsUser", [])] } as never;
    const [withLedger] = workspaceTrees([workspace], [a, b], new Map([[ws, ledger]]));
    expect(withLedger?.features[0]?.state).toBe("needsUser");
    expect(workspaceTrees([workspace], [a, b])[0]?.features[0]?.state).toBeUndefined();
  });

  it("keeps a feature unfinished while a worker runs, waits, or the ledger says otherwise", () => {
    const mergedFields = {
      ...spawned("mail"),
      completedAt: 1,
      completedReason: "prMerged" as const,
    };
    const idle = thread("t-1", "idle", mergedFields);
    expect(featureFinished(mailFeature([idle]))).toBe(true);
    expect(featureFinished(mailFeature([thread("t-2", "running", mergedFields)]))).toBe(false);
    expect(featureFinished(mailFeature([thread("t-3", "needsInput", mergedFields)]))).toBe(false);
    expect(featureFinished(mailFeature([idle, thread("t-4", "idle", spawned("mail"))]))).toBe(
      false,
    );
    expect(featureFinished(mailFeature([idle], "inReview"))).toBe(false);
    expect(
      featureFinished(mailFeature([thread("t-5", "idle", spawned("mail"))], "delivered")),
    ).toBe(true);
    expect(featureFinished(mailFeature([]))).toBe(false);
    // A second PR, followed beside the merged one, keeps the worker live until it merges or closes.
    const across = (state?: "OPEN" | "MERGED" | "CLOSED") => ({
      ...thread("t-6", "idle", {
        ...mergedFields,
        extraPrs: [{ repo: "example/web", number: 7, monitor: false }],
      }),
      git: {
        repo: true,
        worktree: true,
        head: "abc",
        changesToken: "t",
        changedFiles: 0,
        behindBase: 0,
        aheadBase: 0,
        conflicts: false,
        ...(state === undefined ? {} : { extraPrs: [extraBadge(state)] }),
      },
    });
    expect(featureFinished(mailFeature([across()]))).toBe(false);
    expect(featureFinished(mailFeature([across("OPEN")]))).toBe(false);
    expect(featureFinished(mailFeature([across("MERGED")]))).toBe(true);
    expect(featureFinished(mailFeature([across("CLOSED")]))).toBe(true);
  });

  it("keeps a reported-done feature visible for the orchestrator before delivery", () => {
    const reported = worker("t-reported", "report", "done");
    const summary = thread("t-reported", "idle", spawned("report"));
    const ledger = { features: [feature("report", "done", [reported])] } as never;
    const [tree] = workspaceTrees([workspace], [summary], new Map([[ws, ledger]]));
    expect(featureFinished(tree!.features[0]!, tree!.entries)).toBe(false);
  });

  for (const kind of ["question", "approval"] as const) {
    it(`keeps a live ${kind} visible with a partial archived ledger`, () => {
      const request: PendingRequest =
        kind === "question"
          ? { kind, id: "q-partial" as RequestId, questions: [] }
          : push("a-partial");
      const summary = {
        ...thread("t-partial", "idle", spawned("partial")),
        pendingRequests: [request],
      };
      // The feature rollup arrived, but the current worker's ledger entry has not.
      const ledger = { features: [feature("partial", "archived", [])] } as never;
      const [tree] = workspaceTrees([workspace], [summary], new Map([[ws, ledger]]));
      const current = tree!.features[0]!;
      expect(tree!.entries.size).toBe(0);
      expect(featureFinished(current, tree!.entries)).toBe(false);
      expect(featureFinished(current)).toBe(false);
    });
  }

  it("still finishes a quiet feature with no worker ledger entry", () => {
    const summary = thread("t-partial-quiet", "idle", spawned("partial"));
    const ledger = { features: [feature("partial", "archived", [])] } as never;
    const [tree] = workspaceTrees([workspace], [summary], new Map([[ws, ledger]]));
    expect(featureFinished(tree!.features[0]!, tree!.entries)).toBe(true);
  });

  it("finishes an archived worker with a stale thread error, but keeps actual requests live", () => {
    const archived = worker("t-archived-error", "old", "archived", { status: "error" });
    const errorThread = thread("t-archived-error", "error", spawned("old"));
    const askingThread = thread("t-asking", "needsApproval", spawned("old"));
    const asking = worker("t-asking", "old", "archived", { status: "needsApproval" });
    const state: WorkspaceState = { ...workspace, groups: { old: { features: ["old"] } } };
    const ledger = {
      features: [feature("old", "archived", [archived])],
      groups: [{ group: "old", features: ["old"], state: "archived" }],
    } as never;
    const [tree] = workspaceTrees([state], [errorThread], new Map([[ws, ledger]]));
    expect(featureFinished(tree!.features[0]!, tree!.entries)).toBe(true);
    expect(workspaceStatus(tree!)).toBe("idle");
    expect(
      workerWait(asking, liveWorkerState(asking.state, askingThread.status), askingThread.status),
    ).toMatchObject({ bucket: "person" });
  });

  it("keeps an archived error worker's live request waiting on a person", () => {
    const archived = worker("t-board-request", "old", "archived", { status: "error" });
    const summary = {
      ...thread("t-board-request", "error", spawned("old")),
      pendingRequests: [
        { kind: "question", id: "q-board" as RequestId, questions: [] } as PendingRequest,
      ],
    };
    const card = liveWorkerEntry(archived, summary);
    expect(workerWait(card, card.state, card.status)).toMatchObject({
      bucket: "person",
      tag: "you: answer",
    });
  });

  it("uses live card requests, and drops answered ones", () => {
    const request = {
      kind: "question",
      id: "q-live" as RequestId,
      questions: [],
    } as PendingRequest;
    const archived = worker("t-live-card", "old", "archived", {
      status: "error",
      pendingRequests: [{ kind: "question", requestId: request.id, ageMin: 3, askedAt: 0 }],
    });
    const live = liveWorkerEntry(archived, { status: "error", pendingRequests: [request] });
    expect(live.state).toBe("needsUser");
    expect(liveWorkerEntry(archived, undefined).state).toBe("needsUser");
    const answered = liveWorkerEntry(archived, { status: "error", pendingRequests: [] });
    expect(answered.state).toBe("archived");
    const different = liveWorkerEntry(archived, {
      status: "starting",
      pendingRequests: [{ ...request, id: "q-new" as RequestId }],
    });
    expect(different.state).toBe("needsUser");
  });

  it("keeps a live request visible before the archived ledger refreshes", () => {
    const archived = worker("t-request-race", "old", "archived", { status: "error" });
    const summary = {
      ...thread("t-request-race", "error", spawned("old")),
      pendingRequests: [
        { kind: "question", id: "q-race" as RequestId, questions: [] } as PendingRequest,
      ],
    };
    const entries = new Map([[summary.thread.id, archived]]);
    const live = liveWorkerEntry(archived, summary);
    expect(workerWait(live, live.state, live.status)).toMatchObject({ bucket: "person" });
    expect(
      featureFinished({ feature: "old", workers: [summary], state: "archived" }, entries),
    ).toBe(false);
  });

  it("keeps a workspace whose orchestrator is closed, with its workers", () => {
    const [tree] = workspaceTrees([workspace], [a]);
    expect(tree?.orchestrator).toBeUndefined();
    expect(tree?.features).toHaveLength(1);
    expect(workspaceTrees([], [a])).toEqual([]);
  });
});

describe("feature stages", () => {
  const hour = 60 * 60_000;
  const now = 100 * hour;
  const plan = ["contract", "build", "preview", "rollout"];

  it("split a plan into done, current and upcoming, and say who set it when", () => {
    const model = stepperModel(
      { plan, stage: "build", note: " ", setBy: "orchestrator", setAt: now - 2 * hour },
      now,
    );
    expect(model.steps?.map((step) => step.status)).toEqual([
      "done",
      "current",
      "upcoming",
      "upcoming",
    ]);
    expect(model).toMatchObject({
      current: "build",
      position: "2 of 4",
      attribution: "set by the orchestrator · 2h ago",
      stale: false,
      note: undefined,
    });
    expect(stepperModel({ plan, stage: "rollout", setBy: "user", setAt: now }, now)).toMatchObject({
      position: "4 of 4",
      attribution: "set by you · just now",
    });
  });

  it("read a free label, and a stage its plan doesn't name, as a label", () => {
    const free = stepperModel({ stage: "waiting on legal", setBy: "user", setAt: now }, now);
    expect(free.steps).toBeUndefined();
    expect(free.position).toBeUndefined();
    expect(stepperModel({ plan, stage: "elsewhere", setBy: "user", setAt: now }, now).steps).toBe(
      undefined,
    );
  });

  it("call a stage stale after a day, and word the chip's tooltip", () => {
    const at = (age: number) =>
      stepperModel(
        { plan, stage: "build", note: "Agreed on Monday.", setBy: "user", setAt: now - age },
        now,
      );
    expect(at(STAGE_STALE_MS).stale).toBe(false);
    expect(at(STAGE_STALE_MS + 1).stale).toBe(true);
    expect(stageTitle(at(26 * hour))).toBe(
      "Stage: build (2 of 4)\nset by you · 1d ago, which may be out of date\nAgreed on Monday.",
    );
    expect(agoText(now - 5 * 60_000, now)).toBe("5m ago");
  });
});

const entry = (
  id: string,
  featureName: string | undefined,
  request: PendingRequest,
  project = "api",
): InboxEntry => ({
  threadId: id as ThreadId,
  title: `Title of ${id}`,
  project,
  feature: featureName,
  request,
});

const issueReport = (id: string): PendingRequest => ({
  ...push(id),
  toolName: "mcp__gram__report_issue",
  input: { repo: "ANT1OFF/gram", labels: ["bug"], title: "t", body: "b" },
});

const bash = (id: string, input: Record<string, unknown>): ApprovalRequest => ({
  ...push(id),
  input,
});

describe("approvals inbox", () => {
  it("lists a workspace's requests, the orchestrator's first", () => {
    const orchestrator = thread("t-orch", "needsApproval", { role: "orchestrator" }, [push("r-o")]);
    const b = thread("t-b", "needsApproval", spawned("mail"), [push("r-b")]);
    const [tree] = workspaceTrees([workspace], [b, orchestrator]);
    const entries = inboxEntries(tree!, () => "api");
    expect(entries.map((e) => [e.request.id, e.feature, e.project])).toEqual([
      ["r-o", undefined, "api"],
      ["r-b", "mail", "api"],
    ]);
    // Where the agent is now, which is where an allowed command runs.
    const moved = thread(
      "t-m",
      "needsApproval",
      {
        ...spawned("mail"),
        currentCheckout: { kind: "worktree", path: "/repo/.wt/m", branch: "m" },
      },
      [push("r-m")],
    );
    const [withMoved] = workspaceTrees([workspace], [b, moved, orchestrator]);
    expect(inboxEntries(withMoved!).map((e) => e.checkout?.path)).toEqual([
      "/repo",
      "/repo",
      "/repo/.wt/m",
    ]);
  });

  it("folds identical approvals of one feature, and nothing else", () => {
    const question: PendingRequest = { kind: "question", id: "q" as RequestId, questions: [] };
    const groups = groupInbox([
      entry("a", "mail", push("r-a")),
      entry("b", "mail", push("r-b")),
      entry("c", "paging", push("r-c")),
      entry("d", "mail", push("r-d", "git push --force")),
      entry("e", "mail", { ...push("r-e"), toolName: "Shell" }),
      entry("f", "mail", question),
      entry("g", "mail", { ...question, id: "q2" as RequestId }),
      entry("o", undefined, push("r-o")),
      entry("o2", undefined, push("r-o2")),
      entry("h", "mail", push("r-h")),
    ]);
    expect(groups.map((g) => g.entries.map((e) => e.threadId))).toEqual([
      ["a", "b", "h"],
      ["c"],
      ["d"],
      ["e"],
      ["f"],
      ["g"],
      ["o"],
      ["o2"],
    ]);
    expect(new Set(groups.map((g) => g.key)).size).toBe(groups.length);
  });

  it("never folds issue reports, which are read in full before they're allowed", () => {
    const groups = groupInbox([
      entry("a", "mail", issueReport("r-a")),
      entry("b", "mail", issueReport("r-b")),
    ]);
    expect(groups.map((g) => g.entries.length)).toEqual([1, 1]);
  });

  it("folds only on the whole input, whatever order its keys came in", () => {
    const command = "git push -u origin feat/x";
    const cases: readonly {
      readonly name: string;
      readonly entries: readonly InboxEntry[];
      readonly groups: readonly (readonly string[])[];
    }[] = [
      {
        name: "the same subject over another hidden argument",
        entries: [
          entry("a", "mail", bash("r-a", { command })),
          entry("b", "mail", bash("r-b", { command, timeout: 600_000 })),
          entry("c", "mail", bash("r-c", { command, run_in_background: true })),
        ],
        groups: [["a"], ["b"], ["c"]],
      },
      {
        name: "the same input with its keys in another order, at any depth",
        entries: [
          entry("a", "mail", bash("r-a", { command, env: { CI: "1", HOME: "/h" }, timeout: 5 })),
          entry("b", "mail", bash("r-b", { timeout: 5, env: { HOME: "/h", CI: "1" }, command })),
        ],
        groups: [["a", "b"]],
      },
      {
        name: "a list in another order is another input",
        entries: [
          entry("a", "mail", bash("r-a", { command, args: ["--tags", "--force"] })),
          entry("b", "mail", bash("r-b", { command, args: ["--force", "--tags"] })),
        ],
        groups: [["a"], ["b"]],
      },
      {
        name: "equal inputs of two features",
        entries: [
          entry("a", "mail", bash("r-a", { command, timeout: 5 })),
          entry("b", "paging", bash("r-b", { command, timeout: 5 })),
        ],
        groups: [["a"], ["b"]],
      },
      {
        name: "equal inputs from two worktrees, which the card lists rather than the key splits",
        entries: [
          { ...entry("a", "mail", bash("r-a", { command })), checkout: { path: "/repo/.wt/a" } },
          { ...entry("b", "mail", bash("r-b", { command })), checkout: { path: "/web/.wt/b" } },
        ],
        groups: [["a", "b"]],
      },
    ];
    for (const { name, entries, groups } of cases) {
      expect(
        groupInbox(entries).map((g) => g.entries.map((e) => e.threadId)),
        name,
      ).toEqual(groups);
    }

    expect(canonicalJson({ b: [1, { d: null, c: "x" }], a: undefined })).toBe(
      '{"b":[1,{"c":"x","d":null}]}',
    );
    expect(canonicalJson([undefined, "\0"])).toBe('[null,"\\u0000"]');
    // A string that spells out an object is not that object.
    expect(canonicalJson({ a: '{"b":1}' })).not.toBe(canonicalJson({ a: { b: 1 } }));
  });

  it("answers a group in one call, and says which workers weren't answered and why", async () => {
    const [group] = groupInbox([
      entry("a", "mail", push("r-a")),
      entry("b", "mail", push("r-b"), "web"),
      entry("c", "mail", push("r-c")),
    ]);
    const calls: string[][] = [];
    const respondMany: RespondMany = async (answers) => {
      calls.push(answers.map((each) => `${each.threadId}:${JSON.stringify(each.answer)}`));
      // The server reports each in its own row, and may leave one out altogether.
      return answers
        .filter((each) => each.threadId !== "c")
        .map(({ threadId, requestId }) =>
          threadId === "b"
            ? { threadId, requestId, ok: false, error: "That request was already answered." }
            : { threadId, requestId, ok: true },
        );
    };
    const result = await answerGroup(group!, "allow", respondMany);
    const once = JSON.stringify({ kind: "approval", decision: "allow", scope: "once" });
    expect(calls).toEqual([[`a:${once}`, `b:${once}`, `c:${once}`]]);
    expect(result.answered.map((e) => e.threadId)).toEqual(["a"]);
    expect(failureText(result)).toBe(
      "Answered 1 of 3. Not answered: “Title of b” (web): That request was already answered; “Title of c” (api): The server didn't say how it went. Open them to answer there.",
    );

    const clean = await answerGroup(group!, "deny", async (answers) =>
      answers.map(({ threadId, requestId }) => ({ threadId, requestId, ok: true })),
    );
    expect(clean.failed).toEqual([]);
    expect(failureText(clean)).toBeUndefined();

    // A call that never got there answered nobody.
    const down = await answerGroup(group!, "allow", async () => {
      throw new Error("socket closed");
    });
    expect(down.answered).toEqual([]);
    expect(failureText(down)).toContain(
      "Answered 0 of 3. Not answered: “Title of a” (api): socket closed;",
    );
  });
});

/** The stage names a ledger shows: of its first two features, then of its first group. */
const shownStages = (ledger: OrchestratorLedger) => [
  ledger.features[0]?.stage?.stage,
  ledger.features[1]?.stage?.stage,
  ledger.groups?.[0]?.stage?.stage,
];

describe("setting a stage", () => {
  const planned: FeatureStage = {
    plan: ["contract", "build", "merge"],
    stage: "build",
    note: "was here",
    setBy: "orchestrator",
    setAt: 1,
  };

  it("drafts a plan, moves and removes steps with the current one following its name", () => {
    const draft = draftOfStage(planned);
    expect(draft).toEqual({ steps: planned.plan, current: 1, label: "build", note: "was here" });
    expect(draftOfStage(undefined)).toEqual({ steps: [], current: 0, label: "", note: "" });
    // A stage that isn't one of its plan can't be placed, so it is edited as the free label it reads as.
    expect(draftOfStage({ ...planned, stage: "elsewhere" }).steps).toEqual([]);

    const up = moveStep(draft, 1, 0);
    expect([up.steps, up.current]).toEqual([["build", "contract", "merge"], 0]);
    const past = moveStep(draft, 0, 2);
    expect([past.steps, past.current]).toEqual([["build", "merge", "contract"], 0]);
    expect(moveStep(draft, 0, -1)).toBe(draft);
    expect(moveStep(draft, 2, 3)).toBe(draft);

    expect(removeStep(draft, 0)).toMatchObject({ steps: ["build", "merge"], current: 0 });
    expect(removeStep(draft, 1)).toMatchObject({ steps: ["contract", "merge"], current: 1 });
    expect(removeStep(draft, 2)).toMatchObject({ steps: ["contract", "build"], current: 1 });
    const last = removeStep({ ...draft, steps: ["only"], current: 0 }, 0);
    expect(last).toMatchObject({ steps: [], label: "only" });

    expect(addStep(draftOfStage(undefined)).steps).toEqual([""]);
    expect(addStep({ ...draftOfStage(undefined), label: " waiting " }).steps).toEqual([
      "waiting",
      "",
    ]);
    const full = { ...draft, steps: Array.from({ length: 8 }, (_, i) => `s${i}`) };
    expect(addStep(full)).toBe(full);
  });

  it("holds a draft to the server's rules before it is sent", () => {
    const draft = draftOfStage(planned);
    expect(validatePlanDraft(draft)).toEqual({
      input: { stage: "build", plan: ["contract", "build", "merge"], note: "was here" },
    });
    // A free label drops the plan the target had, which the server is told with an empty one.
    expect(validatePlanDraft({ steps: [], current: 0, label: " waiting ", note: " " })).toEqual({
      input: { stage: "waiting", plan: [] },
    });
    const error = (next: Partial<PlanDraft>) => {
      const result = validatePlanDraft({ ...draft, ...next });
      return "error" in result ? result.error : undefined;
    };
    expect(error({ steps: [], label: "" })).toBe("Name the stage.");
    expect(error({ steps: ["a", " "] })).toBe("Every step needs a name.");
    expect(error({ steps: ["a", "a "] })).toBe("Two steps have the same name.");
    expect(error({ steps: ["x".repeat(41)] })).toContain("at most 40 characters");
    expect(error({ steps: Array.from({ length: 9 }, (_, i) => `s${i}`) })).toBe(
      "A plan has at most 8 steps.",
    );
    expect(error({ note: "n".repeat(1_000) })).toBeUndefined();
    expect(error({ note: "n".repeat(1_001) })).toBe("The note is at most 1000 characters.");
  });

  it("shows the stage as the user's at once, on the workspace and on the ledger", () => {
    // A click on a step keeps the plan and drops the note, which was about the stage before.
    expect(optimisticStage(planned, { stage: "merge" }, 9)).toEqual({
      plan: planned.plan,
      stage: "merge",
      setBy: "user",
      setAt: 9,
    });
    expect(optimisticStage(planned, { stage: "free", plan: [] }, 9)).toEqual({
      stage: "free",
      setBy: "user",
      setAt: 9,
    });
    expect(optimisticStage(undefined, { stage: "a", plan: ["a", "b"], note: "n" }, 9)).toEqual({
      plan: ["a", "b"],
      stage: "a",
      note: "n",
      setBy: "user",
      setAt: 9,
    });

    const state: WorkspaceState = {
      workspace: {
        id: ws,
        name: "w",
        projectIds: ["p-api" as ProjectId],
        homeProjectId: "p-api" as ProjectId,
        createdAt: 0,
      },
      charter: { maxConcurrentWorkers: 10 },
      groups: { release: { features: ["mail"] } },
    };
    const stage = optimisticStage(undefined, { stage: "merge" }, 9);
    expect(stageOf(withStage(state, { feature: "mail" }, stage), { feature: "mail" })).toBe(stage);
    expect(stageOf(withStage(state, { group: "release" }, stage), { group: "release" })).toBe(
      stage,
    );
    expect(withStage(state, { group: "nowhere" }, stage)).toBe(state);

    const ledger = {
      workspaceId: ws,
      features: [feature("mail", "working", []), feature("other", "working", [])],
      groups: [{ group: "release", features: ["mail"], state: "working" as const }],
      budget: { liveWorkers: 0, maxConcurrentWorkers: 10, costUsdToday: 0 },
      orchestratorEdits: 0,
      builtAt: 0,
    };
    const onFeature = ledgerWithStage(ledger, { feature: "mail" }, stage);
    expect(onFeature.features.map((f) => f.stage)).toEqual([stage, undefined]);
    expect(ledgerWithStage(ledger, { group: "release" }, stage).groups?.[0]?.stage).toBe(stage);

    expect(groupSlug(" Release 0.4 ")).toBe("release-0-4");
    expect(groupSlug("---")).toBeUndefined();
    expect(groupSlug("x".repeat(49))).toBeUndefined();
  });

  it("holds a stage set here over a ledger the server built before it", () => {
    const built = (stages: Readonly<Record<string, FeatureStage>>, group?: FeatureStage) => ({
      workspaceId: ws,
      features: ["mail", "docs"].map((name) => ({
        ...feature(name, "working", []),
        ...(stages[name] === undefined ? {} : { stage: stages[name] }),
      })),
      groups: [
        {
          group: "release",
          features: ["mail"],
          state: "working" as const,
          ...(group === undefined ? {} : { stage: group }),
        },
      ],
      budget: { liveWorkers: 0, maxConcurrentWorkers: 10, costUsdToday: 0 },
      orchestratorEdits: 0,
      builtAt: 0,
    });
    const old: FeatureStage = { stage: "build", setBy: "orchestrator", setAt: 5 };
    const holds = createStageHolds();
    expect(holds.settle(built({ mail: old }))).toEqual(built({ mail: old }));

    // While the server is asked, every ledger there is was built before the write.
    const docs = holds.hold(ws, { feature: "docs" }, optimisticStage(undefined, { stage: "x" }, 9));
    expect(shownStages(holds.settle(built({ mail: old })))).toEqual(["build", "x", undefined]);
    // The answer is what the server stored, and a ledger it had begun before the write still comes.
    const stored: FeatureStage = { stage: "x", setBy: "user", setAt: 12 };
    docs.confirm(stored);
    expect(holds.settle(built({ mail: old })).features[1]?.stage).toBe(stored);
    // The ledger that carries it ends the hold, so what the orchestrator says next is shown.
    expect(shownStages(holds.settle(built({ mail: old, docs: stored })))).toEqual([
      "build",
      "x",
      undefined,
    ]);
    const later: FeatureStage = { stage: "y", setBy: "orchestrator", setAt: 11 };
    expect(shownStages(holds.settle(built({ docs: later })))).toEqual([undefined, "y", undefined]);

    // A refusal lets go at once, a group is held like a feature, and only the last click on a
    // target counts.
    const refused = holds.hold(ws, { feature: "mail" }, { ...stored, stage: "no" });
    refused.release();
    const first = holds.hold(ws, { group: "release" }, { ...stored, stage: "one" });
    const second = holds.hold(ws, { group: "release" }, { ...stored, stage: "two" });
    first.confirm({ ...stored, stage: "one" });
    expect(shownStages(holds.settle(built({ mail: old })))).toEqual(["build", undefined, "two"]);
    second.confirm({ ...stored, stage: "two", setAt: 20 });
    const newer: FeatureStage = { stage: "three", setBy: "orchestrator", setAt: 21 };
    expect(shownStages(holds.settle(built({}, newer)))).toEqual([undefined, undefined, "three"]);
    expect(shownStages(holds.settle(built({})))).toEqual([undefined, undefined, undefined]);
  });
});

/** A stream that yields what is pushed to it and ends on abort, counting how often it was opened. */
const harness = () => {
  const opened: string[] = [];
  const closed: string[] = [];
  const published: string[] = [];
  const pushers = new Map<string, (ledger: OrchestratorLedger) => void>();
  const watch = createLedgerWatch({
    keepWarmMs: 50,
    publish: (ledger) => published.push(`${ledger.workspaceId}@${ledger.builtAt}`),
    open: (workspaceId, signal) => {
      opened.push(workspaceId);
      const queue: OrchestratorLedger[] = [];
      let wake: (() => void) | undefined;
      pushers.set(workspaceId, (ledger) => {
        queue.push(ledger);
        wake?.();
      });
      signal.addEventListener("abort", () => {
        closed.push(workspaceId);
        wake?.();
      });
      return (async function* () {
        while (!signal.aborted) {
          if (queue.length > 0) yield queue.shift()!;
          else await new Promise<void>((resolve) => (wake = resolve));
        }
      })();
    },
  });
  const emit = (workspaceId: WorkspaceId, builtAt: number) =>
    pushers.get(workspaceId)?.({
      workspaceId,
      features: [],
      budget: { liveWorkers: 0, maxConcurrentWorkers: 10, costUsdToday: 0 },
      orchestratorEdits: 0,
      builtAt,
    });
  return { watch, opened, closed, published, emit };
};

describe("the ledger watch", () => {
  it("opens one stream per workspace however many views show it, and closes it after the last", async () => {
    vi.useFakeTimers();
    try {
      const { watch, opened, closed, published, emit } = harness();
      const other = "w-2" as WorkspaceId;
      const board = watch.retain(ws);
      const tree = watch.retain(ws);
      const banner = watch.retain(other);
      expect(opened).toEqual([ws, other]);
      expect(watch.watching()).toEqual([ws, other]);

      emit(ws, 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(published).toEqual([`${ws}@1`]);

      board();
      board();
      await vi.advanceTimersByTimeAsync(100);
      expect(closed).toEqual([]);

      // The last viewer gone: kept warm for a moment, so coming straight back reopens nothing.
      tree();
      await vi.advanceTimersByTimeAsync(40);
      const back = watch.retain(ws);
      await vi.advanceTimersByTimeAsync(100);
      expect(closed).toEqual([]);
      expect(opened).toEqual([ws, other]);

      back();
      banner();
      await vi.advanceTimersByTimeAsync(60);
      expect(closed.toSorted()).toEqual([other, ws].toSorted());
      expect(watch.watching()).toEqual([]);

      watch.retain(ws);
      expect(opened).toEqual([ws, other, ws]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is live from a stream's first ledger until it closes", async () => {
    vi.useFakeTimers();
    try {
      const { watch, emit } = harness();
      const release = watch.retain(ws);
      // Open but silent: a view still needs the fetched ledger.
      expect(watch.isLive(ws)).toBe(false);
      emit(ws, 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(watch.isLive(ws)).toBe(true);
      expect(watch.isLive("w-2" as WorkspaceId)).toBe(false);
      release();
      await vi.advanceTimersByTimeAsync(60);
      expect(watch.isLive(ws)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("frees the slot of a stream that ended by itself, so a later viewer opens a new one", async () => {
    let opens = 0;
    const watch = createLedgerWatch({
      keepWarmMs: 0,
      publish: () => {},
      // oxlint-disable-next-line require-yield
      open: async function* () {
        opens++;
      },
    });
    const release = watch.retain(ws);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(watch.watching()).toEqual([]);
    release();
    watch.retain(ws);
    expect(opens).toBe(2);
  });
});

describe("memory", () => {
  it("reads the open questions out of a questions.md written as headings", () => {
    const parsed = parseQuestions(
      [
        "# Questions for the user",
        "",
        "## Q1 · open · 2026-09-21",
        "Should the mail trigger retry on a 429?",
        "Source: mail-trigger.",
        "",
        "## Q2 · closed · 2026-09-18",
        "Which repo owns the registry schema?",
        "Answered 2026-09-19: web.",
        "",
        "### Q3: Is a merged PR enough for docs? (open)",
        "",
        "## Q4",
        "A question with no marker at all is open.",
        "- a bullet in its body isn't a question of its own",
        "",
        "## Q5",
        "Which port does Redis use?",
        "Answer: 6380.",
      ].join("\n"),
    );
    expect(parsed.map((q) => [q.id, q.open, q.text])).toEqual([
      ["Q1", true, "Should the mail trigger retry on a 429?"],
      ["Q2", false, "Which repo owns the registry schema?"],
      ["Q3", true, "Is a merged PR enough for docs?"],
      ["Q4", true, "A question with no marker at all is open."],
      ["Q5", false, "Which port does Redis use?"],
    ]);
    expect(parsed[0]?.detail).toBe("Source: mail-trigger.");
    expect(parsed[3]?.detail).toBe("a bullet in its body isn't a question of its own");
  });

  it("reads lists, checkboxes and sections too, and never throws on free text", () => {
    const parsed = parseQuestions(
      [
        "Some prose the orchestrator wrote first.",
        "",
        "## Open",
        "- [ ] Q7: Keep both installers? (2026-09-22)",
        "  continues on the next line",
        "- [x] Q8: Done already?",
        "* **Q9** — ~~not this~~ which region? [answered]",
        "- ~~Q10: struck through~~",
        "- No id on this one, is that all right?",
        "",
        "## Closed questions",
        "- Q11: under a heading that says so",
        "",
        "```",
        "- Q12: inside a code fence",
        "```",
        "1. Q13 numbered, after the fence",
      ].join("\r\n"),
    );
    expect(parsed.map((q) => [q.id, q.open])).toEqual([
      ["Q7", true],
      ["Q8", false],
      ["Q9", false],
      ["Q10", false],
      [undefined, true],
      ["Q11", false],
      ["Q13", false],
    ]);
    expect(parsed[0]).toMatchObject({
      text: "Keep both installers?",
      detail: "continues on the next line",
    });
    expect(openQuestions(undefined)).toEqual([]);
    for (const text of ["", "\n\n", "just words", "#", "- ", "## ", "- [ ]", "[[[", "## Q1\n"]) {
      expect(() => parseQuestions(text)).not.toThrow();
    }
    expect(parseQuestions("just words, and a closed door")).toEqual([]);
    // Prose that merely uses the word isn't a marker.
    expect(parseQuestions("- Q1: should the PR be closed or merged?")[0]?.open).toBe(true);
  });

  it("reads decided, dated and qualified status markers, and strips them whole", () => {
    const parsed = parseQuestions(
      [
        "# Open questions",
        "",
        "- Q1 (decided 2026-09-25): the importer runs in staging only.",
        "- Q2 (CLOSED 2026-09-25): SSO is complete. Nothing left.",
        "- Q3 (resolved on 2026-09-24) · keep the cache?",
        "- Q4 (OPEN, future idea): a second reviewer for schema changes.",
        "- Q5 (decided): the owners file covers /docs/.",
        "- Q6 [Dropped]: rename the queue?",
        "- Q7 · superseded: by Q4.",
        "- Q8 (obsolete) Pin the old runner?",
        "- Q9 (closed 2026-09-20, reopened 2026-09-25): ship the beta?",
        "- Q10 (closed door policy) keep it?",
        "- Q11: should the PR be withdrawn or settled?",
        "- Q12 (closed 2026-09-20) (reopened 2026-09-25): run the canary?",
        "- [x] Q13 (opened 2026-09-20): a ticked box stays closed",
      ].join("\n"),
    );
    expect(parsed.map((q) => [q.id, q.open, q.text])).toEqual([
      ["Q1", false, "the importer runs in staging only."],
      ["Q2", false, "SSO is complete. Nothing left."],
      ["Q3", false, "keep the cache?"],
      ["Q4", true, "a second reviewer for schema changes."],
      ["Q5", false, "the owners file covers /docs/."],
      ["Q6", false, "rename the queue?"],
      ["Q7", false, "by Q4."],
      ["Q8", false, "Pin the old runner?"],
      ["Q9", true, "ship the beta?"],
      ["Q10", true, "(closed door policy) keep it?"],
      ["Q11", true, "should the PR be withdrawn or settled?"],
      ["Q12", true, "run the canary?"],
      ["Q13", false, "a ticked box stays closed"],
    ]);
  });

  it("reads bold-led entries, as paragraphs or list items, with their status in brackets", () => {
    const paragraphs = parseQuestions(
      [
        "# Questions",
        "",
        "Open questions for the user, oldest first.",
        "",
        "## Open",
        "",
        "**Q1 · Which installer should ship?** Opened 2026-09-24 (001). Both build today;",
        "one should go.",
        "",
        "**Q2 · Keep the beta channel open to",
        "everyone?** Opened 2026-09-22.",
        "- option a",
        "- option b",
        "",
        "**Q3 · Rotate the key?** (decided 2026-09-25) Yes, monthly.",
        "- [ ] Q4: a checkbox entry after a paragraph is its own",
        "",
        "**Q5 · Keep the old runner?** Dropped 2026-09-25: no longer supported.",
        "",
        "**Q6 · Split the job?** Done so far: the lint half.",
        "",
        "## Closed",
        "",
        "**Q-REL-040 · Tag the release from main?** Closed 2026-09-24: yes.",
      ].join("\n"),
    );
    expect(paragraphs.map((q) => [q.id, q.open, q.text, q.detail])).toEqual([
      [
        "Q1",
        true,
        "Which installer should ship?",
        "Opened 2026-09-24 (001). Both build today;\none should go.",
      ],
      [
        "Q2",
        true,
        "Keep the beta channel open to everyone?",
        "Opened 2026-09-22.\noption a\noption b",
      ],
      ["Q3", false, "Rotate the key?", "Yes, monthly."],
      ["Q4", true, "a checkbox entry after a paragraph is its own", undefined],
      ["Q5", false, "Keep the old runner?", undefined],
      ["Q6", true, "Split the job?", "Done so far: the lint half."],
      ["Q-REL-040", false, "Tag the release from main?", undefined],
    ]);

    // A closing line is the entry's answer, and the word it opens with how it was closed.
    expect(paragraphs.at(-1)).toMatchObject({ closedAs: "closed", answer: "yes." });
    expect(paragraphs.find((q) => q.id === "Q5")).toMatchObject({
      closedAs: "dropped",
      answer: "no longer supported.",
    });

    const items = parseQuestions(
      [
        "## Open",
        "- **Q1 (opened 2026-09-23): does the gate cover forks?** Seen on #12.",
        "  More context.",
        "  - a nested point",
        "- **Q4 (opened 2026-09-24, partly answered 2026-09-24): who merges?**",
        "- **Q6 (opened 2026-09-17, closed 2026-09-24): which runner?** macOS.",
        "## Closed",
        "- **Q-C1 (closed 2026-09-22): drop the cache?**",
        "## Asked",
        "- **Q7 (opened 2026-09-23): use Redis?** Dropped 2026-09-25: no longer needed.",
        "- **Q8 (opened 2026-09-23): use Kafka?**",
      ].join("\n"),
    );
    expect(items.map((q) => [q.id, q.open, q.text, q.detail])).toEqual([
      ["Q1", true, "does the gate cover forks?", "Seen on #12.\nMore context.\na nested point"],
      ["Q4", true, "who merges?", undefined],
      ["Q6", false, "which runner?", "macOS."],
      ["Q-C1", false, "drop the cache?", undefined],
      ["Q7", false, "use Redis?", undefined],
      ["Q8", true, "use Kafka?", undefined],
    ]);
  });

  it("holds a file to the caps and the path rules before it is sent", () => {
    expect(memorySize("goals.md", "é".repeat(10))).toEqual({
      bytes: 20,
      cap: 32 * 1024,
      over: false,
    });
    expect(memorySize("MEMORY.md", "x".repeat(8 * 1024 + 1)).over).toBe(true);
    expect(memorySize("goals.md", "x".repeat(8 * 1024 + 1)).over).toBe(false);
    expect(memorySize("goals.md", "x".repeat(32 * 1024 + 1)).over).toBe(true);

    expect(memoryPathProblem("repos/api.md")).toBeUndefined();
    expect(memoryPathProblem("")).toContain("Name the file");
    expect(memoryPathProblem("/etc/x.md")).toContain("relative");
    expect(memoryPathProblem("../x.md")).toContain("relative");
    expect(memoryPathProblem("a/b/c/d.md")).toContain("two folders deep");
    expect(memoryPathProblem("notes.txt")).toContain(".md");
    expect(memoryPathProblem("a/.md")).toContain(".md");
    expect(memoryPathProblem("goals.md", ["goals.md"])).toContain("already");
    expect(
      memoryPathProblem(
        "new.md",
        Array.from({ length: 40 }, (_, i) => `f${i}.md`),
      ),
    ).toContain("at most 40");

    expect(memoryIsEmpty([])).toBe(true);
    expect(memoryIsEmpty([{ path: "MEMORY.md" }])).toBe(true);
    expect(memoryIsEmpty([{ path: "MEMORY.md" }, { path: "goals.md" }])).toBe(false);
  });
});

const dreamRecord = (extra: Partial<Dream> = {}): Dream => ({
  id: "dream-0001" as DreamId,
  workspaceId: ws,
  kind: "dream",
  mode: "review",
  status: "completed",
  inputs: { memoryVersion: "0002", threadIds: [], agentSessions: [] },
  model: { agent: "claude", model: "opus" },
  outputDir: "/d",
  createdAt: 0,
  ...extra,
});

describe("dreams", () => {
  const files = [
    { path: "z.md", status: "unchanged" },
    { path: "b.md", status: "changed", before: "a\n", after: "b\n" },
    { path: "c.md", status: "conflict", before: "a\n", after: "b\n", current: "c\n" },
    { path: "a.md", status: "added", after: "x\n" },
  ] as const;
  const withMerge = (merge?: DreamFileDiff["merge"]): DreamFileDiff[] => [
    { ...files[2], ...(merge === undefined ? {} : { merge }) },
    { path: "gone.md", status: "conflict", before: "a\n", after: "b\n" },
  ];

  it("enables Adopt only for a completed dream with every conflict decided", () => {
    const review = { dream: dreamRecord(), files };
    expect(adoptState(review, {})).toEqual({
      enabled: false,
      unresolved: ["c.md"],
      reason: "Choose a side for c.md first.",
    });
    expect(adoptState(review, { "c.md": "current" })).toEqual({ enabled: true, unresolved: [] });
    // A side chosen for a file that is no conflict any more isn't passed on.
    expect(resolutionsToSend(review, { "c.md": "output", "b.md": "current" })).toEqual({
      "c.md": "output",
    });
    expect(
      adoptState({ dream: dreamRecord({ status: "failed" }), files }, { "c.md": "output" }),
    ).toMatchObject({
      enabled: false,
      reason: "Only a completed dream can be adopted.",
    });
    expect(
      adoptState({ dream: dreamRecord({ adoptedVersion: "0003" }), files: [] }, {}),
    ).toMatchObject({
      enabled: false,
      reason: "Adopted already, as version 0003.",
    });
    expect(
      adoptState({ dream: dreamRecord(), files: [{ path: "z.md", status: "unchanged" }] }, {}),
    ).toMatchObject({ enabled: false, reason: "This dream changes nothing." });
  });

  it("counts a merge as a side only once it is done, and merges only two versions", () => {
    const model = { agent: "claude", model: "opus" } as const;
    const both = { "c.md": "merged", "gone.md": "output" } as const;
    expect(adoptState({ dream: dreamRecord(), files: withMerge() }, both)).toMatchObject({
      enabled: false,
      reason: "There is no finished merge of c.md: merge again, or choose a side.",
    });
    expect(
      adoptState(
        { dream: dreamRecord(), files: withMerge({ status: "running", model, startedAt: 1 }) },
        both,
      ),
    ).toMatchObject({ enabled: false, reason: "Wait for the merge of c.md, or choose a side." });
    const done = withMerge({ status: "done", model, startedAt: 1, merged: "b\nc\n" });
    expect(adoptState({ dream: dreamRecord(), files: done }, both)).toEqual({
      enabled: true,
      unresolved: [],
    });
    // The merge is what is reviewed once it is chosen and done, against either side.
    expect(diffSides(done[0]!, "current", "merged")).toEqual({ before: "c\n", after: "b\nc\n" });
    expect(diffSides(done[0]!, "baseline", "output")).toEqual({ before: "a\n", after: "b\n" });
    expect(diffSides(withMerge()[0]!, "baseline", "merged")).toEqual({
      before: "a\n",
      after: "b\n",
    });
    // A file one side removed has one version, and one with a merge under way needs no other.
    expect(conflictsToMerge(withMerge())).toEqual(["c.md"]);
    expect(conflictsToMerge(done)).toEqual([]);
    expect(
      conflictsToMerge(withMerge({ status: "failed", model, startedAt: 1, error: "no" })),
    ).toEqual(["c.md"]);
    // Asked again, the finished merge is held back until the review shows the new one running.
    const again = withAskedMerges(done, new Set(["c.md", "gone.md"]), model);
    expect(again[0]!.merge).toMatchObject({ status: "running", model });
    expect(again[1]!.merge).toMatchObject({ status: "running" });
    expect(adoptState({ dream: dreamRecord(), files: again }, both)).toMatchObject({
      enabled: false,
    });
    expect(diffSides(again[0]!, "baseline", "merged")).toEqual({ before: "a\n", after: "b\n" });
    expect(withAskedMerges(done, new Set(), model)).toEqual(done);
    expect(
      ["output", "current", "merged"].map((side) => sideLabel(side as DreamResolution)),
    ).toEqual(["dream's", "current", "merged"]);
  });

  it("orders and sums a review, and picks the sides a diff compares", () => {
    expect(reviewFiles(files).map((f) => f.path)).toEqual(["c.md", "a.md", "b.md", "z.md"]);
    expect(reviewSummary(files)).toBe("1 conflict · 1 changed · 1 added · 1 unchanged");
    expect(reviewSummary([])).toBe("No files");
    expect(diffSides(files[2])).toEqual({ before: "a\n", after: "b\n" });
    expect(diffSides(files[2], "current")).toEqual({ before: "c\n", after: "b\n" });
    // Only a conflict has a "now" that differs from what the dream started from.
    expect(diffSides(files[1], "current")).toEqual({ before: "a\n", after: "b\n" });
  });

  it("says a dream's status, what may be done to it, and why it failed, in words", () => {
    expect(dreamStatus(dreamRecord()).label).toBe("Ready to review");
    expect(dreamStatus(dreamRecord({ adoptedVersion: "0003" })).label).toBe("Adopted as 0003");
    expect(dreamActions(dreamRecord({ status: "running" }))).toEqual({
      review: false,
      cancel: true,
      discard: false,
    });
    expect(dreamActions(dreamRecord())).toEqual({ review: true, cancel: false, discard: true });
    expect(dreamActions(dreamRecord({ status: "failed" }))).toEqual({
      review: false,
      cancel: false,
      discard: true,
    });
    expect(dreamFailureText(dreamRecord({ status: "failed", failure: "input_tampered" }))).toBe(
      "An input file changed while the dream ran, so its output can't be trusted.",
    );
    for (const failure of ["over_caps", "no_output", "agent_error", "canceled"] as const) {
      expect(dreamFailureText(dreamRecord({ status: "failed", failure }))).toMatch(/\.$/);
    }
    expect(dreamFailureText(dreamRecord({ status: "failed" }))).toContain("didn't say why");
    expect(dreamFailureText(dreamRecord())).toBeUndefined();
    // Words a newer server may send read as themselves rather than as nothing.
    type Status = ReturnType<typeof dreamRecord>["status"];
    type Failure = NonNullable<ReturnType<typeof dreamRecord>["failure"]>;
    expect(dreamStatus(dreamRecord({ status: "paused" as Status }))).toEqual({
      label: "paused",
      tone: "muted",
    });
    expect(presentDreamStatus("running")).toEqual({ label: "Running", tone: "working" });
    expect(dreamFailureText(dreamRecord({ status: "failed", failure: "quota" as Failure }))).toBe(
      "The dream failed (quota).",
    );
    expect(presentFileStatus("conflict")).toEqual({ label: "Conflict", tone: "needs" });
    expect(presentFileStatus("renamed")).toEqual({ label: "renamed", tone: "muted" });
    expect(
      reviewFiles([
        { path: "z.md", status: "unchanged" },
        { path: "r.md", status: "renamed" },
        { path: "c.md", status: "conflict" },
      ] as unknown as Parameters<typeof reviewFiles>[0]).map((f) => f.path),
    ).toEqual(["c.md", "r.md", "z.md"]);
    expect(dreamKindLabel(dreamRecord({ kind: "import" }))).toBe("Import");
    expect(dreamKindLabel(dreamRecord())).toBe("Dream");
  });

  it("sums an import preview, and takes only a per-repo limit the server would", () => {
    const source = {
      projectId: "p-api" as ProjectId,
      project: "api",
      agent: "claude" as const,
      cwd: "/r",
      sessions: 30,
      oldest: 100,
      newest: 900,
      estimatedTokens: 552_000,
    };
    expect(
      previewTotals({
        sources: [
          source,
          { ...source, sessions: 9, oldest: 50, newest: 300, estimatedTokens: 82_800 },
        ],
      }),
    ).toEqual({ sessions: 39, estimatedTokens: 634_800, oldest: 50, newest: 900 });
    expect(previewTotals({ sources: [] })).toEqual({
      sessions: 0,
      estimatedTokens: 0,
      oldest: undefined,
      newest: undefined,
    });
    expect([900, 82_800, 1_234_000].map(tokensText)).toEqual([
      "~900 tokens",
      "~83k tokens",
      "~1.2M tokens",
    ]);
    expect(["30", "1", "100", "0", "101", "2.5", "", "many"].map(perRepoOf)).toEqual([
      30,
      1,
      100,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("says what a dream would read, what waits, and when to dream again", () => {
    expect(["200", "20", "2000", "19", "2001", "1.5", "", "lots"].map(budgetOf)).toEqual([
      200_000,
      20_000,
      2_000_000,
      undefined,
      undefined,
      // 1,500 tokens: below the smallest budget.
      undefined,
      undefined,
      undefined,
    ]);
    const plan = {
      memoryVersion: "0007",
      fromStart: false,
      threads: 3,
      messages: 1,
      estimatedTokens: 41_000,
      budgetTokens: 200_000,
      backlog: { threads: 2, messages: 40, estimatedTokens: 80_000 },
    };
    expect(planLines(plan)).toEqual({
      reads:
        "Since the dream you last adopted (memory 0007): 3 threads, 1 new message, ~41k tokens.",
      backlog:
        "Backlog: 2 threads (~80k tokens) past the budget of ~200k tokens, left for the next dream.",
    });
    expect(
      planLines({ ...plan, threads: 0, backlog: { threads: 0, messages: 0, estimatedTokens: 0 } }),
    ).toEqual({
      reads:
        "Since the dream you last adopted (memory 0007): there is nothing new to read; the dream tidies memory alone.",
      backlog: "Backlog: nothing; everything new fits the budget of ~200k tokens.",
    });
    const adopted = pastDream({ adoptedVersion: "0007", backlog: plan.backlog });
    expect(backlogSuggestion([adopted])).toBe(
      "2 threads (~80k tokens) were past the last dream's budget and wait for the next one.",
    );
    expect(backlogSuggestion([pastDream({ status: "running" }), adopted])).toBeUndefined();
    expect(
      backlogSuggestion([adopted, pastDream({ adoptedVersion: "0006", backlog: plan.backlog })]),
    ).toBeDefined();
    expect(backlogSuggestion([pastDream({ adoptedVersion: "0008" }), adopted])).toBeUndefined();
    expect(backlogSuggestion([pastDream({ backlog: plan.backlog })])).toBeUndefined();
  });

  it("starts only the scope whose preview is on screen", () => {
    const preview: ScopedPreview["preview"] = {
      sources: [],
      worktreesCovered: 0,
      worktreesTotal: 0,
      closedThreadsKept: 0,
      notes: [],
    };
    const shownScope = { projectIds: ["p-api" as ProjectId], perRepo: 30 };
    const ready: DreamStartGate = {
      scope: { perRepo: 30, projectIds: ["p-api" as ProjectId] },
      shown: { scope: shownScope, preview },
      placeholder: false,
      fetching: false,
      failed: false,
      busy: false,
      modelMissing: false,
    };
    // The previewed scope itself goes out, not the form's copy of it.
    expect(startableScope(ready)).toBe(shownScope);
    expect(startableScope({ ...ready, scope: {}, shown: { scope: {}, preview } })).toEqual({});

    const off: readonly [string, Partial<DreamStartGate>][] = [
      ["the last scope's preview, kept up while this one's is counted", { placeholder: true }],
      ["a preview being counted again", { fetching: true }],
      ["a preview that failed", { failed: true }],
      ["no preview yet", { shown: undefined }],
      ["options the server would refuse", { scope: undefined }],
      ["a start already on its way", { busy: true }],
      ["a model of one's own not yet picked", { modelMissing: true }],
      [
        "a preview of other options, whatever the query says of itself",
        { scope: { ...ready.scope, perRepo: 100 } },
      ],
      [
        "a preview without the memory folders the form now asks for",
        { scope: { ...ready.scope, includeMemory: true } },
      ],
    ];
    for (const [name, change] of off) {
      expect(startableScope({ ...ready, ...change }), name).toBeUndefined();
    }
  });
});

const taskProject = (id: string, extra: Partial<Project> = {}): Project => ({
  id: id as ProjectId,
  root: `/code/${id}`,
  name: id,
  repoRoot: `/code/${id}`,
  bookmarked: false,
  ...extra,
});

describe("New task's target", () => {
  const api = taskProject("api", { lastOpenedAt: 5 });
  const web = taskProject("web", { lastOpenedAt: 9 });
  const docs = taskProject("docs", { bookmarked: true });
  const notes = taskProject("notes", { lastOpenedAt: 20 });
  const projects = [api, web, docs, notes];
  const across: WorkspaceState = {
    workspace: {
      id: "w-across" as WorkspaceId,
      name: "platform",
      projectIds: [web.id, api.id],
      homeProjectId: api.id,
      createdAt: 0,
    },
    charter: DEFAULT_CHARTER,
  };
  const docsOnly: WorkspaceState = {
    workspace: {
      id: "w-docs" as WorkspaceId,
      name: "docs",
      projectIds: [docs.id],
      homeProjectId: docs.id,
      createdAt: 0,
    },
    charter: DEFAULT_CHARTER,
  };
  const inThread = (extra: Partial<Thread>) => ({ projectId: web.id, ...extra }) as Thread;

  it("offers the repos no workspace has, bookmarked then most recent", () => {
    expect(reposWithoutWorkspace([], projects).map((p) => p.name)).toEqual([
      "docs",
      "notes",
      "web",
      "api",
    ]);
    expect(reposWithoutWorkspace([across], projects).map((p) => p.name)).toEqual(["docs", "notes"]);
  });

  it("takes a repo that has its own workspace by now as that workspace", () => {
    const repo = { kind: "repo", projectId: docs.id } as const;
    expect(settledTaskTarget(repo, [])).toBe(repo);
    // Only a workspace of that repo alone is the one the server would start the task in.
    expect(settledTaskTarget({ kind: "repo", projectId: web.id }, [across])).toEqual({
      kind: "repo",
      projectId: web.id,
    });
    expect(settledTaskTarget(repo, [across, docsOnly])).toEqual({
      kind: "workspace",
      workspaceId: "w-docs",
    });
  });

  it("starts from the current thread's repo: its workspace, one that has it, or the repo", () => {
    const both = [across, docsOnly];
    expect(
      defaultTaskTarget({
        current: inThread({ projectId: api.id, workspaceId: docsOnly.workspace.id }),
        workspaces: both,
        projects,
      }),
    ).toEqual({ kind: "workspace", workspaceId: "w-docs" });
    expect(
      defaultTaskTarget({ current: inThread({ projectId: docs.id }), workspaces: both, projects }),
    ).toEqual({ kind: "workspace", workspaceId: "w-docs" });
    // A repo of a workspace across several.
    expect(
      defaultTaskTarget({ current: inThread({ projectId: web.id }), workspaces: both, projects }),
    ).toEqual({ kind: "workspace", workspaceId: "w-across" });
    // A repo no workspace has wins over the last target and the only workspace.
    const last = { kind: "workspace", workspaceId: docsOnly.workspace.id } as const;
    expect(
      defaultTaskTarget({
        current: inThread({ projectId: notes.id }),
        workspaces: [docsOnly],
        projects,
        last,
      }),
    ).toEqual({ kind: "repo", projectId: "notes" });
    // Also before the projects list has the thread's repo.
    expect(
      defaultTaskTarget({
        current: inThread({ projectId: "fresh" as ProjectId }),
        workspaces: [docsOnly],
        projects,
        last,
      }),
    ).toEqual({ kind: "repo", projectId: "fresh" });
  });

  it("without a thread, starts on the last target, then the only workspace", () => {
    const last = { kind: "workspace", workspaceId: across.workspace.id } as const;
    expect(defaultTaskTarget({ workspaces: [across, docsOnly], projects, last })).toEqual(last);
    // A last target that is gone is passed over.
    expect(
      defaultTaskTarget({
        workspaces: [docsOnly],
        projects,
        last: { kind: "workspace", workspaceId: "w-gone" as WorkspaceId },
      }),
    ).toEqual({ kind: "workspace", workspaceId: "w-docs" });
  });

  it("names a repo to make a workspace for when none fits, and nothing without a repo", () => {
    expect(
      defaultTaskTarget({ current: inThread({ projectId: api.id }), workspaces: [], projects }),
    ).toEqual({
      kind: "repo",
      projectId: "api",
    });
    expect(defaultTaskTarget({ workspaces: [], projects })).toEqual({
      kind: "repo",
      projectId: "docs",
    });
    expect(defaultTaskTarget({ workspaces: [], projects: [] })).toBeUndefined();
  });

  it("lists a worker's repos home first", () => {
    const target = { kind: "workspace", workspaceId: across.workspace.id } as const;
    expect(taskRepos(target, [across], projects).map((p) => p.name)).toEqual(["api", "web"]);
    expect(taskRepos({ kind: "repo", projectId: docs.id }, [], projects)).toEqual([docs]);
  });
});

describe("new workspace sheet", () => {
  const api = "p-api" as ProjectId;
  const web = "p-web" as ProjectId;
  const source: WorkspaceState = {
    workspace: {
      id: "w-shop" as WorkspaceId,
      name: "shop",
      projectIds: [api],
      homeProjectId: api,
      createdAt: 0,
    },
    charter: {
      maxConcurrentWorkers: 3,
      autonomy: "publish",
      workerMode: "acceptEdits",
      orchestratorModel: { agent: "claude", model: "sonnet" },
      workerModels: [{ agent: "claude", model: "haiku", variant: "low", useFor: "docs" }],
    },
  };

  it("copies another workspace's whole charter but none of its repos, and goes back to the defaults", () => {
    const fresh = newWorkspaceCharter({});
    // Untouched, a draft is what a new workspace gets: Opus high orchestrating, and no roster.
    expect(charterOf(emptyNewWorkspace, fresh)).toMatchObject({
      autonomy: "full",
      workerMode: "auto",
      orchestratorModel: DEFAULT_ORCHESTRATOR_MODEL,
    });
    expect(charterOf(emptyNewWorkspace, fresh)).not.toHaveProperty("workerModels");
    const picked = toggleRepo({ ...emptyNewWorkspace, task: "new" }, web, true);
    const copied = startFrom(picked, source);
    expect(charterOf(copied, fresh)).toEqual(source.charter);
    expect(copied).toMatchObject({ task: "new", projectIds: [web], from: "w-shop" });
    const back = startFrom(copied, undefined);
    expect(back.from).toBeUndefined();
    expect(charterOf(back, fresh)).toBe(fresh);
  });

  it("needs only a repository, naming the workspace after its home and past any taken name", () => {
    const projects = [
      { id: api, name: "api", root: "/code/api" },
      { id: web, name: "web", root: "/code/web" },
    ] as unknown as Project[];
    expect(createInput(emptyNewWorkspace, DEFAULT_CHARTER, projects, [])).toEqual({
      error: "Pick at least one repository.",
    });
    const ready = toggleRepo(toggleRepo(emptyNewWorkspace, api, true), web, true);
    expect(ready.homeProjectId).toBe(api);
    expect(createInput(startFrom(ready, source), DEFAULT_CHARTER, projects, [])).toEqual({
      input: { name: "api", projectIds: [api, web], homeProjectId: api, charter: source.charter },
    });
    const taken = (name: string) => ({ ...source, workspace: { ...source.workspace, name } });
    expect(workspaceNameFor(ready, projects, [taken(" API "), taken("api 2")])).toBe("api 3");
    // Removing the home repo hands the role on.
    expect(toggleRepo(ready, api, false)).toMatchObject({ projectIds: [web], homeProjectId: web });
  });

  it("sends what it should work on as the first message, and nothing when it is blank", () => {
    expect(firstMessageOf({ task: "  Add mail triggers \n" })).toBe("Add mail triggers");
    expect(firstMessageOf({ task: " \n " })).toBeUndefined();
  });
});

describe("ongoing process beside merged PRs", () => {
  it("says a merged publisher still waits on its explicit run monitor", () => {
    const publisher = worker("publisher", "release", "merged", {
      runWatches: [{ repo: "example/app", runId: 42, name: "artifact check", since: 1 }],
    });
    expect(workerWait(publisher).detail).toContain("run 42");
  });

  it("reads a worker that reported done as reported done, not finished", () => {
    expect(workerWait(worker("d", "version", "done")).tag).toBe("reported done");
  });

  it("explains holds and dependencies from their recorded owners without requiring a bot in solo policy", () => {
    expect(
      prWait(
        open({
          mergeWhenReady: {
            hold: "independent review",
            holdWaitsOn: "agent",
            heldBy: "orchestrator",
          },
        }),
      ),
    ).toMatchObject({
      bucket: "checks",
      tag: "held",
      detail: "#7 in example/api is held by its orchestrator: independent review",
    });
    expect(
      prWait(open({ verdictOnHead: undefined, botOnHead: undefined, mergeWhenReady: {} })),
    ).toMatchObject({ tag: "merge armed" });
    expect(
      prWait(
        open({
          dependsOn: [{ repo: "example/base", number: 3, state: "open", setBy: "orchestrator" }],
        }),
      ),
    ).toMatchObject({ tag: "dependency" });
    expect(
      prWait(
        open({
          dependsOn: [{ repo: "example/base", number: 3, state: "merged", setBy: "orchestrator" }],
        }),
      ).tag,
    ).not.toBe("dependency");
  });

  it("keeps active PR blockers primary beside both run monitors and scheduled wakes", () => {
    const monitoring = {
      runWatches: [{ repo: "example/app", runId: 42, name: "artifact check", since: 1 }],
      wakes: [{ id: "wake", at: 10, note: "verify release" }],
    };
    const cases: ReadonlyArray<[WorkerPr, string, string, string]> = [
      [
        open({
          reviewDecision: "REVIEW_REQUIRED",
          reviewRequests: [{ kind: "user", name: "mona" }],
        }),
        "person",
        "@mona review",
        "review from @mona",
      ],
      [open({ mergeState: "DIRTY" }), "checks", "conflicts", "worker needs to resolve"],
      [open({ checks: "failing", monitored: true }), "checks", "CI failing", "inspect and fix"],
      [
        open({
          mergeWhenReady: {
            hold: "independent review",
            heldBy: "orchestrator",
            holdWaitsOn: "agent",
          },
        }),
        "checks",
        "held",
        "held by its orchestrator",
      ],
      [
        open({
          dependsOn: [{ repo: "example/base", number: 3, state: "open", setBy: "orchestrator" }],
        }),
        "checks",
        "dependency",
        "example/base#3",
      ],
    ];
    for (const [pullRequest, bucket, waitTag, reason] of cases) {
      const waiting = ledgerRow("inReview", { pr: pullRequest, ...monitoring });
      const shown = workerWait(waiting);
      expect(shown).toMatchObject({ bucket, tag: waitTag });
      expect(shown.detail).toContain(reason);
      expect(shown.detail).toContain("example/app run 42 (artifact check)");
      expect(shown.detail).toContain("scheduled wake");
      expect(workerWait({ ...waiting, runWatches: [] })).toMatchObject({ bucket, tag: waitTag });
      expect(workerWait({ ...waiting, wakes: [] })).toMatchObject({ bucket, tag: waitTag });
    }
  });

  it("does not infer an open wait from a settled worker's PR identity, but honors an observed active blocker", () => {
    const identity = { repo: "example/app", number: 42 };
    const monitoring = { runWatches: [{ repo: "example/app", runId: 42, since: 1 }] };
    for (const state of ["merged", "delivered"] as const) {
      expect(workerWait(ledgerRow(state, { pr: identity }))).toMatchObject({
        bucket: "done",
        tag: state,
      });
      expect(workerWait(ledgerRow(state, { pr: identity, ...monitoring }))).toMatchObject({
        bucket: "checks",
        tag: "run monitored",
      });
      expect(
        workerWait(
          ledgerRow(state, {
            pr: {
              ...identity,
              state: "open",
              reviewDecision: "REVIEW_REQUIRED",
              reviewRequests: [{ kind: "user", name: "mona" }],
            },
            ...monitoring,
          }),
        ),
      ).toMatchObject({ bucket: "person", tag: "@mona review" });
    }
    expect(workerWait(ledgerRow("inReview", { pr: identity }))).toMatchObject({
      bucket: "checks",
      tag: "checking",
    });
  });

  it("retains a live user question even after the PR merged", () => {
    const publisher = worker("p", "release", "merged", {
      reportStands: true,
      lastReport: {
        threadId: "p" as ThreadId,
        state: "question",
        summary: "Which channel?",
        at: 1,
      },
    });
    expect(workerWait(publisher)).toMatchObject({ bucket: "person", tag: "question" });
  });
});
