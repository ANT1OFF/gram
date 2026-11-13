// The agent browser on a server with no desktop app: a Node process the server forks, which runs
// the same pane module (`pane.ts`) over a headless Chromium (`headless.ts`) and answers the
// server's `pane.request` messages on its IPC channel, as the desktop shell answers them on
// Electron's port.
//
//   GRAM_BROWSER_EXECUTABLE  the Chromium (or Chrome) to start; required
//   GRAM_BROWSER_SANDBOX     `0` starts it without Chromium's sandbox, as root in a container needs
//
// The browser starts on the first request and reaches loopback only: the server's own addresses,
// where an agent's dev server runs. A navigation anywhere else is refused before it asks anyone.

import { lookup } from "node:dns/promises";
import { pathToFileURL } from "node:url";

import {
  PANE_COMMAND_TIMEOUT_MS,
  browseTarget,
  paneRequestMessage,
  type PaneResult,
  type PaneResponseMessage,
} from "@gram/contracts/link-trust";

import { createBrowseHostList } from "../../core/browse-rules.ts";
import type { ShellLog } from "../../core/log.ts";
import { headlessViews, launchHeadless, type HeadlessBrowser } from "./headless.ts";
import { createAgentPanes, type AgentPanes } from "./pane.ts";
import { servePaneMessage } from "./serve.ts";

/** What a navigation off loopback answers here, before the pane would raise a card for it. */
export const OFF_LOOPBACK: PaneResult = {
  ok: false,
  code: "refused",
  message:
    "This browser runs on the Gram server and reaches only the server's own loopback addresses, such as a dev server there. It can't open other sites.",
};

/** What a command answers when the browser couldn't start or make the thread's page. */
export const NO_BROWSER: PaneResult = {
  ok: false,
  code: "failed",
  message:
    "The browser on the Gram server couldn't open a page. Its log says why; the next command tries again.",
};

/** How long one command may run here: under the server's own wait, so this answer reaches it. */
export const COMMAND_DEADLINE_MS = PANE_COMMAND_TIMEOUT_MS - 5_000;

/** What a command answers when its page never did. */
export const STOPPED_ANSWERING: PaneResult = {
  ok: false,
  code: "failed",
  message:
    "The page stopped answering, so it was closed. Navigate again to open it afresh; if it happens again, the page's own script is likely looping.",
};

/** Whether `raw` is a navigation this browser refuses outright: anything that isn't loopback. */
export const offLoopback = (raw: unknown): boolean => {
  const request = paneRequestMessage(raw)?.request as
    | { command?: { op?: unknown; url?: unknown } }
    | undefined;
  const command = request?.command;
  return (
    command?.op === "navigate" &&
    typeof command.url === "string" &&
    browseTarget(command.url).kind !== "loopback"
  );
};

const stderrLog: ShellLog = {
  info: () => {},
  warn: (fields, message) => console.warn(JSON.stringify({ level: "warn", message, ...fields })),
  error: (fields, message) => console.error(JSON.stringify({ level: "error", message, ...fields })),
};

/**
 * The pane over a headless browser started from `executable` when first needed. `close` ends the
 * browser; the next request starts another.
 */
export const headlessPanes = (options: {
  readonly executable: string;
  readonly sandbox: boolean;
  readonly log?: ShellLog;
  /** How long one command may take; `COMMAND_DEADLINE_MS` unless a test says otherwise. */
  readonly deadlineMs?: number;
}): { readonly panes: AgentPanes; close(): Promise<void> } => {
  const log = options.log ?? stderrLog;
  /** The commands running on each thread's page. */
  const running = new Map<string, number>();
  let browser: HeadlessBrowser | undefined;
  let views: ReturnType<typeof headlessViews> | undefined;
  const viewsNow = () => {
    if (views !== undefined) return views;
    const started = launchHeadless(options);
    browser = started;
    const made = headlessViews(
      started.connection,
      () => panes,
      (error) => log.warn({ source: "headless-browser", error: String(error) }, "no page"),
      (threadId) => panes.closed(threadId),
      (threadId) => (running.get(threadId) ?? 0) > 0,
    );
    views = made;
    started.connection.onClose(() => {
      if (views === made) {
        views = undefined;
        browser = undefined;
      }
    });
    return made;
  };
  // Approvals hold for this process only; off loopback nothing loads here whatever the list says.
  const hosts = createBrowseHostList({ load: () => [], save: () => {}, changed: () => {} });
  const panes: AgentPanes = createAgentPanes({
    hosts,
    views: { contentsFor: (threadId, create) => viewsNow().contentsFor(threadId, create) },
    log,
    resolveHost: async (host) => ({
      endpoints: (await lookup(host, { all: true })).map(({ address, family }) => ({
        address,
        family: family === 6 ? ("ipv6" as const) : ("ipv4" as const),
      })),
    }),
  });
  const served: AgentPanes = {
    ...panes,
    serve: async (raw, requestId) => {
      const threadId = (raw as { threadId?: unknown } | null)?.threadId;
      const thread = typeof threadId === "string" ? threadId : undefined;
      if (thread !== undefined) {
        running.set(thread, (running.get(thread) ?? 0) + 1);
        views?.touch(thread);
      }
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<PaneResult>((resolve) => {
        deadline = setTimeout(() => {
          // A page whose script never yields answers nothing, and would hold the thread's
          // commands for good: it is closed, and the next command opens a fresh one.
          if (requestId !== undefined) panes.cancel(requestId);
          if (thread !== undefined) {
            views?.close(thread);
            panes.closed(thread);
          }
          resolve(STOPPED_ANSWERING);
        }, options.deadlineMs ?? COMMAND_DEADLINE_MS);
      });
      try {
        const result = await Promise.race([panes.serve(raw, requestId), late]);
        return result.ok || result.code !== "noPane" ? result : NO_BROWSER;
      } finally {
        clearTimeout(deadline);
        if (thread !== undefined) {
          const left = (running.get(thread) ?? 1) - 1;
          if (left > 0) running.set(thread, left);
          else running.delete(thread);
        }
      }
    },
  };
  return {
    panes: served,
    close: async () => {
      const stopping = browser?.close();
      browser = undefined;
      views = undefined;
      await stopping;
    },
  };
};

/** Serves `pane.request` messages on this process's IPC channel until the server goes away. */
const main = () => {
  const executable = process.env["GRAM_BROWSER_EXECUTABLE"];
  const send = process.send?.bind(process);
  if (send === undefined) {
    console.error("The headless browser host runs as a child of the Gram server.");
    process.exit(2);
  }
  if (executable === undefined || executable === "") {
    console.error("GRAM_BROWSER_EXECUTABLE names no browser.");
    process.exit(2);
  }
  const { panes, close } = headlessPanes({
    executable,
    sandbox: process.env["GRAM_BROWSER_SANDBOX"] !== "0",
  });
  const reply = (response: PaneResponseMessage) => send(response);
  process.on("message", (message) => {
    const request = paneRequestMessage(message);
    if (request !== undefined && offLoopback(message)) {
      reply({ type: "pane.response", id: request.id, result: OFF_LOOPBACK });
      return;
    }
    servePaneMessage(message, panes, reply);
  });
  const stop = () => {
    // The browser gets a few seconds to stop, so its profile goes with it.
    const deadline = setTimeout(() => process.exit(0), 5_000);
    void close().finally(() => {
      clearTimeout(deadline);
      process.exit(0);
    });
  };
  process.on("disconnect", stop);
  process.on("SIGTERM", stop);
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
