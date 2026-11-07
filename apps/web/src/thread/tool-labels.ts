import type { ToolPhase } from "./parts";

// What a tool row calls a call: a few plain words, never the raw id an MCP server gives its tools
// (`mcp__gram__merge_when_ready`), which the row's details still show. Pure, so the words are
// tested without a browser.

/** A verb for a call in flight and one for a call that finished, as the row's state reads it. */
type Verbs = readonly [doing: string, done: string];

/**
 * Gram's own app tools, by their bare names, in words that claim no more than the call does:
 * `merge_when_ready` queues a merge that happens once the policy and checks allow, so it reads
 * "Queued to merge when ready", not "Merged".
 */
const GRAM_TOOLS: Readonly<Record<string, Verbs>> = {
  spawn_worker: ["Starting a worker", "Started a worker"],
  merge_when_ready: ["Queuing a merge when ready", "Queued to merge when ready"],
  pr_status: ["Checking the pull request", "Checked the pull request"],
  pr_review_monitor: ["Watching the pull request", "Watching the pull request"],
  pr_monitor: ["Watching the pull request", "Watching the pull request"],
  pr_bind: ["Linking the pull request", "Linked the pull request"],
  pr_unbind: ["Unlinking the pull request", "Unlinked the pull request"],
  pr_review_threads: ["Reading review threads", "Read review threads"],
  pr_reply_to_thread: ["Replying to a review thread", "Replied to a review thread"],
  pr_resolve_thread: ["Resolving a review thread", "Resolved a review thread"],
  pr_request_rereview: ["Requesting a review", "Requested a review"],
  set_auto_merge: ["Setting auto-merge", "Set auto-merge"],
  local_check: ["Running the local check", "Ran the local check"],
  run_monitor: ["Watching a workflow run", "Watching a workflow run"],
  depends_on: ["Recording a dependency", "Recorded a dependency"],
  merge_freeze: ["Changing the merge freeze", "Changed the merge freeze"],
  send_message: ["Sending a message", "Sent a message"],
  message_orchestrator: ["Messaging the orchestrator", "Messaged the orchestrator"],
  broadcast_message: ["Messaging the workers", "Messaged the workers"],
  report: ["Reporting", "Reported"],
  ask_question: ["Asking you", "Asked you"],
  stop_thread: ["Stopping a thread", "Stopped a thread"],
  archive_thread: ["Archiving a thread", "Archived a thread"],
  restart_session: ["Restarting a session", "Restarted a session"],
  set_thread_model: ["Changing a thread's model", "Changed a thread's model"],
  set_thread_effort: ["Changing a thread's effort", "Changed a thread's effort"],
  list_threads: ["Listing threads", "Listed threads"],
  list_workers: ["Listing workers", "Listed workers"],
  get_thread: ["Reading a thread", "Read a thread"],
  search_threads: ["Searching threads", "Searched threads"],
  list_events: ["Reading events", "Read events"],
  list_open_prs: ["Listing pull requests", "Listed pull requests"],
  list_review_requests: ["Listing review requests", "Listed review requests"],
  git_state: ["Reading git state", "Read git state"],
  turn_diff: ["Reading a turn's diff", "Read a turn's diff"],
  list_checkpoints: ["Listing checkpoints", "Listed checkpoints"],
  schedule_wake: ["Scheduling a wake", "Scheduled a wake"],
  cancel_wake: ["Cancelling a wake", "Cancelled a wake"],
  set_title: ["Naming the thread", "Named the thread"],
  set_plan: ["Updating the plan", "Updated the plan"],
  mark_chapter: ["Marking a chapter", "Marked a chapter"],
  mark_completed: ["Marking it done", "Marked it done"],
  set_unread: ["Marking it unread", "Marked it unread"],
  notify_user: ["Notifying you", "Notified you"],
  wait_on_user: ["Adding to Waiting on you", "Added to Waiting on you"],
  resolve_wait: ["Clearing a wait", "Cleared a wait"],
  list_waits: ["Listing waits", "Listed waits"],
  spawn_task: ["Offering a task", "Offered a task"],
  dismiss_task: ["Withdrawing a task", "Withdrew a task"],
  wrap_up: ["Writing the recap", "Wrote the recap"],
  show_widget: ["Drawing a widget", "Drew a widget"],
  show_panel: ["Opening a panel", "Opened a panel"],
  show_mock: ["Showing a mock", "Showed a mock"],
  publish_doc: ["Publishing a doc", "Published a doc"],
  read_doc: ["Reading docs", "Read docs"],
  send_file: ["Sending a file", "Sent a file"],
  read_terminal: ["Reading a terminal", "Read a terminal"],
  read_app_logs: ["Reading app logs", "Read app logs"],
  report_issue: ["Reporting an issue", "Reported an issue"],
  search_issues: ["Searching issues", "Searched issues"],
  move_to_worktree: ["Moving to a worktree", "Moved to a worktree"],
  restore_worktree: ["Restoring a worktree", "Restored a worktree"],
  request_directory: ["Asking for a folder", "Asked for a folder"],
  connectors_status: ["Checking connectors", "Checked connectors"],
  reconnect_connector: ["Reconnecting a connector", "Reconnected a connector"],
  set_connector_enabled: ["Changing a connector", "Changed a connector"],
  settings_read: ["Reading settings", "Read settings"],
};

/** Claude Code's own tools that reach a generic row, in words. */
const BUILT_IN: Readonly<Record<string, Verbs>> = {
  TodoWrite: ["Updating the to-do list", "Updated the to-do list"],
  ToolSearch: ["Looking up tools", "Looked up tools"],
  Skill: ["Using a skill", "Used a skill"],
  ExitPlanMode: ["Presenting the plan", "Presented the plan"],
  AskUserQuestion: ["Asking you", "Asked you"],
};

const MCP = /^mcp__(.+?)__(.+)$/;

/** "list_issues" → "List issues"; "getIssue" → "Get issue". */
const words = (name: string): string => {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return spaced === "" ? name : spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

/** A finished call reads in the past tense; everything else, a call still to settle, in the present. */
const settled = (phase: ToolPhase) =>
  phase === "done" || phase === "error" || phase === "denied" || phase === "cancelled";

/** The words for a call, and, when they differ from it, the raw tool id that the details show. */
export interface ToolLabel {
  readonly label: string;
  /** The tool's own id; `undefined` when the label is that id already. */
  readonly raw: string | undefined;
}

/**
 * The row's words for `tool` in `phase`: an agent's own title wins, then Gram's verbs for its own
 * tools and Claude Code's, then another MCP server's tool in words with its server named. A built-in
 * tool with no verbs here keeps its name (`Bash`, `Read`), which reads as a word already.
 */
export function toolLabel(tool: string, phase: ToolPhase, title?: string): ToolLabel {
  const raw = (label: string): ToolLabel => ({ label, raw: label === tool ? undefined : tool });
  if (title !== undefined && title.trim() !== "") return raw(title);
  const done = settled(phase) ? 1 : 0;
  const mcp = MCP.exec(tool);
  if (mcp === null) {
    const verbs = BUILT_IN[tool];
    return raw(verbs === undefined ? tool : verbs[done]);
  }
  const [, server, name] = mcp as unknown as [string, string, string];
  if (server === "gram") {
    const verbs = GRAM_TOOLS[name];
    // A browser tool says what it does in its own row detail; its verb is the action.
    return raw(verbs === undefined ? words(name.replace(/^browser_/, "Browser ")) : verbs[done]);
  }
  return raw(`${words(name)} · ${server.replace(/^claude_ai_/, "").replaceAll("_", " ")}`);
}
