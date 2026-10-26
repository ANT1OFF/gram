import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { ReportWindowPayload, WatchWindowsPayload, WindowPlacements } from "../app-windows.ts";
import { Diagnostics, DIAGNOSTICS_MAX_LOG_LINES, DiagnosticsReport } from "../diagnostics.ts";
import { GitError, InvalidState } from "../errors.ts";
import { ServerEvent } from "../events.ts";
import { ComposedIssue, FiledIssue, IssueDraft } from "../issues.ts";
import { LaunchChecks } from "../launch-checks.ts";
import { SelectedHarnessSupport } from "../agent-support.ts";
import { ModelRef } from "../domain.ts";
import { ThreadId } from "../ids.ts";
import { OpenExternalPayload } from "../ports.ts";
import { PositiveInt, errors } from "./shared.ts";
import { UsageOverview, UsageOverviewQuery } from "../usage-overview.ts";

/**
 * The app itself: its event feed, windows, usage, diagnostics and launch checks, and filing issues.
 */
export const AppRpcs = RpcGroup.make(
  Rpc.make("app.usageOverview", {
    payload: UsageOverviewQuery,
    success: UsageOverview,
    error: errors(InvalidState),
  }),
  /** Read-only selected-harness observations; never discovers models or refreshes account tokens. */
  Rpc.make("agents.support", {
    payload: {
      model: ModelRef,
      threadId: Schema.optionalKey(ThreadId),
      refresh: Schema.optionalKey(Schema.Boolean),
    },
    success: SelectedHarnessSupport,
    error: errors(),
  }),
  Rpc.make("app.diagnostics", { success: Diagnostics, error: errors() }),
  Rpc.make("app.diagnosticsReport", {
    /** Recent lines per log file; 200 when absent. */
    payload: {
      logLines: Schema.optionalKey(
        PositiveInt.check(Schema.isLessThanOrEqualTo(DIAGNOSTICS_MAX_LOG_LINES)),
      ),
    },
    success: DiagnosticsReport,
    error: errors(),
  }),
  /** Opens the logs folder in the OS file manager; `InvalidState` when it can't be opened. */
  Rpc.make("app.openLogsFolder", { error: errors(InvalidState) }),
  Rpc.make("app.openExternal", { payload: OpenExternalPayload, error: errors(InvalidState) }),
  /** What `issues.file` would post for `draft` on Gram's repo, footer and all. Local only. */
  Rpc.make("issues.preview", { payload: IssueDraft, success: ComposedIssue, error: errors() }),
  /**
   * Files the issue on Gram's repo through the user's `gh`; `GitError` when gh can't (no
   * login, no access), for the form to offer `ComposedIssue.newIssueUrl` instead.
   */
  Rpc.make("issues.file", { payload: IssueDraft, success: FiledIssue, error: errors(GitError) }),
  /** Cached after the first run; `refresh` checks again. */
  Rpc.make("app.launchChecks", {
    payload: { refresh: Schema.optionalKey(Schema.Boolean) },
    success: LaunchChecks,
    error: errors(),
  }),
  // Global event feed
  Rpc.make("events.subscribe", { success: ServerEvent, error: errors(), stream: true }),
  // Windows
  /**
   * Registers this window for as long as the stream is open and emits every window's placement,
   * now and on each change. Closing the window (or its socket) forgets it.
   */
  Rpc.make("windows.watch", {
    payload: WatchWindowsPayload,
    success: WindowPlacements,
    error: errors(),
    stream: true,
  }),
  /** The threads a watching window's panes show now. */
  Rpc.make("windows.report", { payload: ReportWindowPayload, error: errors() }),
);
