import type { AgentHost } from "@gram/agents";
import { CLAUDE_CAPABILITIES } from "@gram/agents/claude";
import { CODEX_CAPABILITIES } from "@gram/agents/codex";
import { ANTIGRAVITY_CAPABILITIES } from "@gram/agents/antigravity";
import { GROK_CAPABILITIES } from "@gram/agents/grok";
import { OPENCODE_CAPABILITIES } from "@gram/agents/opencode";
import {
  type AgentKind,
  type AgentModel,
  AgentUnavailable,
  type CheckoutRequest,
  checkoutRequestHost,
  embeddingOn,
  type HostId,
  InvalidState,
  NO_MACHINE_RUNNING,
} from "@gram/contracts";
import { WorktreeError } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ServerConfig } from "../config.ts";
import { Embedding } from "../embedding/embedding.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { callerPerson, NOT_YOUR_MACHINE, ownersOf } from "./ownership.ts";
import { RemoteHosts, type RemoteHostsShape } from "./remote-hosts.ts";
import type { WorkerHost } from "./worker-host.ts";

/** `GRAM_HEADLESS=1` with the hosted features off: the server doesn't start. */
export const HEADLESS_NEEDS_HOSTED =
  "GRAM_HEADLESS=1 is one of the hosted features, which are off. Start the server with GRAM_EMBEDDING=1 as well.";

/** What anything that would run on this machine is told. */
export const RUNS_NOTHING_HERE =
  "This Gram is a headless control plane and runs no work itself. Work runs on a joined machine.";

/** With no machine joined, nothing can run at all. */
export const NO_MACHINE_JOINED =
  "No machine has joined this Gram yet, and it runs no work itself. Join one under Settings → Machines.";

/** A machine as placement reads it, out of `RemoteHosts.list`. */
export interface PlaceableMachine {
  readonly id: HostId;
  readonly name: string;
  readonly confirmed: boolean;
  readonly joinedAt: number;
  readonly onlineSince?: number | undefined;
  readonly models?: ReadonlyArray<AgentModel> | undefined;
  /** When it last said what it can run, while online: absent until its first check answers. */
  readonly claudeSignInCheckedAt?: number | undefined;
  /** Its Codex, from a host that runs Codex sessions (`HostStatus.codex`). */
  readonly codex?: MachineCodex | undefined;
  /** Its OpenCode, from a host that runs OpenCode sessions (`HostStatus.opencode`). */
  readonly opencode?: MachineOpenCode | undefined;
  /** Its Grok Build, from a host that runs Grok Build sessions (`HostStatus.grok`). */
  readonly grok?: MachineOpenCode | undefined;
  /** Its Antigravity, from a host that runs Antigravity sessions (`HostStatus.antigravity`). */
  readonly antigravity?: MachineOpenCode | undefined;
  /** A host an embedder started on demand for one person (`embedding/on-demand.ts`). */
  readonly owner?: string | undefined;
  readonly onDemand?: "personal" | "thread" | "worker" | undefined;
}

/** A machine's Codex as placement reads it. */
export interface MachineCodex {
  readonly found: boolean;
  readonly signIn: "signedIn" | "notSignedIn" | "apiKey" | "unknown";
  readonly models?: ReadonlyArray<AgentModel> | undefined;
  readonly gateReady: boolean;
  readonly autoReview: boolean;
}

/** A machine's OpenCode as placement reads it. */
export interface MachineOpenCode {
  readonly found: boolean;
  readonly models?: ReadonlyArray<AgentModel> | undefined;
}

/** The agents a headless Gram offers as its machines run them. */
export type MachineAgent = "claude" | "codex" | "opencode" | "grok" | "antigravity";

const listOf = (machine: PlaceableMachine, agent: MachineAgent) =>
  agent === "claude"
    ? machine.models
    : agent === "codex"
      ? machine.codex?.models
      : agent === "opencode"
        ? machine.opencode?.models
        : agent === "grok"
          ? machine.grok?.models
          : machine.antigravity?.models;

const notListing = (machine: PlaceableMachine, agent: MachineAgent): string => {
  if (agent === "claude")
    return `${machine.name} hasn't said which models its Claude Code offers yet.`;
  if (agent === "grok" || agent === "antigravity") {
    const [cli, name, signIn] =
      agent === "grok"
        ? [machine.grok, "Grok Build", "Run `grok login` there"]
        : [machine.antigravity, "Antigravity", "Run `agy` there and sign in"];
    if (cli === undefined)
      return `${machine.name} hasn't said which models its ${name} offers yet. If its Gram is older than this one, update it there (Settings → Machines).`;
    if (!cli.found)
      return `${name} isn't installed on ${machine.name}. Install it there, then re-check.`;
    return `${machine.name}'s ${name} couldn't list its models. ${signIn}, then re-check.`;
  }
  if (agent === "opencode") {
    const opencode = machine.opencode;
    if (opencode === undefined)
      return `${machine.name} hasn't said which models its OpenCode offers yet. If its Gram is older than this one, update it there (Settings → Machines).`;
    if (!opencode.found)
      return `OpenCode isn't installed on ${machine.name}. Install it there, then re-check.`;
    return `${machine.name}'s OpenCode couldn't list its models. Check its providers there, then re-check.`;
  }
  const codex = machine.codex;
  if (codex === undefined)
    return `${machine.name} hasn't said which models its Codex offers yet. If its Gram is older than this one, update it there (Settings → Machines).`;
  if (!codex.found)
    return `Codex isn't installed on ${machine.name}. Install it there, then re-check.`;
  if (codex.signIn === "notSignedIn")
    return `Codex isn't signed in on ${machine.name}. Run \`codex login\` there with your ChatGPT account.`;
  return `${machine.name}'s Codex couldn't list its models. Check it there, then re-check.`;
};

/** With hosts provisioned on demand, a person with no machine of their own can start one. */
export const START_A_MACHINE = `${NO_MACHINE_RUNNING}, and this Gram runs no work itself. Start a machine to run this.`;

/**
 * The machine a thread goes on when its request names none: the confirmed machine online now that
 * joined first, so the same one is chosen every time while it stays up. The reason when there is
 * none: nothing has joined, or what has is offline.
 */
export const defaultMachine = (
  machines: ReadonlyArray<PlaceableMachine>,
): { readonly id: HostId } | { readonly error: string } => {
  const confirmed = machines.filter(
    (machine) => machine.confirmed && machine.owner === undefined && machine.onDemand === undefined,
  );
  const online = confirmed
    .filter((machine) => machine.onlineSince !== undefined)
    .toSorted((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id));
  if (online[0] !== undefined) return { id: online[0].id };
  if (confirmed.length === 0) return { error: NO_MACHINE_JOINED };
  const names = confirmed.map((machine) => machine.name);
  return {
    error: `${names.length === 1 ? `${names[0]} is` : `${names.join(", ")} are`} offline, and this Gram runs no work itself. Work starts once a joined machine is back.`,
  };
};

/** Where a headless Gram places what names no machine. */
export interface HeadlessPlacement {
  /**
   * The machine a new thread goes on, or why none can take it: the acting person's own machine
   * when an embedder started one for them, else the default one (`defaultMachine`).
   */
  readonly machine: Effect.Effect<HostId, InvalidState>;
  /** The person a host was started for, when it was started for one. */
  readonly ownerOf: (hostId: HostId) => string | undefined;
}

/**
 * The machine for `person` (absent without fronted sign-in): their own on-demand machine that is
 * online, else the default one. Where hosts are provisioned on demand, a signed-in person's work
 * goes on their own machine alone: with none running, the reason says they can start one, and it
 * is never put on a machine started for someone or something else.
 */
export const machineFor = (
  machines: ReadonlyArray<PlaceableMachine>,
  person: string | undefined,
  onDemand: boolean,
): { readonly id: HostId } | { readonly error: string } => {
  if (person !== undefined) {
    const own = machines
      .filter(
        (machine) =>
          machine.owner === person &&
          machine.onDemand === "personal" &&
          machine.confirmed &&
          machine.onlineSince !== undefined,
      )
      .toSorted((a, b) => (b.onlineSince ?? 0) - (a.onlineSince ?? 0))[0];
    if (own !== undefined) return { id: own.id };
    if (onDemand) return { error: START_A_MACHINE };
  }
  return defaultMachine(machines);
};

/** Placement over the machines joined now; with no way for a machine to join, there is none. */
export const headlessPlacement = (
  remote: Pick<RemoteHostsShape, "list"> | undefined,
  onDemand = false,
): HeadlessPlacement => ({
  machine: Effect.gen(function* () {
    const person = yield* callerPerson;
    const picked = machineFor(remote?.list() ?? [], person, onDemand);
    return "error" in picked
      ? yield* Effect.fail(new InvalidState({ message: picked.error }))
      : picked.id;
  }),
  ownerOf: ownersOf(remote === undefined ? undefined : { list: () => remote.list() }),
});

export { NOT_YOUR_MACHINE };

/**
 * `request` as a headless Gram places it: on the machine it names, else on the default one. An
 * existing worktree is a folder of this machine, where nothing runs, so it is refused. A machine
 * started on demand for one person takes only that person's work.
 */
export const placeRequest = (
  placement: HeadlessPlacement,
  request: CheckoutRequest,
): Effect.Effect<CheckoutRequest, InvalidState> =>
  Effect.gen(function* () {
    if (request.kind === "existingWorktree")
      return yield* Effect.fail(new InvalidState({ message: RUNS_NOTHING_HERE }));
    const named = checkoutRequestHost(request);
    if (named !== undefined) {
      const owner = placement.ownerOf(named);
      if (owner !== undefined && owner !== (yield* callerPerson))
        return yield* Effect.fail(new InvalidState({ message: NOT_YOUR_MACHINE }));
      return request;
    }
    const hostId = yield* placement.machine;
    return { ...request, hostId };
  });

/**
 * How long a list waits on a machine online that hasn't said what its CLIs offer: about what a
 * fresh machine takes to ask them.
 */
export const STATUS_WAIT_MS = 20_000;

/**
 * The machine `person`'s work goes on, when it is online and lists nothing for `agent` though it
 * may yet: absent when it has a list, or has said why it can't (a CLI not installed, not signed
 * in), so that a fact isn't waited on.
 */
export const unlisted = (
  machines: ReadonlyArray<PlaceableMachine>,
  person: string | undefined,
  onDemand: boolean,
  agent: MachineAgent,
): HostId | undefined => {
  const picked = machineFor(machines, person, onDemand);
  if ("error" in picked) return undefined;
  const machine = machines.find((each) => each.id === picked.id);
  if (machine === undefined || machine.onlineSince === undefined) return undefined;
  if (listOf(machine, agent) !== undefined) return undefined;
  if (agent !== "claude" && machine.claudeSignInCheckedAt !== undefined) return undefined;
  return machine.id;
};

const unavailable = (agent: AgentKind, message: string) =>
  new AgentUnavailable({ agent, reason: "startup-failed", message });

/**
 * The models a headless Gram offers `person`, the first of these that has a list:
 *
 * 1. their own machine's, where an embedder started one for them and it has reported;
 * 2. the list their own machine last reported (`remembered`), while it is stopped, starting or
 *    has not reported yet: a person's machine stays theirs while it is down;
 * 3. the default machine's (`defaultMachine`, which never picks a machine started for someone).
 *
 * A step with no list falls through to the next. With none, the reason says what to do.
 */
export const modelsFor = (
  machines: ReadonlyArray<PlaceableMachine>,
  person: string | undefined,
  onDemand: boolean,
  remembered: Map<string, ReadonlyArray<AgentModel>>,
  agent: MachineAgent = "claude",
): { readonly models: ReadonlyArray<AgentModel> } | { readonly error: string } => {
  const picked = machineFor(machines, person, onDemand);
  const own =
    "error" in picked || person === undefined
      ? undefined
      : machines.find((each) => each.id === picked.id && each.owner === person);
  const ownList = own === undefined ? undefined : listOf(own, agent);
  if (ownList !== undefined && person !== undefined) {
    remembered.set(person, ownList);
    return { models: ownList };
  }
  const last = person === undefined ? undefined : remembered.get(person);
  if (last !== undefined) return { models: last };
  if (onDemand && person !== undefined && "error" in picked) return picked;
  const shared = defaultMachine(machines);
  const sharedMachine =
    "error" in shared ? undefined : machines.find((each) => each.id === shared.id);
  const sharedList = sharedMachine === undefined ? undefined : listOf(sharedMachine, agent);
  if (sharedList !== undefined) return { models: sharedList };
  const waiting = own ?? sharedMachine;
  if (waiting !== undefined) return { error: notListing(waiting, agent) };
  if ("error" in picked) return picked;
  return "error" in shared ? shared : { error: NO_MACHINE_JOINED };
};

/**
 * The agents of a headless Gram: no CLI is looked for or started here. Claude Code and Codex are
 * offered as the joined machines list them (`modelsFor`), and a session opens only where a thread
 * is placed (`placedHost`), so one asked for here (a thread of this machine, a helper, a memory
 * update) is refused. Whether Codex holds Gram's outward gate, and has its own Auto reviewer, is
 * what the machine a new thread goes on says of its Codex.
 */
export const headlessAgentHosts = (
  remote:
    | (Pick<RemoteHostsShape, "list"> & Partial<Pick<RemoteHostsShape, "checkSignIn">>)
    | undefined,
  onDemand = false,
  statusWaitMs = STATUS_WAIT_MS,
): AgentHosts["Service"] => {
  const remembered = {
    claude: new Map<string, ReadonlyArray<AgentModel>>(),
    codex: new Map<string, ReadonlyArray<AgentModel>>(),
    opencode: new Map<string, ReadonlyArray<AgentModel>>(),
    grok: new Map<string, ReadonlyArray<AgentModel>>(),
    antigravity: new Map<string, ReadonlyArray<AgentModel>>(),
  };
  const listModels = (agent: MachineAgent) =>
    Effect.gen(function* () {
      const person = yield* callerPerson;
      const machines = remote?.list() ?? [];
      let listed = modelsFor(machines, person, onDemand, remembered[agent], agent);
      const asking = "error" in listed ? unlisted(machines, person, onDemand, agent) : undefined;
      if (asking !== undefined && remote?.checkSignIn !== undefined) {
        const check = remote.checkSignIn;
        yield* Effect.tryPromise(() => check(asking)).pipe(
          Effect.timeoutOption(statusWaitMs),
          Effect.ignore,
        );
        listed = modelsFor(remote.list(), person, onDemand, remembered[agent], agent);
      }
      return "error" in listed
        ? yield* Effect.fail(unavailable(agent, listed.error))
        : listed.models;
    });
  const placedCodex = Effect.gen(function* () {
    const machines = remote?.list() ?? [];
    const picked = machineFor(machines, yield* callerPerson, onDemand);
    return "error" in picked ? undefined : machines.find((each) => each.id === picked.id)?.codex;
  });
  const claude: AgentHost = {
    kind: "claude",
    capabilities: CLAUDE_CAPABILITIES,
    open: () => Effect.fail(unavailable("claude", RUNS_NOTHING_HERE)),
    listModels: () => listModels("claude"),
  };
  const codex: AgentHost = {
    kind: "codex",
    capabilities: CODEX_CAPABILITIES,
    open: () => Effect.fail(unavailable("codex", RUNS_NOTHING_HERE)),
    listModels: (options) =>
      options?.profileId === undefined
        ? listModels("codex")
        : Effect.fail(unavailable("codex", GATEWAY_STAYS_HERE)),
    nativeGateReady: Effect.map(placedCodex, (placed) => placed?.gateReady === true),
    autoReviewReady: Effect.map(placedCodex, (placed) => placed?.autoReview === true),
  };
  const opencode: AgentHost = {
    kind: "opencode",
    capabilities: OPENCODE_CAPABILITIES,
    open: () => Effect.fail(unavailable("opencode", RUNS_NOTHING_HERE)),
    listModels: (options) =>
      options?.profileId === undefined
        ? listModels("opencode")
        : Effect.fail(unavailable("opencode", GATEWAY_STAYS_HERE)),
  };
  const grok: AgentHost = {
    kind: "grok",
    capabilities: GROK_CAPABILITIES,
    open: () => Effect.fail(unavailable("grok", RUNS_NOTHING_HERE)),
    listModels: (options) =>
      options?.profileId === undefined
        ? listModels("grok")
        : Effect.fail(unavailable("grok", GATEWAY_STAYS_HERE)),
  };
  const antigravity: AgentHost = {
    kind: "antigravity",
    capabilities: ANTIGRAVITY_CAPABILITIES,
    open: () => Effect.fail(unavailable("antigravity", RUNS_NOTHING_HERE)),
    listModels: (options) =>
      options?.profileId === undefined
        ? listModels("antigravity")
        : Effect.fail(unavailable("antigravity", GATEWAY_STAYS_HERE)),
  };
  return AgentHosts.of({
    elsewhere: true,
    get: (agent) =>
      agent === "claude"
        ? Effect.succeed(claude)
        : agent === "codex"
          ? Effect.succeed(codex)
          : agent === "opencode"
            ? Effect.succeed(opencode)
            : agent === "grok"
              ? Effect.succeed(grok)
              : agent === "antigravity"
                ? Effect.succeed(antigravity)
                : Effect.fail(
                    new AgentUnavailable({
                      agent,
                      message: `${agent} sessions don't run on a joined machine yet, and this Gram runs none itself.`,
                    }),
                  ),
  });
};

/** Why a headless Gram lists no models of a gateway profile. */
export const GATEWAY_STAYS_HERE =
  "Gateway profiles don't run on a joined machine, and this Gram runs no work itself. Choose a model the machine's own CLI lists.";

/**
 * `AgentHosts` for the server: the headless ones when it is headless, whatever agents it was
 * given; `otherwise` when it isn't.
 */
export const agentHostsOrHeadless = <E, R>(
  otherwise: Layer.Layer<AgentHosts, E, R>,
): Layer.Layer<AgentHosts, E, R | ServerConfig> =>
  Layer.unwrap(
    Effect.gen(function* () {
      if ((yield* ServerConfig).headless !== true) return otherwise;
      const remote = Option.getOrUndefined(yield* Effect.serviceOption(RemoteHosts));
      const embedding = Option.getOrUndefined(yield* Effect.serviceOption(Embedding));
      return Layer.succeed(
        AgentHosts,
        headlessAgentHosts(remote, embedding?.config.hostProvider !== undefined),
      );
    }),
  );

const refused = () => new InvalidState({ message: RUNS_NOTHING_HERE });
const worktreeRefused = () =>
  new WorktreeError({ reason: "invalidRequest", message: RUNS_NOTHING_HERE, dirty: false });

/**
 * This machine as a headless Gram has it: what would start something here is refused (a checkout
 * made, a worktree created or restored, a terminal opened), and its sessions are the headless
 * agents'. What only reads stays, since the control plane still reads the folders it keeps for its
 * projects, and so does letting go of what an earlier, non-headless run left here.
 */
export const headlessLocal = (local: WorkerHost): WorkerHost => ({
  ...local,
  checkouts: {
    ...local.checkouts,
    prepare: () => Effect.fail(refused()),
    restore: () => Effect.fail(refused()),
  },
  worktrees: {
    ...local.worktrees,
    create: () => Effect.fail(worktreeRefused()),
    restore: () => Effect.fail(worktreeRefused()),
  },
  terminals: {
    ...local.terminals,
    open: () => Effect.fail(refused()),
  },
});

/**
 * Fails unless the hosted features are on: what a headless server checks as it starts, after
 * `GRAM_EMBEDDING` has been applied to the stored setting. A server that isn't headless passes.
 */
export const requireHostedForHeadless: Effect.Effect<void, Error, ServerConfig | ThreadStore> =
  Effect.gen(function* () {
    if ((yield* ServerConfig).headless !== true) return;
    if (!embeddingOn(yield* (yield* ThreadStore).getSettings))
      return yield* Effect.fail(new Error(HEADLESS_NEEDS_HOSTED));
  });

/**
 * `store` for a server that may be headless: built, then checked, so a headless server whose
 * hosted features are off fails as it starts rather than run agents in the control plane.
 */
export const withHeadlessCheck = <A, E, R>(
  store: Layer.Layer<A | ThreadStore, E, R>,
): Layer.Layer<A | ThreadStore, E | Error, R | ServerConfig> =>
  Layer.effectDiscard(requireHostedForHeadless).pipe(Layer.provideMerge(store));
