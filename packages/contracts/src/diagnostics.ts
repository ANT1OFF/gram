import * as Schema from "effect/Schema";

/** The most recent log lines a diagnostics report can include per log file. */
export const DIAGNOSTICS_MAX_LOG_LINES = 2000;

/** `app.diagnosticsReport`: what "Copy diagnostics" puts on the clipboard. */
export const DiagnosticsReport = Schema.Struct({
  /**
   * Plain text: versions, OS, paths, settings with secrets removed and recent log lines. Tokens and
   * keys are redacted.
   */
  text: Schema.String,
  /** The folder holding the server and desktop log files. */
  logDir: Schema.String,
});
export type DiagnosticsReport = typeof DiagnosticsReport.Type;

/** `app.diagnostics`: what the About pane and "Copy diagnostics" start from. */
export const Diagnostics = Schema.Struct({
  version: Schema.String,
  platform: Schema.String,
  arch: Schema.String,
  /** `process.versions` subset: node, electron, chrome, claude CLI … */
  versions: Schema.Record(Schema.String, Schema.String),
  dataDir: Schema.String,
  logFile: Schema.optionalKey(Schema.String),
  threads: Schema.Struct({
    total: Schema.Int,
    live: Schema.Int,
    /**
     * Threads a quit would cut off: a turn open, background work, or a terminal command. Absent
     * when that can't be told, such as when the process scan failed.
     */
    working: Schema.optionalKey(Schema.Int),
  }),
  /** Present when the server runs the echo fake agent instead of real agents. */
  fakeAgent: Schema.optionalKey(Schema.Boolean),
});
export type Diagnostics = typeof Diagnostics.Type;
