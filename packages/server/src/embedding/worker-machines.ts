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

import { hostListing, type WorkerPlacement } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { createHash, randomBytes } from "node:crypto";
import {
  choicesFor,
  type OnDemandChoice,
  type OnDemandChoices,
  type OnDemandHosts,
} from "./on-demand.ts";
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

/** The fields of a worker's own machine an orchestrator picks, by the provider's choice id. */
export const WORKER_MACHINE_PICKS = ["size", "architecture", "isolation", "environment"] as const;
export type WorkerMachinePick = (typeof WORKER_MACHINE_PICKS)[number];

const plain = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * Each pick as the provider's option id, from what an orchestrator wrote: the id itself, or an
 * option's label or short label ("No Internet", "x86", "VM"), case and punctuation aside. A pick
 * the provider offers no option for is refused with the options it offers, so the orchestrator can
 * name one; with no choices offered, each pick goes to the provider as written, which decides.
 */
export const resolveWorkerPicks = (
  offered: ReadonlyArray<OnDemandChoice> | undefined,
  picks: Partial<Record<WorkerMachinePick, string | undefined>>,
):
  | { readonly picks: Partial<Record<WorkerMachinePick, string>> }
  | { readonly refused: string } => {
  const resolved: Partial<Record<WorkerMachinePick, string>> = {};
  for (const key of WORKER_MACHINE_PICKS) {
    const asked = picks[key]?.trim();
    if (asked === undefined || asked === "") continue;
    const choice = offered?.find((each) => each.id === key);
    if (choice === undefined) {
      resolved[key] = asked;
      continue;
    }
    // Every option the person was offered, not only those their own machine may have: a worker's
    // machine has limits of its own, which the provider checks.
    const usable = choice.options;
    const wanted = plain(asked);
    const found =
      usable.find((option) => option.id === asked) ??
      usable.find(
        (option) =>
          plain(option.id) === wanted ||
          plain(option.label) === wanted ||
          (option.short !== undefined && plain(option.short) === wanted),
      );
    if (found === undefined)
      return {
        refused: `${choice.label}: ${asked} isn't offered here. Name one of: ${usable
          .map((option) =>
            option.label === option.id ? option.id : `${option.label} (${option.id})`,
          )
          .join(", ")}.`,
      };
    resolved[key] = found.id;
  }
  return { picks: resolved };
};

/** The provider's answer to a start, or why none came. */
export type StartAnswer =
  | { readonly status: number; readonly body: unknown }
  | { readonly failed: string };

/** Whether an ask's name and picks are ones there are, before anything is sent. */
const askIsWellFormed = (ask: Omit<WorkerMachineAsk, "owner">) =>
  NAME.test(ask.name) &&
  (ask.size === undefined || SHORT.test(ask.size)) &&
  (ask.architecture === undefined || SHORT.test(ask.architecture)) &&
  (ask.isolation === undefined || SHORT.test(ask.isolation)) &&
  (ask.environment === undefined || SHORT.test(ask.environment));

/** An ask's picks as the provider takes them: by choice id, only those named. */
export const choicesOfAsk = (ask: Omit<WorkerMachineAsk, "owner">): Record<string, string> => ({
  ...(ask.size === undefined ? {} : { size: ask.size }),
  ...(ask.architecture === undefined ? {} : { architecture: ask.architecture }),
  ...(ask.isolation === undefined ? {} : { isolation: ask.isolation }),
  ...(ask.environment === undefined ? {} : { environment: ask.environment }),
});

/**
 * A start, from whichever provider is asked (`send`). 409 is over the person's total; 403 or 404
 * is not allowed (the person or their organisation turned it off, or the provider starts none).
 */
export const askWorkerMachine = <R>(
  ask: Omit<WorkerMachineAsk, "owner">,
  send: Effect.Effect<StartAnswer, never, R>,
): Effect.Effect<WorkerMachineStart, never, R> =>
  Effect.gen(function* () {
    if (!askIsWellFormed(ask))
      return {
        kind: "refused",
        message: "That size, processor, kind or environment isn't one there is.",
      } as const;
    const answered = yield* send;
    if ("failed" in answered)
      return {
        kind: "refused",
        message: `The machine couldn't be asked for: ${answered.failed}`,
      } as const;
    const { status, body } = answered;
    if (status === 409) return parseOverTotal(body);
    if (status === 403 || status === 404)
      return {
        kind: "refused",
        message:
          text((body as { message?: unknown } | undefined)?.message, 300) ??
          "Workers' own machines are off here: put the worker on your own machine.",
      } as const;
    if (status < 200 || status >= 300)
      return {
        kind: "refused",
        message: `The machine couldn't be asked for: the server answered ${status}.`,
      } as const;
    return { kind: "started", name: ask.name } as const;
  });

/** Asks the embedder's provider for a worker's own machine (`POST /hosts/start`, `kind: "worker"`). */
export const startWorkerMachine = (hosts: OnDemandHosts, ask: WorkerMachineAsk) =>
  askWorkerMachine(
    ask,
    callOutside("host provider", hosts.provider, {
      method: "POST",
      path: "/hosts/start",
      json: {
        kind: "worker",
        owner: ask.owner,
        name: ask.name,
        options: {
          orchestrator: ask.orchestrator,
          title: ask.title.slice(0, 120),
          choices: choicesOfAsk(ask),
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
      Effect.catch((failure) => Effect.succeed({ failed: failure.message })),
    ),
  );

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

/**
 * What a worker's row shows of where `spawn_worker`'s `sandbox` put it: the machine, whether it
 * shares one, the choices named for it, and the orchestrator's reason.
 */
export const placementOf = (
  machine: string,
  sandbox: {
    readonly shareWith?: string | undefined;
    readonly isolation?: string | undefined;
    readonly architecture?: string | undefined;
    readonly size?: string | undefined;
    readonly environment?: string | undefined;
    readonly reason?: string | undefined;
  },
): WorkerPlacement => {
  const picks = Object.fromEntries(
    (["isolation", "architecture", "size", "environment"] as const).flatMap((id) => {
      const value = sandbox[id];
      return value === undefined ? [] : [[id, value]];
    }),
  );
  const why = sandbox.reason?.trim();
  return {
    machine,
    ...(sandbox.shareWith === undefined ? {} : { shared: true }),
    ...(Object.keys(picks).length === 0 ? {} : { picks }),
    ...(why === undefined || why === "" ? {} : { why }),
  };
};

// ---------------------------------------------------------------------------------------------
/** A joined machine as a provider reads it. */
export interface ProvidedMachine {
  readonly id: string;
  readonly name: string;
  readonly owner?: string | undefined;
  readonly onDemand?: string | undefined;
  readonly via?: string | undefined;
  readonly onlineSince?: number | undefined;
}

/** Why waiting for a machine ended without it. */
export type ArrivalFailed = { readonly failed: string };

/**
 * What `sandbox` asks a worker machine of: the embedder's provider (`worker-machines.ts`), or a
 * hosted server the desktop app is signed in to (here).
 */
export interface WorkerMachineSource {
  /** Where the machines come from, as the orchestrator is told: a server's name. */
  readonly label: string;
  /** The provider's choices for this person, if it offers any. */
  readonly choices: Effect.Effect<OnDemandChoices | undefined>;
  /**
   * The models its machines run, where the provider says: a worker on any other is refused before
   * a machine is asked for. Undefined: it doesn't say, and the machine's host does once it joins.
   */
  readonly models: Effect.Effect<ReadonlyArray<OfferedModel> | undefined>;
  readonly start: (ask: Omit<WorkerMachineAsk, "owner">) => Effect.Effect<WorkerMachineStart>;
  /** Whether a joined machine is one this provider started for this orchestrator's person. */
  readonly theirs: (machine: ProvidedMachine) => boolean;
  /** Waits for the machine asked for to come online here: its id, or why not (`timeout`). */
  readonly arrive: (name: string) => Effect.Effect<string | ArrivalFailed>;
  /**
   * After a machine didn't come in time: what the orchestrator is told, having stopped it there and
   * forgotten it here where this provider does so.
   */
  readonly timedOut: (name: string) => Effect.Effect<string>;
  /**
   * Gives back a machine started for a spawn that was then refused: stopped there and forgotten
   * here, where this provider does so.
   */
  readonly abandon: (name: string) => Effect.Effect<void>;
}

/** A model a provider's machines run, as its choices list it: `opus` running `claude-opus-…`. */
export interface OfferedModel {
  readonly agent: string;
  readonly id: string;
  readonly resolvedId?: string;
  readonly label?: string;
}

const AGENT = /^[a-z][a-z0-9-]{0,23}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\[\]/-]{0,119}$/;
const MAX_MODELS = 32;

/** The `models` of a provider's choices, read field by field. Undefined: it lists none. */
export const parseOfferedModels = (value: unknown): ReadonlyArray<OfferedModel> | undefined => {
  const listed =
    typeof value === "object" && value !== null
      ? (value as { models?: unknown }).models
      : undefined;
  if (!Array.isArray(listed)) return undefined;
  const models: OfferedModel[] = [];
  for (const raw of listed.slice(0, MAX_MODELS)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const agent = entry["agent"];
    const id = entry["id"];
    if (
      typeof agent !== "string" ||
      !AGENT.test(agent) ||
      typeof id !== "string" ||
      !MODEL_ID.test(id)
    )
      continue;
    const resolvedId = entry["resolvedId"];
    const label = text(entry["label"], 60);
    models.push({
      agent,
      id,
      ...(typeof resolvedId === "string" && MODEL_ID.test(resolvedId) ? { resolvedId } : {}),
      ...(label === undefined ? {} : { label }),
    });
  }
  return models.length === 0 ? undefined : models;
};

/**
 * Why a worker on `chosen` can't have a machine from a provider whose machines run `models`, or
 * undefined when it can: the agent and model, by id or the id an alias runs, and never through a
 * gateway profile, which a machine of its own has no key for.
 */
export const modelRefusal = (
  label: string,
  models: ReadonlyArray<OfferedModel>,
  chosen: {
    readonly agent: string;
    readonly model: string;
    readonly profileId?: string | undefined;
  },
): string | undefined => {
  if (
    chosen.profileId === undefined &&
    hostListing(
      models.filter((model) => model.agent === chosen.agent),
      chosen.model,
    ) !== undefined
  )
    return undefined;
  const offered = models
    .map(
      (model) =>
        `${model.agent}:${model.id}${model.label === undefined ? "" : ` (${model.label})`}`,
    )
    .join(", ");
  return `${label}'s worker machines don't run ${chosen.agent}:${chosen.model}${chosen.profileId === undefined ? "" : " through a gateway profile"}, so no machine was asked for. They run ${offered}: name one of them as model, or leave out sandbox and the worker runs on your machine.`;
};

/** The embedder's host provider, for the person whose host the orchestrator is on. */
export const embeddedSource = (
  hosts: OnDemandHosts,
  owner: string,
  machines: () => ReadonlyArray<JoiningMachine>,
): WorkerMachineSource => ({
  label: "This deployment",
  choices: choicesFor(hosts, owner),
  // Its machines' hosts say what they run once they join (`admitMachineModel`).
  models: Effect.succeed(undefined),
  start: (ask) => startWorkerMachine(hosts, { ...ask, owner }),
  theirs: (machine) => machine.onDemand === "worker" && machine.owner === owner,
  arrive: (name) =>
    awaitWorkerMachine(machines, { name, owner }).pipe(
      Effect.map((id) => id ?? { failed: "timeout" }),
    ),
  // The provider keeps it starting: a retry with the same request id waits for that one.
  timedOut: (name) =>
    Effect.succeed(
      `The machine ${name} was asked for but hasn't come online yet. Spawn again with the same clientRequestId in a minute, or put the worker on your machine.`,
    ),
  // Its provider pauses an idle machine and reclaims it once released (`worker-machine-release.ts`).
  abandon: () => Effect.void,
});
