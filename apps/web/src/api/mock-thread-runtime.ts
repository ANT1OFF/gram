import type { MockCore } from "./mock";
import type {
  CompactionActivity,
  ThreadPlan,
  AgentCapabilities,
  BackgroundTask,
  AgentKind,
  ModelRef,
  PendingRequest,
  Project,
  RequestAnswer,
  GramUIMessage,
  Thread,
  ThreadFeedEvent,
  ThreadId,
  ThreadIdentity,
  ThreadSummary,
  UserInput,
} from "@gram/contracts";
import type { ThreadFeed } from "@/stores/thread-feed";
import type { Channel } from "./channel";
import type { createMockOrchestration } from "./mock-orchestration";
import type { createMockDreams } from "./mock-dreams";
import type { createComposerMock } from "./composer/mock";
import type { createProfilesMock } from "./profiles/mock";
import type { createProjectsMock } from "./projects/mock";
import type { createPullRequestsMock } from "./pull-requests/mock";
import type { createReviewRequestsMock } from "./review-requests/mock";
import type { ApiServerEvent, ApiThreadFeedEvent } from "./types";

// What MockCore and its scenario files share: a thread's runtime, the seeded identity and
// capabilities, and the handle the scenarios reach the core through.

/** A feed event as the mock's turns make it; `#feed` stamps the revisions the server would. */
export type MockFeedEvent =
  | Extract<ThreadFeedEvent, { type: "chunk" | "messages" }>
  | { readonly type: "message"; readonly message: GramUIMessage };

export interface ThreadRuntime {
  summary: ThreadSummary;
  /** The mock's own fold of everything it has emitted; the source for replays. */
  fold: ThreadFeed;
  /** Chunks of messages still streaming, replayed from the first chunk on subscribe. */
  inflight: Map<string, ThreadFeedEvent[]>;
  /** When each subagent run's first snapshot went out, stamped on every later one like the adapter. */
  subagentStarts: Map<string, number>;
  subscribers: Set<Channel<ApiThreadFeedEvent>>;
  /** The feed revision each message was last written at, as the server's rows keep it. */
  revs: Map<string, number>;
  /** The revision the history was last replaced at, before which nothing resumes. */
  resetRev: number;
  running: boolean;
  steer: UserInput | undefined;
  interrupted: boolean;
  /** `restartSession` came mid-turn: the session restarts once the turn ends. */
  restartAfterTurn: boolean;
}

/** What each agent's session reports it runs, as the real adapters list them. */
const COMMANDS: Partial<Record<AgentKind, ThreadIdentity["commands"]>> = {
  claude: [
    { name: "compact", description: "Free up context by summarizing the conversation so far" },
    { name: "context", description: "Show current context usage" },
    { name: "init", description: "Initialize a new CLAUDE.md file with codebase documentation" },
    { name: "code-review", description: "Review the current diff, or a PR, for correctness bugs" },
    { name: "pr-comments", description: "Fetch comments from the open PR" },
    { name: "usage", description: "Show session cost, plan usage and limits", aliases: ["cost"] },
  ],
  codex: [
    { name: "compact", description: "Summarize the conversation to free up context" },
    { name: "release-notes", description: "Draft release notes from the merged PRs" },
    { name: "skill-creator", description: "Create or update a Codex skill" },
  ],
  grok: [],
};

export const identityFor = (model: ModelRef): ThreadIdentity => ({
  model: model.model,
  commands: COMMANDS[model.agent] ?? [],
});

/** The seeded threads' identity: they all run Claude on opus. */
export const IDENTITY = identityFor({ agent: "claude", model: "opus" });

/** The scripted agent forks; it rewinds history only, like a real thread before its capabilities arrive. */
export const MOCK_CAPABILITIES: AgentCapabilities = {
  fork: true,
  rewind: "history",
  steer: true,
  planMode: true,
  approvalScopes: ["once", "session", "always"],
  userQuestions: true,
  costReporting: true,
  perTurnModel: true,
  reasoningEffort: true,
  listSessions: false,
  subagentStreams: true,
  stopTasks: true,
};

/**
 * What the scenario and seed files (`mock-seeds.ts`, `mock-thread-sims.ts`, `mock-scenarios.ts`)
 * reach of MockCore: its threads and the private steps that change them, the domain mocks it owns,
 * and `mock`, the core itself, for its public hooks.
 */
export interface MockCoreScenes {
  readonly mock: MockCore;
  readonly threads: Map<string, ThreadRuntime>;
  /** The seeded projects now; adding a folder replaces the list. */
  readonly projects: () => readonly Project[];
  /** The feed revision now. */
  readonly rev: () => number;
  /** The next of the mock's sequence numbers, for ids. */
  readonly nextSeq: () => number;
  readonly ids: () => string;
  /** The perf seeds' timers, cleared by `stopBusyThreads`. */
  readonly busy: ReturnType<typeof setInterval>[];
  readonly missingFolders: Map<string, { branchGone?: { repo: string; number: number } }>;
  readonly runtime: (threadId: string) => ThreadRuntime;
  readonly add: (summary: ThreadSummary) => ThreadRuntime;
  readonly emit: (event: ApiServerEvent) => void;
  readonly feed: (runtime: ThreadRuntime, event: MockFeedEvent) => void;
  readonly update: (runtime: ThreadRuntime, patch: Partial<Thread>) => void;
  readonly setStatus: (
    runtime: ThreadRuntime,
    status: ThreadSummary["status"],
    detail?: string,
    compaction?: CompactionActivity,
  ) => void;
  readonly setPlans: (
    runtime: ThreadRuntime,
    patch: {
      readonly plan?: ThreadPlan | undefined;
      readonly turnPlan?: ThreadSummary["turnPlan"] | undefined;
    },
  ) => void;
  readonly setQueue: (runtime: ThreadRuntime, queue: ThreadSummary["queue"]) => void;
  readonly setBackground: (runtime: ThreadRuntime, tasks: readonly BackgroundTask[]) => void;
  readonly putMessage: (runtime: ThreadRuntime, message: GramUIMessage) => void;
  readonly abortInflight: (runtime: ThreadRuntime) => void;
  readonly replaceThread: (edited: Thread) => void;
  readonly ask: (
    threadId: ThreadId,
    request: PendingRequest,
    onAnswer: (answer: RequestAnswer) => void,
  ) => void;
  readonly orchestration: ReturnType<typeof createMockOrchestration>;
  readonly dreams: ReturnType<typeof createMockDreams>;
  readonly composer: ReturnType<typeof createComposerMock>;
  readonly profiles: ReturnType<typeof createProfilesMock>;
  readonly projectsMock: ReturnType<typeof createProjectsMock>;
  readonly pullRequests: ReturnType<typeof createPullRequestsMock>;
  readonly reviewRequests: ReturnType<typeof createReviewRequestsMock>;
}
