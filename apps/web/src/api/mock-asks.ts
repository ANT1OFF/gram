import type {
  PendingRequest,
  Project,
  RequestAnswer,
  RequestId,
  Thread,
  ThreadId,
  WorkspaceId,
  WorkspaceState,
} from "@gram/contracts";

import type { MockBoardSimulation } from "./mock-orchestration";
import type { MockWorkersSimulation } from "./mock-workers";
import type { CreateThreadInput, OpenOrchestratorTarget, SaveWorkspaceInput } from "./types";

// The ask stack's scenario: the board's workspace with one ask of each shape, and one more ask in
// a second workspace. Synthetic; nothing here reaches a provider.

/** What `simulateAsks` made, for a spec to navigate by. */
export interface MockAsksSimulation extends MockBoardSimulation {
  /** The three workers whose `git push` is one ask. */
  readonly pushers: readonly [ThreadId, ThreadId, ThreadId];
  /** The worker whose question has options (the board's docs-refresh). */
  readonly choosing: ThreadId;
  /** The worker whose question wants words, and the request it waits on. */
  readonly freeForm: { readonly threadId: ThreadId; readonly requestId: RequestId };
  /** The helper's replies `requestReplies` gives for `freeForm` while helpers are on. */
  readonly replies: readonly string[];
  /** The second workspace, its orchestrator, and its one ask. */
  readonly other: {
    readonly workspaceId: WorkspaceId;
    readonly orchestratorThreadId: ThreadId;
    readonly asking: ThreadId;
  };
}

/** What `simulateFailures` made: the ask scenario, and its two failures. */
export interface MockFailuresSimulation extends MockAsksSimulation {
  /** The board's working worker, stopped on a spending limit. */
  readonly stopped: ThreadId;
  /** The in-review worker, its PR's checks failing. */
  readonly failing: ThreadId;
}

/** What `simulateOneThread` made: the ⌘J scenario's workers, and the ask stack's asks beside them. */
export interface MockOneThreadSimulation extends MockWorkersSimulation {
  readonly asks: MockAsksSimulation;
}

/** What the seed needs of the mock. */
export interface MockAsksHost {
  readonly board: () => Promise<MockBoardSimulation>;
  readonly projects: () => readonly Project[];
  readonly respond: (
    threadId: ThreadId,
    requestId: RequestId,
    answer: RequestAnswer,
  ) => Promise<void>;
  readonly request: (threadId: ThreadId, request: PendingRequest) => void;
  readonly armReplies: (requestId: RequestId, replies: readonly string[]) => void;
  readonly createThread: (input: CreateThreadInput) => Promise<Thread>;
  readonly updateThread: (threadId: ThreadId, patch: Partial<Thread>) => void;
  readonly saveWorkspace: (input: SaveWorkspaceInput) => Promise<WorkspaceState>;
  readonly openOrchestrator: (target: OpenOrchestratorTarget) => Promise<Thread>;
}

const PUSH = "git push -u origin feat/mail-trigger";
export const ASK_REPLIES = ["Say no packages yet", "Link to the publish guide", "Leave it blank"];

const push = (id: string): PendingRequest => ({
  kind: "approval",
  id: id as RequestId,
  toolName: "Bash",
  displayName: "Bash",
  input: { command: PUSH },
  description: "Publish the branch so the pull request can be opened.",
  suggestions: [],
  scopes: ["once"],
});

export async function seedAsks(host: MockAsksHost): Promise<MockAsksSimulation> {
  const board = await host.board();
  const [web, docs] = board.waiting;
  // The board keeps the rate limit's push apart (another `timeout`); here it asks again with the
  // same input, so all three are one ask.
  await host.respond(board.waitingApart, `r-push-${board.waitingApart}` as RequestId, {
    kind: "approval",
    decision: "deny",
    scope: "once",
  });
  host.request(board.waitingApart, push(`r-push-again-${board.waitingApart}`));

  const freeForm = {
    kind: "question",
    id: `r-free-${board.briefed}` as RequestId,
    toolUseId: `toolu_free_${board.briefed}`,
    questions: [
      {
        question: "What should the registry page say when it has no packages?",
        header: "Empty state",
        multiSelect: false,
        options: [],
      },
    ],
  } satisfies PendingRequest;
  host.armReplies(freeForm.id, ASK_REPLIES);
  host.request(board.briefed, freeForm);

  const projects = host.projects();
  const home = projects[0];
  if (home === undefined) throw new Error("The mock has no projects.");
  const billing = await host.saveWorkspace({
    name: "billing",
    projectIds: [home.id],
    homeProjectId: home.id,
  });
  const orchestrator = await host.openOrchestrator({ workspaceId: billing.workspace.id });
  const created = await host.createThread({
    projectRoot: home.root,
    checkout: { kind: "current" },
    title: "Export invoices as CSV",
  });
  host.updateThread(created.id, {
    workspaceId: billing.workspace.id,
    spawnedBy: { threadId: orchestrator.id, feature: "invoice-export" },
  });
  host.request(created.id, {
    kind: "approval",
    id: `r-merge-${created.id}` as RequestId,
    toolName: "Bash",
    displayName: "Bash",
    input: { command: "gh pr merge 91 --squash" },
    description: "Merge the export once its checks pass.",
    suggestions: [],
    scopes: ["once"],
  });

  return {
    ...board,
    pushers: [web, docs, board.waitingApart],
    choosing: board.ungrouped,
    freeForm: { threadId: board.briefed, requestId: freeForm.id },
    replies: ASK_REPLIES,
    other: {
      workspaceId: billing.workspace.id,
      orchestratorThreadId: orchestrator.id,
      asking: created.id,
    },
  };
}
