import { fieldsOf } from "@gram/contracts";
import * as Effect from "effect/Effect";
import type { MachineRun, WorkerMachinePortShape } from "./signed-in-port.ts";

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
      ? fieldsOf(answered.body).get("code")
      : undefined;
  return code === "expired" || code === "superseded" ? code : undefined;
};

/**
 * How long after it is asked a release may still act there: the app's call (45 s) and the
 * server's wait for the person's lock (10 s), with a little to spare. Later, it does nothing, and
 * the next pass tells it again.
 */
export const RELEASE_ACTS_WITHIN_MS = 60_000;

/** Whether two runs, either of them none (`null` or undefined), are the same one. */
export const sameRun = (a: MachineRun | null | undefined, b: MachineRun | null | undefined) =>
  a === undefined || a === null
    ? b === undefined || b === null
    : b !== undefined && b !== null && a.sandboxId === b.sandboxId && a.generation === b.generation;

/** The answer a call given a run (`run`) gets here, unsent, once its name is known as another. */
export const SUPERSEDED_HERE = { ok: true, status: 200, body: { code: "superseded" } } as const;

const keyOf = (origin: string, name: string, account: string | undefined) =>
  JSON.stringify([origin, name, account ?? null]);

const RUNS_MOST = 512;

/**
 * `port` whose stops and releases carry the run their name was last known to be, and which keeps
 * the run each start and status names. A run is known by server, name and sign-in: what one
 * sign-in was told is never another's. One said `superseded` is forgotten, so the call is asked
 * again with its `notAfter` alone, held to the run the name is now; one stopped is forgotten too.
 * After a restart none is known until a start or a status names it. A call given its run (`run`,
 * a release's as it was decided) carries that one on every ask, and goes only while its name is
 * still known as that run: otherwise it is answered `superseded` here (`SUPERSEDED_HERE`) and
 * never sent, so it never lands on a newer run. A stop or a release answered `expired` is logged:
 * a clock here behind the server's would have every one so.
 */
export const fencedCalls = (port: WorkerMachinePortShape): WorkerMachinePortShape => {
  const runs = new Map<string, MachineRun>();
  return {
    ...port,
    knownRun: (origin, name, account) => runs.get(keyOf(origin, name, account)) ?? null,
    call: (origin, call, body, options) => {
      const name = body["name"];
      if (typeof name !== "string") return port.call(origin, call, body, options);
      const key = keyOf(origin, name, options?.account);
      const fenced = call === "stop" || call === "release" || call === "move";
      const pinned = fenced ? options?.run : undefined;
      if (pinned !== undefined && !sameRun(runs.get(key), pinned))
        return Effect.succeed(SUPERSEDED_HERE);
      const run = !fenced
        ? undefined
        : pinned !== undefined
          ? (pinned ?? undefined)
          : runs.get(key);
      const sent = run === undefined ? body : { ...body, ...run };
      return port.call(origin, call, sent, options).pipe(
        Effect.tap((answered) => {
          if (!answered.ok) return Effect.void;
          if (
            (call === "start" && answered.status === 202) ||
            (call === "status" && answered.status === 200)
          ) {
            const named = runOf(answered.body);
            if (named === undefined) return Effect.void;
            runs.delete(key);
            runs.set(key, named);
            if (runs.size > RUNS_MOST) runs.delete(runs.keys().next().value!);
            return Effect.void;
          }
          const refused = fenceRefusalOf(answered);
          if (refused === "superseded" && run !== undefined && sameRun(runs.get(key), run))
            runs.delete(key);
          const said = fieldsOf(answered.body);
          const stopped =
            answered.status < 300 &&
            refused === undefined &&
            ((call === "stop" && said.get("stopped") === true) ||
              (call === "move" && said.get("moved") === true));
          if (stopped && sameRun(runs.get(key), run)) runs.delete(key);
          return fenced && refused === "expired"
            ? Effect.logWarning(
                "a worker machine's call came after its time there: this machine's clock may be behind the server's",
              ).pipe(Effect.annotateLogs({ machine: name, call }))
            : Effect.void;
        }),
      );
    },
  };
};
