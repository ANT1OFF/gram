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
import { LimitHistoryQuery, UsageLimitHistory } from "../usage-limit-history.ts";

/**
 * This machine's host kept running after Gram quits (`agents.keepRunningAfterQuit`), as it stands
 * this run.
 */
export const KeptHostStatus = Schema.Struct({
  /** Whether this machine can keep it: macOS or Linux, and a Gram that runs work here. */
  available: Schema.Boolean,
  /** The setting, which takes effect when Gram next starts. */
  on: Schema.Boolean,
  /** Whether this run's host is that service, which outlives Gram. */
  running: Schema.Boolean,
  /** The service's name: its systemd user unit, or its launchd label. */
  service: Schema.optionalKey(Schema.String),
  /** Agent sessions it holds for this Gram's threads, which go on after a quit. */
  sessions: Schema.Int,
  /** Why it was asked for and couldn't be had this run. */
  problem: Schema.optionalKey(Schema.String),
});
export type KeptHostStatus = typeof KeptHostStatus.Type;

/**
 * What a server says of itself to a client that may be built from another commit: an embedding
 * app ships the web at one commit and its server at another. `rpcs` is every tag it serves; a
 * client calls nothing outside it.
 */
export const ServerHandshake = Schema.Struct({
  /** Gram's version, as `app.diagnostics` has it. */
  version: Schema.String,
  /** The commit it was built from, where it knows it. */
  build: Schema.optionalKey(Schema.String),
  rpcs: Schema.Array(Schema.String),
});
export type ServerHandshake = typeof ServerHandshake.Type;

/**
 * The app itself: its event feed, windows, usage, diagnostics and launch checks, and filing issues.
 */
export const AppRpcs = RpcGroup.make(
  Rpc.make("app.usageOverview", {
    payload: UsageOverviewQuery,
    success: UsageOverview,
    error: errors(InvalidState),
  }),
  Rpc.make("app.usageLimitHistory", {
    payload: LimitHistoryQuery,
    success: UsageLimitHistory,
    error: errors(),
  }),
  Rpc.make("agents.support", {
    payload: {
      model: ModelRef,
      threadId: Schema.optionalKey(ThreadId),
      refresh: Schema.optionalKey(Schema.Boolean),
    },
    success: SelectedHarnessSupport,
    error: errors(),
  }),
  Rpc.make("app.handshake", { success: ServerHandshake, error: errors() }),
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
  Rpc.make("app.keptHost", { success: KeptHostStatus, error: errors() }),
  Rpc.make("app.keptHostStop", { error: errors(InvalidState) }),
  Rpc.make("app.openLogsFolder", { error: errors(InvalidState) }),
  Rpc.make("app.openExternal", { payload: OpenExternalPayload, error: errors(InvalidState) }),
  Rpc.make("issues.preview", { payload: IssueDraft, success: ComposedIssue, error: errors() }),
  Rpc.make("issues.file", { payload: IssueDraft, success: FiledIssue, error: errors(GitError) }),
  Rpc.make("app.launchChecks", {
    payload: { refresh: Schema.optionalKey(Schema.Boolean) },
    success: LaunchChecks,
    error: errors(),
  }),
  Rpc.make("events.subscribe", { success: ServerEvent, error: errors(), stream: true }),
  Rpc.make("windows.watch", {
    payload: WatchWindowsPayload,
    success: WindowPlacements,
    error: errors(),
    stream: true,
  }),
  Rpc.make("windows.report", { payload: ReportWindowPayload, error: errors() }),
);
