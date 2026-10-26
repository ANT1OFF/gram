import { DEFAULT_SETTINGS, type Diagnostics } from "@gram/contracts";
import { describe, expect, it } from "vitest";
import { formatDiagnosticsReport, formatLogLine, tildeHome } from "./report.ts";

const DIAGNOSTICS: Diagnostics = {
  version: "0.3.0",
  platform: "darwin",
  arch: "arm64",
  versions: { node: "24.9.0", electron: "44.3.0", chrome: "146.0.0.0", v8: "14.6", uv: "1.51" },
  dataDir: "/Users/me/Library/Application Support/gram-state",
  threads: { total: 4, live: 2, working: 1 },
};

describe("formatLogLine", () => {
  it("renders a pino line with its extra fields, redacted", () => {
    const line = JSON.stringify({
      level: 40,
      time: "2026-09-16T10:00:00.000Z",
      name: "server",
      pid: 7,
      threadId: "t1",
      apiKey: "live-key",
      msg: "watchdog fired",
    });
    expect(formatLogLine(line)).toBe(
      '2026-09-16T10:00:00.000Z WARN watchdog fired {"threadId":"t1","apiKey":"[redacted]"}',
    );
  });

  it("keeps a non-JSON line, still redacting tokens", () => {
    expect(formatLogLine("boot http://127.0.0.1:1/?boot=abcdef")).toBe(
      "boot http://127.0.0.1:1/?boot=[redacted]",
    );
  });
});

describe("formatDiagnosticsReport", () => {
  it("lists versions, paths, settings and each log tail", () => {
    const text = formatDiagnosticsReport({
      generatedAt: new Date("2026-09-16T12:00:00Z"),
      diagnostics: DIAGNOSTICS,
      os: { type: "Darwin", release: "25.6.0" },
      logDir: "/data/logs",
      settings: { ...DEFAULT_SETTINGS, editor: { command: "code --token=abc123" } },
      logs: [
        {
          name: "server",
          file: "/data/logs/server-2026-09-16.log",
          lines: ['{"level":30,"time":"2026-09-16T11:59:00.000Z","msg":"server started"}'],
        },
      ],
    });

    expect(text).toContain("Version: 0.3.0");
    expect(text).toContain("OS: Darwin 25.6.0 (darwin arm64)");
    expect(text).toContain("Runtime: node 24.9.0, electron 44.3.0, chrome 146.0.0.0, v8 14.6");
    expect(text).toContain("Threads: 4 total, 2 live");
    expect(text).toContain('"command": "code --token=[redacted]"');
    expect(text).toContain("server log, last 1 lines of /data/logs/server-2026-09-16.log:");
    expect(text).toContain("2026-09-16T11:59:00.000Z INFO server started");
    expect(text).not.toContain("abc123");
  });

  it("says when there are no log files", () => {
    const text = formatDiagnosticsReport({
      generatedAt: new Date(0),
      diagnostics: DIAGNOSTICS,
      os: { type: "Linux", release: "6.8" },
      logDir: "/data/logs",
      settings: DEFAULT_SETTINGS,
      logs: [],
    });
    expect(text).toContain("No log files yet.");
  });

  it("shows the home directory as ~ in every path it copies", () => {
    const text = formatDiagnosticsReport({
      generatedAt: new Date(0),
      diagnostics: DIAGNOSTICS,
      os: { type: "Darwin", release: "25.6.0" },
      logDir: "/Users/me/Library/Logs/Gram",
      settings: {
        ...DEFAULT_SETTINGS,
        agents: { ...DEFAULT_SETTINGS.agents, defaultFolder: "/Users/me/code" },
      },
      logs: [
        {
          name: "server",
          file: "/Users/me/Library/Logs/Gram/server.log",
          lines: ['{"level":30,"time":"t","msg":"opened","cwd":"/Users/me/code/api"}'],
        },
      ],
      home: "/Users/me",
    });
    expect(text).toContain("Data folder: ~/Library/Application Support/gram-state");
    expect(text).toContain("Log folder: ~/Library/Logs/Gram");
    expect(text).toContain("last 1 lines of ~/Library/Logs/Gram/server.log:");
    expect(text).toContain('{"cwd":"~/code/api"}');
    expect(text).not.toContain("/Users/me");
  });
});

describe("tildeHome", () => {
  it("replaces a Windows home natively, with forward slashes and JSON-escaped, in any case", () => {
    expect(
      tildeHome(
        'C:\\Users\\Me\\AppData x c:/users/me/AppData "C:\\\\Users\\\\Me\\\\x" C:\\Users\\Meta',
        "C:\\Users\\Me",
      ),
    ).toBe('~\\AppData x ~/AppData "~\\\\x" C:\\Users\\Meta');
  });

  it("matches whole path segments only, and leaves text alone without a home", () => {
    expect(tildeHome("/Users/jo/x /Users/joanna/y /Users/jo", "/Users/jo/")).toBe(
      "~/x /Users/joanna/y ~",
    );
    expect(tildeHome("/Users/jo/x", undefined)).toBe("/Users/jo/x");
  });
});
