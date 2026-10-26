import * as Schema from "effect/Schema";
import { AgentCapabilities, SlashCommand } from "./agent.ts";
import {
  BackgroundOutput,
  BackgroundTask,
  PendingRequest,
  PlanItem,
  Thread,
  UsageSummary,
  UserInput,
} from "./domain.ts";
import { GitState } from "./git.ts";
import { QueueItemId, TurnId } from "./ids.ts";
import { ListeningPorts, TerminalProcess } from "./ports.ts";
import { ThreadPlan } from "./thread-plan.ts";
import { CompactionActivity, ThreadStatus } from "./thread-status.ts";
import { SessionRestartReason } from "./ui-message.ts";
import { WaitItem } from "./waits.ts";

export const QueuedInput = Schema.Struct({
  id: QueueItemId,
  input: UserInput,
  /**
   * The key a server notice was queued under (`sendNotice`), kept with it in the store so a restart
   * still knows it isn't the user's own word: a hold holds it, and a newer notice replaces it.
   */
  noticeKey: Schema.optionalKey(Schema.String),
  /**
   * Set once it is on its way to the agent: the turn that carries it. The item stays in the store
   * until the agent has taken it, so a restart in between sends it again, as the same message (the
   * item's id) and, unless the restart closed that turn, in the same turn.
   */
  turnId: Schema.optionalKey(TurnId),
});
export type QueuedInput = typeof QueuedInput.Type;

/** The live agent session's model and slash commands; refreshed on each `system/init`. */
export const ThreadIdentity = Schema.Struct({
  model: Schema.String,
  commands: Schema.Array(SlashCommand),
});
export type ThreadIdentity = typeof ThreadIdentity.Type;

/** A thread plus its live runtime state, as the sidebar needs it. */
export const ThreadSummary = Schema.Struct({
  thread: Thread,
  status: ThreadStatus,
  pendingRequests: Schema.Array(PendingRequest),
  queue: Schema.Array(QueuedInput),
  capabilities: Schema.optionalKey(AgentCapabilities),
  /** Absent until the agent session has started. */
  identity: Schema.optionalKey(ThreadIdentity),
  /** Latest context tokens and window, plus cumulative cost; absent before the first turn. */
  usage: Schema.optionalKey(UsageSummary),
  git: Schema.optionalKey(GitState),
  /** Absent while nothing in the thread's process trees listens. */
  ports: Schema.optionalKey(ListeningPorts),
  /** Live activity line ("Running pnpm test…"). */
  activity: Schema.optionalKey(Schema.String),
  /** The compaction under way, while the agent compacts its context. */
  compaction: Schema.optionalKey(CompactionActivity),
  /** Absent while the agent has nothing running in the background. */
  background: Schema.optionalKey(Schema.Array(BackgroundTask)),
  /**
   * The latest output tail of each background shell still running that has written any, as
   * `thread.backgroundOutput` sent it; absent while there is none.
   */
  backgroundOutput: Schema.optionalKey(Schema.Array(BackgroundOutput)),
  /**
   * Why the session restarts on its own once it is idle, with no turn, queue or background task;
   * absent when it won't.
   */
  pendingRestart: Schema.optionalKey(SessionRestartReason),
  /** Absent while none of the thread's terminals runs anything but its shell. */
  terminalProcesses: Schema.optionalKey(Schema.Array(TerminalProcess)),
  /** The thread's plan across turns and PRs; absent until the agent, the user or the helper writes one. */
  plan: Schema.optionalKey(ThreadPlan),
  /**
   * The claude.ai connectors the live session had working and now needs signing in to again;
   * absent while there are none, and once the session ends.
   */
  lapsedConnectors: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The agent's latest todo list (`thread.plan`'s `items`); absent until it keeps one. */
  turnPlan: Schema.optionalKey(Schema.Array(PlanItem)),
  /** What waits on the user here, open items only, oldest first; absent while nothing does. */
  waits: Schema.optionalKey(Schema.Array(WaitItem)),
  /**
   * Items the helper resolved within `HELPER_RESOLVE_UNDO_MS`, newest first, for the tray's Undo;
   * absent while there are none.
   */
  helperResolved: Schema.optionalKey(Schema.Array(WaitItem)),
});
export type ThreadSummary = typeof ThreadSummary.Type;
