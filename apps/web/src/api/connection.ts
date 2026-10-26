import type { ConnectionMonitor, ConnectionNotice, ConnectionState } from "./types";

/** How long a command waits for a dropped connection to come back before it gives up. */
export const RECONNECT_WAIT_MS = 120_000;

/**
 * Resolves once a dropped connection is open again, `false` if it isn't within `timeoutMs`, the
 * session expired, or `signal` aborted. One that isn't reconnecting resolves at once: before the first open the socket
 * itself waits, and a window with no feed open yet never reports `open`. It asks for a retry now,
 * since a command is someone waiting for its result.
 */
export function whenReconnected(
  monitor: ConnectionMonitor,
  timeoutMs: number = RECONNECT_WAIT_MS,
  signal?: AbortSignal,
): Promise<boolean> {
  if (monitor.get().status !== "reconnecting") return Promise.resolve(true);
  if (signal?.aborted === true) return Promise.resolve(false);
  return new Promise((resolve) => {
    const settle = (open: boolean) => {
      clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener("abort", aborted);
      resolve(open);
    };
    const aborted = () => settle(false);
    signal?.addEventListener("abort", aborted, { once: true });
    const timer = setTimeout(() => settle(false), timeoutMs);
    const unsubscribe = monitor.subscribe(() => {
      const { status } = monitor.get();
      if (status === "open") settle(true);
      else if (status === "expired") settle(false);
    });
    monitor.retryNow();
  });
}

/** The monitor plus the hooks subscriptions report through. */
export interface ConnectionControl extends ConnectionMonitor {
  /** A subscription received its first event. */
  opened(id: symbol): void;
  /** A subscription dropped and retries at `retryAt`. */
  failed(id: symbol, attempt: number, retryAt: number): void;
  /** A subscription ended for good. */
  released(id: symbol): void;
  /** Resolves after `ms`, early on `retryNow()`, or at once when `signal` aborts. */
  wait(ms: number, signal: AbortSignal): Promise<void>;
  /** The server rejected the session for good; the state stays `expired`. */
  expire(): void;
  /** Why the server is unavailable, until the connection reopens; `undefined` forgets it. */
  explain(notice: ConnectionNotice | undefined): void;
}

const CONNECTING: ConnectionState = { status: "connecting" };
const OPEN: ConnectionState = { status: "open" };
const EXPIRED: ConnectionState = { status: "expired" };

/**
 * What the `/?boot=0` probe found: `rejected` when the server rejects this page's session cookie
 * (401 once its launch token changed), a notice when a 503 says why the server is unavailable, and
 * `unknown` otherwise. A `/?boot=` request reaches the server through the Vite dev proxy too; an
 * unknown boot token falls through to the cookie check. A network failure means the server is
 * down, not a rejected session.
 */
export type ProbeAnswer = "rejected" | "unknown" | ConnectionNotice;

/** A 503's `{ message, detail? }`, or `undefined` for any other body. */
async function noticeOf(response: Response): Promise<ConnectionNotice | undefined> {
  try {
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return undefined;
    const { message, detail } = body as { message?: unknown; detail?: unknown };
    if (typeof message !== "string" || message.trim() === "") return undefined;
    return typeof detail === "string" && detail.trim() !== "" ? { message, detail } : { message };
  } catch {
    // Not JSON: a proxy's own error page says nothing worth showing.
    return undefined;
  }
}

export async function probeSession(fetchImpl: typeof fetch = fetch): Promise<ProbeAnswer> {
  try {
    const response = await fetchImpl("/?boot=0", {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "manual",
    });
    if (response.status === 401) return "rejected";
    if (response.status === 503) return (await noticeOf(response)) ?? "unknown";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * `control` with a session probe on failures: at most one per reconnect wave (every subscription
 * that drops reports the same attempt) and never two at once, counting again once it reopens. A
 * rejected session expires the connection; a notice explains the outage until the next probe.
 */
export function withSessionProbe(
  control: ConnectionControl,
  probe: () => Promise<ProbeAnswer> = () => probeSession(),
): ConnectionControl {
  let probedAttempt = 0;
  let probing = false;
  control.subscribe(() => {
    if (control.get().status === "open") probedAttempt = 0;
  });
  return {
    ...control,
    failed: (id, attempt, retryAt) => {
      control.failed(id, attempt, retryAt);
      if (probing || attempt <= probedAttempt) return;
      probedAttempt = attempt;
      probing = true;
      void probe()
        .then((answer) => {
          if (answer === "rejected") control.expire();
          else control.explain(answer === "unknown" ? undefined : answer);
        })
        .finally(() => {
          probing = false;
        });
    },
  };
}

/** Aggregates every live subscription: reconnecting while any of them is waiting to retry. */
export function createConnectionMonitor(): ConnectionControl {
  const failing = new Map<symbol, { attempt: number; retryAt: number }>();
  const listeners = new Set<() => void>();
  const waiters = new Set<() => void>();
  let everOpen = false;
  let expired = false;
  let notice: ConnectionNotice | undefined;
  let state = CONNECTING;

  const publish = () => {
    let next: ConnectionState;
    if (expired) {
      next = EXPIRED;
    } else if (failing.size === 0) {
      notice = undefined;
      next = everOpen ? OPEN : CONNECTING;
    } else {
      const all = [...failing.values()];
      next = {
        status: "reconnecting",
        attempt: Math.max(...all.map((f) => f.attempt)),
        retryAt: Math.min(...all.map((f) => f.retryAt)),
        ...(notice === undefined ? {} : { notice }),
      };
    }
    if (
      next.status === state.status &&
      next.attempt === state.attempt &&
      next.retryAt === state.retryAt &&
      next.notice === state.notice
    ) {
      return;
    }
    state = next;
    for (const listener of listeners) listener();
  };

  return {
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retryNow: () => {
      for (const wake of waiters) wake();
    },
    opened: (id) => {
      everOpen = true;
      failing.delete(id);
      publish();
    },
    failed: (id, attempt, retryAt) => {
      failing.set(id, { attempt, retryAt });
      publish();
    },
    released: (id) => {
      if (failing.delete(id)) publish();
    },
    expire: () => {
      expired = true;
      publish();
    },
    explain: (next) => {
      // A probe answered after the connection reopened is stale.
      if (failing.size === 0) return;
      notice = next;
      publish();
    },
    wait: (ms, signal) =>
      new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          waiters.delete(done);
          signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        waiters.add(done);
        signal.addEventListener("abort", done, { once: true });
      }),
  };
}

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  random?: () => number;
}

/** The delay before retry `attempt` (1-based): doubling from `baseMs`, capped, ±20 % jitter. */
export const backoffDelay = (
  attempt: number,
  { baseMs = 500, maxMs = 10_000, random = Math.random }: BackoffOptions = {},
): number => Math.round(Math.min(maxMs, baseMs * 2 ** (attempt - 1)) * (0.8 + random() * 0.4));

/**
 * Keeps a server stream open until `signal` aborts. A stream that fails, or ends on its own (server
 * streams never do), counts as a dropped connection: the monitor shows reconnecting and the stream
 * is reopened after a backoff. Each new subscription starts from the server's snapshot
 * (`threads.snapshot` / `messages`), which consumers treat as a reset. An error `final` accepts
 * is no drop: it ends the stream for good and rejects the consumer with it.
 */
export async function* resubscribing<T>(
  open: (signal: AbortSignal) => AsyncIterable<T>,
  monitor: ConnectionControl,
  signal: AbortSignal,
  options: BackoffOptions & {
    /** Yielded before each subscription's first event, so consumers can see where it starts. */
    marker?: T;
    /** Errors reopening can't mend, such as the stream's subject being gone. */
    final?: (error: unknown) => boolean;
  } = {},
): AsyncGenerator<T> {
  const id = Symbol("subscription");
  let attempt = 0;
  try {
    while (!signal.aborted) {
      let first = true;
      try {
        for await (const value of open(signal)) {
          if (first) {
            first = false;
            attempt = 0;
            monitor.opened(id);
            if (options.marker !== undefined) yield options.marker;
          }
          yield value;
        }
      } catch (error) {
        if (signal.aborted) return;
        if (options.final?.(error)) throw error;
        console.warn("server stream dropped", error);
      }
      if (signal.aborted) return;
      attempt++;
      const delay = backoffDelay(attempt, options);
      monitor.failed(id, attempt, Date.now() + delay);
      await monitor.wait(delay, signal);
    }
  } finally {
    monitor.released(id);
  }
}
