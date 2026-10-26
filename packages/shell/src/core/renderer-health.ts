// Watches each window's renderer for main: logs when it hangs, dies or fails to load, and when its
// socket to the server drops and comes back, so a window that stops moving leaves a line saying
// which of those it was. A renderer that died is reloaded, one that hangs is offered a reload, and
// a page that failed to load is tried again, each within a budget. Nothing about the page itself
// is logged: no URL (the boot URL carries the launch token), no title, no content. Electron stays
// out of this module, so tests drive it with fakes.

import type { ShellLog } from "./log.ts";

/** How long a renderer may hang before the user is offered a reload. */
export const UNRESPONSIVE_PROMPT_MS = 20_000;
/** How many automatic reloads one window gets within `RELOAD_WINDOW_MS` before they stop. */
export const RELOAD_BUDGET = 3;
export const RELOAD_WINDOW_MS = 5 * 60_000;
/** The wait before reloading a page that failed to load. */
export const FAILED_LOAD_RETRY_MS = 2_000;

/** Chromium's `ERR_ABORTED`: a navigation the next one superseded, not a failure. */
const ERR_ABORTED = -3;

/** The slice of Electron's `WebContents` events this needs. */
export interface RendererEvents {
  on(event: "unresponsive" | "responsive" | "did-start-loading", listener: () => void): unknown;
  on(
    event: "render-process-gone",
    listener: (event: unknown, details: { reason: string; exitCode: number }) => void,
  ): unknown;
  on(
    event: "did-fail-load",
    listener: (
      event: unknown,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean,
    ) => void,
  ): unknown;
}

export interface RendererWatchOptions {
  /** Which window, for the log. */
  readonly windowId: string;
  readonly log: ShellLog;
  /** Loads the app afresh, onto the current server. */
  readonly reload: () => void;
  /** Ends a hung renderer so that a reload can replace it. */
  readonly crash: () => void;
  /** Asks the user whether to reload a hung window; resolves true for reload. */
  readonly offerReload: () => Promise<boolean>;
  /** Whether the window is still there, for a callback that fires after it closed. */
  readonly alive: () => boolean;
  readonly setTimeout: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout: (timer: unknown) => void;
  readonly now: () => number;
}

/** Hooks one window's renderer up to the log and its recovery. */
export function watchRenderer(contents: RendererEvents, options: RendererWatchOptions): void {
  const { log, windowId } = options;
  const fields = (extra: Readonly<Record<string, unknown>> = {}) => ({
    source: "renderer",
    window: windowId,
    ...extra,
  });
  let reloads: number[] = [];
  /** Spends one of the window's automatic reloads; false once they are used up. */
  const spend = (): boolean => {
    const now = options.now();
    reloads = reloads.filter((at) => now - at < RELOAD_WINDOW_MS);
    if (reloads.length >= RELOAD_BUDGET) return false;
    reloads.push(now);
    return true;
  };
  let hungSince: number | undefined;
  let promptTimer: unknown;
  let prompting = false;
  /** The user chose to reload a hung renderer; its death is then reloaded whatever the budget. */
  let reloadAsked = false;

  contents.on("unresponsive", () => {
    if (hungSince !== undefined) return;
    hungSince = options.now();
    log.warn(fields(), "renderer unresponsive");
    promptTimer = options.setTimeout(() => {
      promptTimer = undefined;
      if (hungSince === undefined || prompting || !options.alive()) return;
      prompting = true;
      void options.offerReload().then((reload) => {
        prompting = false;
        if (!reload || hungSince === undefined || !options.alive()) return;
        log.warn(fields({ hungMs: options.now() - hungSince }), "reloading a hung renderer");
        reloadAsked = true;
        options.crash();
      });
    }, UNRESPONSIVE_PROMPT_MS);
  });
  contents.on("responsive", () => {
    if (hungSince === undefined) return;
    log.info(fields({ hungMs: options.now() - hungSince }), "renderer responsive again");
    hungSince = undefined;
    options.clearTimeout(promptTimer);
    promptTimer = undefined;
  });
  contents.on("render-process-gone", (_event, { reason, exitCode }) => {
    hungSince = undefined;
    options.clearTimeout(promptTimer);
    promptTimer = undefined;
    log.warn(fields({ reason, exitCode }), "renderer gone");
    const asked = reloadAsked;
    reloadAsked = false;
    if (reason === "clean-exit" || !options.alive()) return;
    if (!asked && !spend()) {
      log.error(fields({ reloads: RELOAD_BUDGET }), "renderer keeps dying; not reloading it");
      return;
    }
    options.reload();
  });
  let loadRetry: unknown;
  // Any load that starts after a failure supersedes its retry: the server's recovery reloads every
  // window itself, and a second reload would throw away what was typed into the fresh page.
  contents.on("did-start-loading", () => {
    options.clearTimeout(loadRetry);
    loadRetry = undefined;
  });
  contents.on("did-fail-load", (_event, errorCode, errorDescription, _url, isMainFrame) => {
    if (!isMainFrame || errorCode === ERR_ABORTED) return;
    log.warn(fields({ errorCode, errorDescription }), "renderer failed to load");
    if (!spend()) return;
    options.clearTimeout(loadRetry);
    loadRetry = options.setTimeout(() => {
      loadRetry = undefined;
      if (options.alive()) options.reload();
    }, FAILED_LOAD_RETRY_MS);
  });
}

/** What a renderer says of its socket to the server, as its connection banner shows it. */
export interface RendererConnection {
  readonly status: "connecting" | "open" | "reconnecting" | "expired";
  readonly attempt?: number | undefined;
}

/** Reads what a renderer sent as a `RendererConnection`, or `undefined` for anything else. */
export const parseRendererConnection = (value: unknown): RendererConnection | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const { status, attempt } = value as { status?: unknown; attempt?: unknown };
  if (
    status !== "connecting" &&
    status !== "open" &&
    status !== "reconnecting" &&
    status !== "expired"
  ) {
    return undefined;
  }
  return typeof attempt === "number" && Number.isSafeInteger(attempt) && attempt >= 0
    ? { status, attempt }
    : { status };
};

/**
 * Logs each window's socket as it drops, retries and comes back, with how long it was down. A
 * window that stops moving with its socket still open points at the renderer; one that keeps
 * reconnecting points at the server.
 */
export function createConnectionLog(log: ShellLog, now: () => number) {
  const down = new Map<string, { since: number; attempt: number }>();
  return {
    report(windowId: string, connection: RendererConnection) {
      const fields = { source: "renderer", window: windowId };
      const lost = down.get(windowId);
      if (connection.status === "reconnecting") {
        const attempt = connection.attempt ?? 0;
        if (lost === undefined) {
          down.set(windowId, { since: now(), attempt });
          log.warn({ ...fields, attempt }, "renderer lost its server connection");
        } else if (attempt !== lost.attempt) {
          lost.attempt = attempt;
          log.info({ ...fields, attempt, downMs: now() - lost.since }, "renderer reconnecting");
        }
        return;
      }
      if (connection.status === "open" && lost !== undefined) {
        log.info(
          { ...fields, downMs: now() - lost.since, attempts: lost.attempt },
          "renderer connection restored",
        );
      } else if (connection.status === "expired") {
        log.warn(fields, "renderer session expired");
      }
      down.delete(windowId);
    },
    /** Forgets a window that closed. */
    forget(windowId: string) {
      down.delete(windowId);
    },
  };
}
