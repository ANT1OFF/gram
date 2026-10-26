import type {
  ComposedIssue,
  Diagnostics,
  DiagnosticsReport,
  FiledIssue,
  IssueDraft,
  LaunchChecks,
  ThreadId,
  WindowPlacements,
  UsageOverview,
  UsageOverviewQuery,
} from "@gram/contracts";

/** The app itself: its windows, diagnostics and launch checks, and issues. */
export interface AppApi {
  usageOverview(query: UsageOverviewQuery): Promise<UsageOverview>;
  /**
   * Registers this window while the iterable is open and yields every window's placement, now and on
   * each change. After a reconnect the server has forgotten the window's threads: report them again.
   */
  watchWindows(
    window: { windowId: string; name: string },
    signal: AbortSignal,
  ): AsyncIterable<WindowPlacements>;
  /**
   * The threads this window's panes show now, and whether anyone is looking at it — the server
   * stops polling GitHub for windows nobody can see, and refreshes the thread in the focused pane
   * (`null` for an empty one) as the user moves to it.
   */
  reportWindow(
    windowId: string,
    threadIds: readonly ThreadId[],
    state?: {
      readonly visible?: boolean;
      readonly focused?: boolean;
      readonly focusedThreadId?: ThreadId | null;
    },
  ): Promise<void>;
  /** Version, platform, data folder and thread counts. */
  diagnostics(): Promise<Diagnostics>;
  /** The "Copy diagnostics" text with secrets removed; `logLines` per log file, 200 by default. */
  diagnosticsReport(logLines?: number): Promise<DiagnosticsReport>;
  /** Shows the logs folder in the OS file manager. Rejects with `InvalidState` when it can't. */
  openLogsFolder(): Promise<void>;
  /** Whether `claude`, `git` and `gh` are installed and signed in; cached unless `refresh`. */
  launchChecks(refresh?: boolean): Promise<LaunchChecks>;
  /** What `fileIssue` would post for `draft` on Gram's repo, diagnostics footer included. */
  previewIssue(draft: IssueDraft): Promise<ComposedIssue>;
  /**
   * Files the issue on Gram's repo through the user's `gh`. Rejects with `GitError` when gh
   * can't (not signed in, no access), for the caller to offer the preview's `newIssueUrl` instead.
   */
  fileIssue(draft: IssueDraft): Promise<FiledIssue>;
  /** Opens an http(s) URL in the default browser of the server's machine; `InvalidState` otherwise. */
  openExternal(url: string): Promise<void>;
}
