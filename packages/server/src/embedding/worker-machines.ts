// Machines an orchestrator starts for its own workers, through the embedder's host provider.
//
// A headless Gram runs no work itself: an orchestrator's workers go on its own machine, the
// person's own (`on-demand.ts`). Where the provider offers it, an orchestrator may instead ask for
// a machine of a worker's own, with the size and processor the work needs, so a heavy build or a
// test suite on the other processor doesn't crowd the person's machine. The provider decides:
// whether that person allows it, how much their orchestrators may hold at once, and what each
// machine may be. Over that total nothing starts, and the orchestrator is told what is in use, so
// it can wait, put the worker on a machine it already has, or run it on its own.
//
// The provider registers the machine here (`/machines/provision`) under the name asked for, with
// the person as its owner and `onDemand: "worker"`. Only that person's orchestrators place work on
// it (`orchestration/service/spawning.ts` `workerMachine`), and it is never anyone's default.

import * as Effect from "effect/Effect";
import { createHash, randomBytes } from "node:crypto";
import type { OnDemandHosts } from "./on-demand.ts";
import { callOutside } from "./outside.ts";

/** What an orchestrator asks of a worker's own machine. Short ids, as the provider offers them. */
export interface WorkerMachineAsk {
  /** The person whose orchestrator asks: the machine is theirs. */
  readonly owner: string;
  /** The name it registers under, which the worker is then placed on. */
  readonly name: string;
  /** The orchestrator thread, for the provider's record. */
  readonly orchestrator: string;
  /** The worker's title, for the provider's record and its machine's label. */
  readonly title: string;
  readonly size?: string | undefined;
  readonly architecture?: string | undefined;
  /** How strongly it is kept from other machines, by the provider's id for it (a VM, say). */
  readonly isolation?: string | undefined;
  /** What the machine installs, sets and may reach as it starts, by the provider's id for it. */
  readonly environment?: string | undefined;
}

/** A machine an orchestrator already has for its workers, as the provider reports it. */
export interface WorkerMachineHeld {
  readonly name: string;
  readonly size?: string;
  readonly architecture?: string;
  readonly running: boolean;
}

/** CPU and memory, as the provider counts them. */
export interface Resources {
  readonly cpu: number;
  readonly memoryGb: number;
}

export type WorkerMachineStart =
  | { readonly kind: "started"; readonly name: string }
  | {
      readonly kind: "over-total";
      readonly message: string;
      readonly asked?: Resources;
      readonly inUse?: Resources;
      readonly total?: Resources;
      readonly machines: ReadonlyArray<WorkerMachineHeld>;
    }
  | { readonly kind: "refused"; readonly message: string };

const SHORT = /^[a-z0-9][a-z0-9-]{0,39}$/;
const NAME = /^worker-[a-z0-9]{8,16}$/;

/**
 * The name a worker's machine registers under. With a request id, the same for a retry of the same
 * spawn, so a retry finds the machine its first try asked for instead of asking for another.
 */
export const workerMachineName = (orchestrator: string, clientRequestId?: string): string =>
  `worker-${
    clientRequestId === undefined
      ? randomBytes(5).toString("hex")
      : createHash("sha256")
          .update(`${orchestrator}\n${clientRequestId}`)
          .digest("hex")
          .slice(0, 10)
  }`;

export const isWorkerMachineName = (name: string) => NAME.test(name);

const text = (value: unknown, max: number) =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/[\0\n\r]/.test(value)
    ? value
    : undefined;

const resources = (value: unknown): Resources | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const { cpu, memoryGb } = value as Record<string, unknown>;
  return typeof cpu === "number" &&
    Number.isFinite(cpu) &&
    cpu >= 0 &&
    typeof memoryGb === "number" &&
    Number.isFinite(memoryGb) &&
    memoryGb >= 0
    ? { cpu, memoryGb }
    : undefined;
};

/** The provider's answer when the ask would go over the person's total, read field by field. */
export const parseOverTotal = (
  value: unknown,
): Extract<WorkerMachineStart, { kind: "over-total" }> => {
  const body =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const asked = resources(body["asked"]);
  const inUse = resources(body["inUse"]);
  const total = resources(body["total"]);
  const listed = Array.isArray(body["machines"]) ? body["machines"].slice(0, 32) : [];
  const machines: WorkerMachineHeld[] = [];
  for (const raw of listed) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const name = entry["name"];
    if (typeof name !== "string" || !NAME.test(name)) continue;
    const size = entry["size"];
    const architecture = entry["architecture"];
    machines.push({
      name,
      ...(typeof size === "string" && SHORT.test(size) ? { size } : {}),
      ...(typeof architecture === "string" && SHORT.test(architecture) ? { architecture } : {}),
      running: entry["running"] === true,
    });
  }
  return {
    kind: "over-total",
    message:
      text(body["message"], 300) ??
      "That would take your workers' machines past the total you allow them.",
    ...(asked === undefined ? {} : { asked }),
    ...(inUse === undefined ? {} : { inUse }),
    ...(total === undefined ? {} : { total }),
    machines,
  };
};

/**
 * Asks the provider for a worker's own machine (`POST /hosts/start`, `kind: "worker"`). 409 is
 * over the person's total; 403 or 404 is not allowed (the person or their organisation turned it
 * off, or the provider starts none).
 */
export const startWorkerMachine = (hosts: OnDemandHosts, ask: WorkerMachineAsk) =>
  Effect.gen(function* () {
    if (
      !NAME.test(ask.name) ||
      (ask.size !== undefined && !SHORT.test(ask.size)) ||
      (ask.architecture !== undefined && !SHORT.test(ask.architecture)) ||
      (ask.isolation !== undefined && !SHORT.test(ask.isolation)) ||
      (ask.environment !== undefined && !SHORT.test(ask.environment))
    )
      return {
        kind: "refused",
        message: "That size, processor, kind or environment isn't one there is.",
      } as const;
    const answered = yield* callOutside("host provider", hosts.provider, {
      method: "POST",
      path: "/hosts/start",
      json: {
        kind: "worker",
        owner: ask.owner,
        name: ask.name,
        options: {
          orchestrator: ask.orchestrator,
          title: ask.title.slice(0, 120),
          choices: {
            ...(ask.size === undefined ? {} : { size: ask.size }),
            ...(ask.architecture === undefined ? {} : { architecture: ask.architecture }),
            ...(ask.isolation === undefined ? {} : { isolation: ask.isolation }),
            ...(ask.environment === undefined ? {} : { environment: ask.environment }),
          },
        },
      },
      accept: [403, 404, 409],
      timeoutMs: 15_000,
    }).pipe(
      Effect.flatMap((response) =>
        Effect.promise(() =>
          response
            .json()
            .catch(() => undefined)
            .then((body: unknown) => ({ status: response.status, body })),
        ),
      ),
      Effect.result,
    );
    if (answered._tag === "Failure")
      return {
        kind: "refused",
        message: `The machine couldn't be asked for: ${answered.failure.message}`,
      } as const;
    const { status, body } = answered.success;
    if (status === 409) return parseOverTotal(body);
    if (status === 403 || status === 404)
      return {
        kind: "refused",
        message:
          text((body as { message?: unknown } | undefined)?.message, 300) ??
          "Workers' own machines are off here: put the worker on your own machine.",
      } as const;
    return { kind: "started", name: ask.name } as const;
  });

/** A joined machine as waiting for a worker's own reads it. */
export interface JoiningMachine {
  readonly id: string;
  readonly name: string;
  readonly owner?: string | undefined;
  readonly onDemand?: string | undefined;
  readonly onlineSince?: number | undefined;
}

/**
 * Waits for the machine asked for to join and come online, as its owner's worker machine. The id,
 * or undefined once `timeoutMs` has passed.
 */
export const awaitWorkerMachine = (
  machines: () => ReadonlyArray<JoiningMachine>,
  wanted: { readonly name: string; readonly owner: string },
  options: { readonly timeoutMs?: number; readonly everyMs?: number } = {},
) =>
  Effect.gen(function* () {
    const deadline = Date.now() + (options.timeoutMs ?? 5 * 60_000);
    for (;;) {
      const found = machines().find(
        (machine) =>
          machine.name === wanted.name &&
          machine.owner === wanted.owner &&
          machine.onDemand === "worker" &&
          machine.onlineSince !== undefined,
      );
      if (found !== undefined) return found.id;
      if (Date.now() >= deadline) return undefined;
      yield* Effect.sleep(options.everyMs ?? 2_000);
    }
  });

const amount = (r: Resources | undefined) =>
  r === undefined ? undefined : `${r.cpu} CPU · ${r.memoryGb} GB`;

/** What an orchestrator is told when a worker's machine would go over the total. */
export const overTotalWords = (
  over: Extract<WorkerMachineStart, { kind: "over-total" }>,
  workersOn: (machine: string) => ReadonlyArray<string>,
): string => {
  const lines = [
    over.message,
    ...(over.inUse && over.total
      ? [`In use: ${amount(over.inUse)} of ${amount(over.total)}.`]
      : []),
    ...(over.asked ? [`This one asks ${amount(over.asked)}.`] : []),
  ];
  if (over.machines.length > 0) {
    lines.push("Your workers' machines:");
    for (const machine of over.machines) {
      const on = workersOn(machine.name);
      lines.push(
        `- ${machine.name}: ${[machine.size, machine.architecture].filter(Boolean).join(", ") || "?"}, ${machine.running ? "running" : "paused"}${on.length === 0 ? ", no live worker" : `, ${on.join("; ")}`}`,
      );
    }
  }
  lines.push(
    'Decide: wait for room (schedule_wake with condition threadFinished on a worker, then spawn again); put it on one of these machines (sandbox: {"shareWith": "<machine or threadId>"}); run it on your own machine (sandbox: {"own": false}); or ask for a smaller size.',
  );
  return lines.join("\n");
};
