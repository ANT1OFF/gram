import type { Diagnostics, Settings } from "@gram/contracts";
import { redactSecrets, redactText } from "../logging/redact.ts";

export interface LogTail {
  /** `server` or `desktop`. */
  readonly name: string;
  readonly file: string;
  readonly lines: ReadonlyArray<string>;
}

export interface DiagnosticsReportInput {
  readonly generatedAt: Date;
  readonly diagnostics: Diagnostics;
  readonly os: { readonly type: string; readonly release: string };
  readonly logDir: string;
  readonly settings: Settings;
  readonly logs: ReadonlyArray<LogTail>;
  /** The home directory, shown as `~` wherever a path in the report starts with it. */
  readonly home?: string | undefined;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `text` with the home directory as `~`, in each form a path takes in a report: native, with forward
 * slashes, and JSON-escaped; case-insensitive for a Windows home. Only a whole path segment matches,
 * so `/Users/jo` leaves `/Users/joanna` alone.
 */
export function tildeHome(text: string, home: string | undefined): string {
  const root = home?.replace(/[\\/]+$/, "");
  if (root === undefined || root === "") return text;
  const windows = root.includes("\\") || /^[a-z]:/i.test(root);
  const forms = [
    ...new Set([root, root.replaceAll("\\", "/"), root.replaceAll("\\", "\\\\")]),
  ].toSorted((a, b) => b.length - a.length);
  return forms.reduce(
    (out, form) =>
      out.replace(
        new RegExp(`${escapeRegExp(form)}(?=[\\\\/"'\\s:,;)]|$)`, windows ? "gi" : "g"),
        "~",
      ),
    text,
  );
}

const LEVEL_NAMES: Readonly<Record<number, string>> = {
  10: "TRACE",
  20: "DEBUG",
  30: "INFO",
  40: "WARN",
  50: "ERROR",
  60: "FATAL",
};

const STANDARD_FIELDS: ReadonlySet<string> = new Set(["time", "level", "msg", "name", "pid"]);

/** A pino JSON line as `time LEVEL msg {other fields}`; any other line as is. Redacted either way. */
export function formatLogLine(line: string): string {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return redactText(line);
  }
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return redactText(line);
  const record = entry as Record<string, unknown>;
  const fields = Object.fromEntries(
    Object.entries(record).filter(([key]) => !STANDARD_FIELDS.has(key)),
  );
  const level = LEVEL_NAMES[Number(record["level"])] ?? String(record["level"] ?? "");
  const extra = Object.keys(fields).length === 0 ? "" : ` ${JSON.stringify(redactSecrets(fields))}`;
  return redactText(
    `${String(record["time"] ?? "")} ${level} ${String(record["msg"] ?? "")}${extra}`,
  );
}

const RUNTIMES = ["node", "electron", "chrome", "v8"] as const;

/** The plain-text report "Copy diagnostics" puts on the clipboard. */
export function formatDiagnosticsReport(input: DiagnosticsReportInput): string {
  const { diagnostics } = input;
  const runtimes = RUNTIMES.flatMap((name) => {
    const version = diagnostics.versions[name];
    return version === undefined ? [] : [`${name} ${version}`];
  });
  const lines = [
    "Gram diagnostics",
    `Generated: ${input.generatedAt.toISOString()}`,
    `Version: ${diagnostics.version}`,
    `OS: ${input.os.type} ${input.os.release} (${diagnostics.platform} ${diagnostics.arch})`,
    `Runtime: ${runtimes.join(", ")}`,
    `Data folder: ${diagnostics.dataDir}`,
    `Log folder: ${input.logDir}`,
    `Threads: ${diagnostics.threads.total} total, ${diagnostics.threads.live} live`,
    "",
    "Settings (secrets removed):",
    JSON.stringify(redactSecrets(input.settings), null, 2),
  ];
  if (input.logs.length === 0) lines.push("", "No log files yet.");
  for (const log of input.logs) {
    lines.push(
      "",
      `${log.name} log, last ${log.lines.length} lines of ${log.file}:`,
      ...log.lines.map(formatLogLine),
    );
  }
  return `${tildeHome(redactText(lines.join("\n")), input.home)}\n`;
}
