import * as Effect from "effect/Effect";
import { randomBytes } from "node:crypto";
import type { OnDemandHosts } from "./on-demand.ts";
import { callOutside } from "./outside.ts";

/**
 * Who is on a worker's machine, as its provider keeps it (docs/EMBEDDING.md, "Several workers on
 * one machine"). A provider that says how many workers a machine of each size is for (`sharing` in
 * its choices) takes these calls, and holds a machine to rules this Gram alone could get wrong:
 * its cap, one orchestrator, one environment, and never a machine started as exclusive. It also
 * keeps a machine while a worker is still on it. A provider that says nothing takes none of them,
 * and this Gram's own cap is all there is.
 */

/** How a machine may be shared, as its start says it. */
export type MachineSharing = "own" | "exclusive" | "shared";
const SHARINGS: ReadonlySet<string> = new Set(["own", "exclusive", "shared"]);

const SHORT = /^[a-z0-9][a-z0-9-]{0,39}$/;
const NAME = /^worker-[a-z0-9]{8,16}$/;
const SEAT = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const MAX_SEATS = 64;
const MAX_MACHINES = 64;

/**
 * A release a provider held back: it still holds seats on the machine, so the machine is kept. Not
 * a failure to tell: the seats of workers whose work is over are given up, and it is told again
 * (`worker-seat-upkeep.ts`).
 */
export class ReleaseOccupied extends Error {
  constructor() {
    super("the server still holds workers' seats on it");
  }
}

/** Whether a release's answer says the machine was kept for the seats on it. */
export const releaseOccupied = (body: unknown): boolean =>
  typeof body === "object" &&
  body !== null &&
  (body as { applied?: unknown }).applied === false &&
  (body as { code?: unknown }).code === "occupied";

/** A new seat: what a provider knows one worker by on its machine. Opaque there. */
export const newSeat = (): string => randomBytes(8).toString("hex");

export const isSeat = (value: unknown): value is string =>
  typeof value === "string" && SEAT.test(value);

/** What is asked of a machine's seats: one to take, some to give up, or neither (a read). */
export interface WorkerSeatsAsk {
  readonly name: string;
  /** The orchestrator that places the worker; needed to take a seat. */
  readonly orchestrator?: string | undefined;
  readonly attach?:
    | {
        readonly worker: string;
        /** The environment the worker is meant for, when its spawn named one. */
        readonly environment?: string | undefined;
      }
    | undefined;
  readonly detach?: ReadonlyArray<string> | undefined;
}

/** Why a provider gave a worker no seat. `other`: a refusal this Gram has no word for. */
export type SeatRefusal =
  | "machine_full"
  | "exclusive"
  | "other_orchestrator"
  | "environment_mismatch"
  | "released"
  | "other";
const REFUSALS: ReadonlySet<string> = new Set([
  "machine_full",
  "exclusive",
  "other_orchestrator",
  "environment_mismatch",
  "released",
]);

/**
 * How an ask about a machine's seats came out. `none`: the provider keeps no seats, or knows no
 * such machine, so nothing was taken or given up. `unknown`: no answer, or one that says nothing,
 * so whether a seat was taken isn't known.
 */
export type WorkerSeats =
  | {
      readonly kind: "seats";
      readonly workers: ReadonlyArray<string>;
      readonly cap?: number;
      readonly size?: string;
      readonly mode?: MachineSharing;
    }
  | {
      readonly kind: "refused";
      readonly code: SeatRefusal;
      readonly message: string;
      readonly cap?: number;
      readonly workers?: ReadonlyArray<string>;
    }
  | { readonly kind: "none" }
  | { readonly kind: "unknown"; readonly message: string };

const text = (value: unknown, max: number) =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/[\0\n\r]/.test(value)
    ? value
    : undefined;

const seatsIn = (value: unknown): ReadonlyArray<string> | undefined =>
  Array.isArray(value) ? value.slice(0, MAX_SEATS).filter(isSeat) : undefined;

const capIn = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_SEATS
    ? value
    : undefined;

const sharingIn = (value: unknown): MachineSharing | undefined =>
  typeof value === "string" && SHARINGS.has(value) ? (value as MachineSharing) : undefined;

/** A provider's answer about a machine's seats, read field by field. */
export const parseSeatsAnswer = (status: number, body: unknown): WorkerSeats => {
  const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const workers = seatsIn(fields["workers"]);
  const cap = capIn(fields["cap"]);
  if (status >= 200 && status < 300 && workers !== undefined) {
    const size = fields["size"];
    const mode = sharingIn(fields["mode"]);
    return {
      kind: "seats",
      workers,
      ...(cap === undefined ? {} : { cap }),
      ...(typeof size === "string" && SHORT.test(size) ? { size } : {}),
      ...(mode === undefined ? {} : { mode }),
    };
  }
  if (status === 404 || status === 501) return { kind: "none" };
  if (status === 409) {
    const code = fields["code"];
    return {
      kind: "refused",
      code: typeof code === "string" && REFUSALS.has(code) ? (code as SeatRefusal) : "other",
      message: text(fields["message"], 300) ?? "The machine takes no more workers.",
      ...(cap === undefined ? {} : { cap }),
      ...(workers === undefined ? {} : { workers }),
    };
  }
  if (status >= 400 && status < 500)
    return {
      kind: "refused",
      code: "other",
      message: text(fields["message"], 300) ?? `The server answered ${status}.`,
    };
  return { kind: "unknown", message: `The server answered ${status}.` };
};

const seatsAreWellFormed = (ask: WorkerSeatsAsk) =>
  NAME.test(ask.name) &&
  (ask.attach === undefined ||
    (isSeat(ask.attach.worker) &&
      (ask.attach.environment === undefined || text(ask.attach.environment, 64) !== undefined))) &&
  (ask.detach ?? []).every(isSeat) &&
  (ask.detach ?? []).length <= MAX_SEATS;

/** The body an ask about seats is sent with, from either provider. */
export const seatsBody = (ask: WorkerSeatsAsk): Record<string, unknown> => ({
  name: ask.name,
  ...(ask.orchestrator === undefined ? {} : { orchestrator: ask.orchestrator.slice(0, 200) }),
  ...(ask.attach === undefined
    ? {}
    : {
        attach: {
          worker: ask.attach.worker,
          ...(ask.attach.environment === undefined ? {} : { environment: ask.attach.environment }),
        },
      }),
  ...(ask.detach === undefined || ask.detach.length === 0 ? {} : { detach: [...ask.detach] }),
});

/** A provider's answer to a call, or why none came. */
export type SeatsAnswer =
  | { readonly status: number; readonly body: unknown }
  | { readonly failed: string };

/** Asks a provider about a machine's seats (`send`), or refuses an ask that isn't well formed. */
export const askSeats = <R>(
  ask: WorkerSeatsAsk,
  send: Effect.Effect<SeatsAnswer, never, R>,
): Effect.Effect<WorkerSeats, never, R> =>
  seatsAreWellFormed(ask)
    ? Effect.map(send, (answered) =>
        "failed" in answered
          ? { kind: "unknown" as const, message: answered.failed }
          : parseSeatsAnswer(answered.status, answered.body),
      )
    : Effect.succeed({
        kind: "refused" as const,
        code: "other" as const,
        message: "That isn't a machine or a worker to place.",
      });

const answerOf = (response: Response) =>
  Effect.promise(() =>
    response
      .json()
      .catch(() => undefined)
      .then((body: unknown) => ({ status: response.status, body })),
  );

/** Asks the embedder's provider about a machine's seats (`POST /hosts/workers`). */
export const seatsOnMachine = (hosts: OnDemandHosts, owner: string, ask: WorkerSeatsAsk) =>
  askSeats(
    ask,
    callOutside("host provider", hosts.provider, {
      method: "POST",
      path: "/hosts/workers",
      json: { kind: "worker", owner, ...seatsBody(ask) },
      accept: [400, 403, 404, 409, 501, 503],
      timeoutMs: 15_000,
    }).pipe(
      Effect.flatMap(answerOf),
      Effect.catch((failure) => Effect.succeed({ failed: failure.message })),
    ),
  );

/** A worker's machine as its provider describes it, with who it says is on it. */
export interface ProvidedWorkerMachine {
  readonly name: string;
  readonly size?: string;
  /** The size it holds now, when that is more than it started at. */
  readonly held?: string;
  readonly architecture?: string;
  readonly isolation?: string;
  readonly environment?: string;
  readonly running: boolean;
  readonly mode?: MachineSharing;
  /** The orchestrator it was started for. */
  readonly orchestrator?: string;
  readonly cap?: number;
  readonly workers: ReadonlyArray<string>;
  /** What it uses now, where the provider measures it. */
  readonly usage?: { readonly cpu: number; readonly memoryGb: number };
}

const amount = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** A provider's list of a person's worker machines, read field by field. Undefined: it lists none. */
export const parseProvidedMachines = (
  status: number,
  body: unknown,
): ReadonlyArray<ProvidedWorkerMachine> | undefined => {
  if (status < 200 || status >= 300 || typeof body !== "object" || body === null) return undefined;
  const listed = (body as { machines?: unknown }).machines;
  if (!Array.isArray(listed)) return undefined;
  const machines: ProvidedWorkerMachine[] = [];
  for (const raw of listed.slice(0, MAX_MACHINES)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const name = entry["name"];
    if (typeof name !== "string" || !NAME.test(name)) continue;
    const short = (key: string) => {
      const value = entry[key];
      return typeof value === "string" && SHORT.test(value) ? value : undefined;
    };
    const size = short("size");
    const held = short("held");
    const architecture = short("architecture");
    const isolation = short("isolation");
    const environment = text(entry["environment"], 64);
    const mode = sharingIn(entry["mode"]);
    const orchestrator = text(entry["orchestrator"], 200);
    const cap = capIn(entry["cap"]);
    const usage =
      typeof entry["usage"] === "object" && entry["usage"] !== null
        ? (entry["usage"] as Record<string, unknown>)
        : {};
    const cpu = amount(usage["cpu"]);
    const memoryGb = amount(usage["memoryGb"]);
    machines.push({
      name,
      ...(size === undefined ? {} : { size }),
      ...(held === undefined ? {} : { held }),
      ...(architecture === undefined ? {} : { architecture }),
      ...(isolation === undefined ? {} : { isolation }),
      ...(environment === undefined ? {} : { environment }),
      running: entry["running"] === true,
      ...(mode === undefined ? {} : { mode }),
      ...(orchestrator === undefined ? {} : { orchestrator }),
      ...(cap === undefined ? {} : { cap }),
      workers: seatsIn(entry["workers"]) ?? [],
      ...(cpu === undefined || memoryGb === undefined ? {} : { usage: { cpu, memoryGb } }),
    });
  }
  return machines;
};

/** Asks the embedder's provider for a person's worker machines (`POST /hosts/machines`). */
export const providedMachines = (hosts: OnDemandHosts, owner: string) =>
  callOutside("host provider", hosts.provider, {
    method: "POST",
    path: "/hosts/machines",
    json: { kind: "worker", owner },
    accept: [400, 403, 404, 501, 503],
    timeoutMs: 15_000,
  }).pipe(
    Effect.flatMap(answerOf),
    Effect.map(({ status, body }) => parseProvidedMachines(status, body)),
    Effect.catch(() => Effect.succeed(undefined)),
  );
