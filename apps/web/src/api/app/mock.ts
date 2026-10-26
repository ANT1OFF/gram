import { GRAM_REPO, type ComposedIssue } from "@gram/contracts";

import { composeMockIssue } from "../mock-issues";
import { mockLaunchChecks } from "../mock-launch-checks";
import { MockWindows } from "../mock-windows";
import type { MockWorld } from "../mock-world";
import type { AppApi } from "./types";
import { mockUsageOverview } from "../mock-usage";

/** What the e2e specs read back, or set, through `window.gramMock`. */
export interface AppMockControls {
  /** URLs the app asked to open; the mock never opens anything. */
  readonly opened: string[];
  /** Issues filed through the form, as posted. */
  readonly filedIssues: ComposedIssue[];
  /** A spec sets `message` to make `fileIssue` fail the way gh does, with it. */
  readonly issueFailure: { message?: string | undefined };
}

/** Local app diagnostics. */
export function createAppMock(world: MockWorld): AppApi & AppMockControls {
  const windows = new MockWindows();
  const opened: string[] = [];
  const filedIssues: ComposedIssue[] = [];
  const issueFailure: AppMockControls["issueFailure"] = {};

  const diagnostics: AppApi["diagnostics"] = async () => ({
    version: "1.0.0-mock",
    platform: "mock",
    arch: "arm64",
    versions: { node: "24.0.0" },
    dataDir: "/mock/gram-state",
    logFile: "/mock/gram-state/logs/server-2026-09-16.log",
    threads: {
      total: 0,
      live: 0,
      working: world.threads().filter(({ status }) => status === "running" || status === "starting")
        .length,
    },
  });
  const previewIssue: AppApi["previewIssue"] = async (draft) =>
    composeMockIssue(draft, (await diagnostics()).version);

  return {
    usageOverview: mockUsageOverview,
    opened,
    filedIssues,
    issueFailure,
    watchWindows: (window, signal) => windows.watch(window.windowId, window.name, signal),
    reportWindow: async (windowId, threadIds) => windows.report(windowId, threadIds),
    diagnostics,
    diagnosticsReport: async () => {
      const info = await diagnostics();
      return {
        logDir: "/mock/gram-state/logs",
        text: [
          "Gram diagnostics",
          `Version: ${info.version}`,
          `Data folder: ${info.dataDir}`,
          "",
          "No log files yet.",
          "",
        ].join("\n"),
      };
    },
    openLogsFolder: async () => {},
    launchChecks: async () => mockLaunchChecks(),
    previewIssue,
    fileIssue: async (draft) => {
      await world.delay(200);
      if (issueFailure.message !== undefined) {
        throw Object.assign(new Error(issueFailure.message), { _tag: "GitError" });
      }
      filedIssues.push(await previewIssue(draft));
      const number = 160 + filedIssues.length;
      return { number, url: `https://github.com/${GRAM_REPO}/issues/${number}` };
    },
    openExternal: async (url) => {
      opened.push(url);
    },
  };
}
