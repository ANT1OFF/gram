// The fences a desktop's late stop or release carries to a hosted server: which
// machine and which run of it the call is for (`sandboxId`, `generation`), as a start or a status
// last named them, and the latest time the server may act on it (`notAfter`). Past either, the
// server does nothing and says so (`superseded`, `expired`), so a call that came late never lands
// on a newer start of its name. A server from before fences ignores them on a stop.

import * as Effect from "effect/Effect";
import type { WorkerMachinePortShape } from "./signed-in-port.ts";

/** One run of a machine there, as `…/start` (202) and `…/status` (200) name it. */
export interface MachineRun {
  readonly sandboxId: string;
  readonly generation: number;
}

/** A sandbox id as the server makes them: an opaque id of letters, digits and `_ . : -`. */
const SANDBOX_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** The run an answer names, read field by field; undefined where it names none. */
export const runOf = (body: unknown): MachineRun | undefined => {
  if (typeof body !== "object" || body === null) return undefined;
  const { sandboxId, generation } = body as { sandboxId?: unknown; generation?: unknown };
  return typeof sandboxId === "string" &&
    SANDBOX_ID.test(sandboxId) &&
    typeof generation === "number" &&
    Number.isSafeInteger(generation) &&
    generation >= 1
    ? { sandboxId, generation }
    : undefined;
};

/**
 * Why a fenced call did nothing there, from its 2xx answer's `code`: it came after its `notAfter`
 * (`expired`), or the name is now another machine or another run of it (`superseded`).
 */
export const fenceRefusalOf = (
  answered:
    | { readonly ok: true; readonly status: number; readonly body: unknown }
    | { readonly ok: false },
): "expired" | "superseded" | undefined => {
  if (!answered.ok || answered.status >= 300) return undefined;
  const code =
    typeof answered.body === "object" && answered.body !== null
      ? (answered.body as { code?: unknown }).code
      : undefined;
  return code === "expired" || code === "superseded" ? code : undefined;
};

/**
 * How long after it is asked a release may still act there: the app's call (45 s) and the
 * server's wait for the person's lock (10 s), with a little to spare. Later, it does nothing, and
 * the next pass tells it again.
 */
export const RELEASE_ACTS_WITHIN_MS = 60_000;

/** The most runs kept: one per machine name a server named lately. */
const RUNS_MOST = 512;

/**
 * `port` whose stops and releases carry the run their name was last known to be, and which keeps
 * the run each start and status names. A run is known by server, name and sign-in: what one
 * sign-in was told is never another's. One said `superseded` is forgotten, so the call is asked
 * again with its `notAfter` alone, held to the run the name is now; one stopped is forgotten too.
 * After a restart none is known until a start or a status names it.
 */
export const fencedCalls = (port: WorkerMachinePortShape): WorkerMachinePortShape => {
  const runs = new Map<string, MachineRun>();
  return {
    ...port,
    call: (origin, call, body, options) => {
      const name = body["name"];
      if (typeof name !== "string") return port.call(origin, call, body, options);
      const key = JSON.stringify([origin, name, options?.account ?? null]);
      const run = call === "stop" || call === "release" ? runs.get(key) : undefined;
      const sent = run === undefined ? body : { ...body, ...run };
      return port.call(origin, call, sent, options).pipe(
        Effect.tap((answered) =>
          Effect.sync(() => {
            if (!answered.ok) return;
            if (
              (call === "start" && answered.status === 202) ||
              (call === "status" && answered.status === 200)
            ) {
              const named = runOf(answered.body);
              if (named === undefined) return;
              runs.delete(key);
              runs.set(key, named);
              if (runs.size > RUNS_MOST) runs.delete(runs.keys().next().value!);
              return;
            }
            const refused = fenceRefusalOf(answered);
            // The run it named is no more: forgotten, unless a newer one was told meanwhile.
            if (refused === "superseded" && run !== undefined && runs.get(key) === run)
              runs.delete(key);
            const stopped =
              call === "stop" &&
              answered.status < 300 &&
              refused === undefined &&
              (answered.body as { stopped?: unknown } | null)?.stopped === true;
            if (stopped && runs.get(key) === run) runs.delete(key);
          }),
        ),
      );
    },
  };
};
