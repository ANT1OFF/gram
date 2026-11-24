import { sleep } from "@/lib/sleep";

import { seeded } from "./prng";

export type FaultKind = "slow" | "server" | "network" | "timeout";

export interface InjectedFault {
  /** Counts from 1 across the page's life, so a spec can tell a new fault from one it has seen. */
  readonly seq: number;
  readonly method: string;
  readonly kind: FaultKind;
  /** `Date.now()` when it was injected (the step clock's, in the replayable mock). */
  readonly at: number;
  /** Whether the person had just acted: a press or a key within `ASKED_MS` before the call. */
  readonly asked: boolean;
  /** Whether the call changes something (its name starts with a verb that does), not a read. */
  readonly write: boolean;
}

export interface FaultOptions {
  /** The share of calls to disturb, in (0, 1]. */
  readonly rate: number;
  readonly seed: number;
  /** The longest a slow call or a timeout waits. */
  readonly maxDelayMs?: number;
}

const KINDS: readonly (readonly [FaultKind, number])[] = [
  ["slow", 0.5],
  ["server", 0.2],
  ["network", 0.15],
  ["timeout", 0.15],
];
const DEFAULT_MAX_DELAY_MS = 4000;
const MIN_DELAY_MS = 150;
const KEEP = 50;
const ASKED_MS = 1000;
const WRITE =
  /^(add|answer|apply|approve|archive|cancel|clear|close|commit|create|delete|dismiss|edit|fork|import|install|interrupt|mark|merge|move|open|pin|push|remove|rename|reply|reset|resolve|restore|retry|revert|rewind|save|send|set|snooze|start|steer|stop|submit|undo|unpin|update|upsert)(?:[A-Z]|$)/;

const failure = (kind: Exclude<FaultKind, "slow">, method: string): Error => {
  const error = failureOf(kind, method);
  const [message = String(error), ...frames] = (error.stack ?? String(error)).split("\n");
  error.stack = [message, `    at api.${method} (mock fault)`, ...frames].join("\n");
  return error;
};

const failureOf = (kind: Exclude<FaultKind, "slow">, method: string): Error => {
  switch (kind) {
    case "server":
      return Object.assign(new Error("The Gram server had a problem (503 Service Unavailable)"), {
        _tag: "ServerError",
        status: 503,
        method,
      });
    case "network":
      return Object.assign(new Error("Lost the connection to the Gram server"), {
        _tag: "RpcClientError",
        reason: { _tag: "SocketCloseError" },
        method,
      });
    case "timeout":
      return Object.assign(new Error("The Gram server didn't answer in time"), {
        _tag: "TimeoutError",
        method,
      });
  }
};

const isPromise = (value: unknown): value is Promise<unknown> =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { then?: unknown }).then === "function";

declare global {
  interface Window {
    gramMockFaults?: InjectedFault[];
  }
}

export function parseRate(raw: string | undefined): number {
  const rate = Number(raw);
  return Number.isFinite(rate) && rate > 0 ? Math.min(rate, 1) : 0;
}

/** `api` with `options.rate` of its async calls slowed or failed, drawn from `options.seed`. */
export function withFaults<T extends object>(api: T, options: FaultOptions): T {
  const random = seeded(options.seed);
  const maxDelay = Math.max(MIN_DELAY_MS, options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
  const log: InjectedFault[] = [];
  window.gramMockFaults = log;
  let seq = 0;
  let lastInput = -Infinity;
  for (const type of ["pointerdown", "keydown"])
    window.addEventListener(type, () => (lastInput = Date.now()), { capture: true, passive: true });
  const record = (method: string, kind: FaultKind) => {
    const at = Date.now();
    log.push({
      seq: ++seq,
      method,
      kind,
      at,
      asked: at - lastInput <= ASKED_MS,
      write: WRITE.test(method),
    });
    if (log.length > KEEP) log.splice(0, log.length - KEEP);
  };
  const pick = (): FaultKind => {
    let roll = random();
    for (const [kind, weight] of KINDS) {
      if (roll < weight) return kind;
      roll -= weight;
    }
    return "slow";
  };
  const delay = () => MIN_DELAY_MS + Math.floor(random() * (maxDelay - MIN_DELAY_MS));

  const wrapped = new Map<PropertyKey, unknown>();
  const wrap = (method: string, fn: (...args: unknown[]) => unknown) => {
    const isAsync = fn.constructor.name === "AsyncFunction";
    return function faulty(...args: unknown[]) {
      if (random() >= options.rate) return fn.apply(api, args);
      const kind = pick();
      if (isAsync && (kind === "server" || kind === "network")) {
        record(method, kind);
        return sleep(MIN_DELAY_MS).then(() => Promise.reject(failure(kind, method)));
      }
      const result = fn.apply(api, args);
      if (!isPromise(result)) return result;
      record(method, kind);
      if (kind === "slow") {
        const settled = result.then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        return sleep(delay())
          .then(() => settled)
          .then((outcome) => (outcome.ok ? outcome.value : Promise.reject(outcome.error)));
      }
      result.catch(() => {});
      return sleep(kind === "timeout" ? maxDelay : MIN_DELAY_MS).then(() =>
        Promise.reject(failure(kind, method)),
      );
    };
  };

  return new Proxy(api, {
    get(target, key) {
      // oxlint-disable-next-line anti-slop/no-reflect-get -- a Proxy trap forwards through Reflect
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function" || typeof key === "symbol") return value;
      if (!wrapped.has(key)) wrapped.set(key, wrap(key, value as (...args: unknown[]) => unknown));
      return wrapped.get(key);
    },
  });
}
