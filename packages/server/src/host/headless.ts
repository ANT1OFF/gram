// A headless control plane (`GRAM_HEADLESS=1`): a Gram that runs no work itself. Every session,
// an orchestrator's included, is placed on a joined machine; this one starts no agent, opens no
// terminal and makes no worktree. One of the hosted features, so it is refused unless they are on.

import type { AgentHost } from "@gram/agents";
import { CLAUDE_CAPABILITIES } from "@gram/agents/claude";
import {
  type AgentKind,
  type AgentModel,
  AgentUnavailable,
  type CheckoutRequest,
  checkoutRequestHost,
  embeddingOn,
  type HostId,
  InvalidState,
} from "@gram/contracts";
import { WorktreeError } from "@gram/git";
import * as Effect from "effect/Effect";
import { ActingPerson } from "../embedding/person.ts";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ServerConfig } from "../config.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
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
  /** A host an embedder started on demand for one person (`embedding/on-demand.ts`). */
  readonly owner?: string | undefined;
  readonly onDemand?: "personal" | "thread" | undefined;
}

/** With hosts provisioned on demand, a person with no machine of their own can start one. */
export const START_A_MACHINE =
  "You have no machine running, and this Gram runs no work itself. Start a machine to run this.";

/**
 * The machine a thread goes on when its request names none: the confirmed machine online now that
 * joined first, so the same one is chosen every time while it stays up. The reason when there is
 * none: nothing has joined, or what has is offline.
 */
export const defaultMachine = (
  machines: ReadonlyArray<PlaceableMachine>,
): { readonly id: HostId } | { readonly error: string } => {
  // A host started for one person is theirs alone: never anyone's default.
  const confirmed = machines.filter((machine) => machine.confirmed && machine.owner === undefined);
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
 * online, else the default one. With hosts provisioned on demand and none of their own running,
 * the reason says they can start one.
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
  }
  const shared = defaultMachine(machines);
  if ("error" in shared && onDemand && person !== undefined) return { error: START_A_MACHINE };
  return shared;
};

/** Placement over the machines joined now; with no way for a machine to join, there is none. */
export const headlessPlacement = (
  remote: Pick<RemoteHostsShape, "list"> | undefined,
  onDemand = false,
): HeadlessPlacement => ({
  machine: Effect.gen(function* () {
    const person = yield* ActingPerson;
    const picked = machineFor(remote?.list() ?? [], person, onDemand);
    return "error" in picked
      ? yield* Effect.fail(new InvalidState({ message: picked.error }))
      : picked.id;
  }),
  ownerOf: (hostId) => remote?.list().find((machine) => machine.id === hostId)?.owner,
});

/** What a person is told who names a machine started for someone else. */
export const NOT_YOUR_MACHINE = "That machine was started for someone else.";

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
      if (owner !== undefined && owner !== (yield* ActingPerson))
        return yield* Effect.fail(new InvalidState({ message: NOT_YOUR_MACHINE }));
      return request;
    }
    const hostId = yield* placement.machine;
    return { ...request, hostId };
  });

const unavailable = (agent: AgentKind, message: string) =>
  new AgentUnavailable({ agent, reason: "startup-failed", message });

/**
 * The agents of a headless Gram: no CLI is looked for or started here. Claude Code is offered as
 * the joined machines list it, and a session opens only where a thread is placed (`placedHost`), so
 * one asked for here (a thread of this machine, a helper, a memory update) is refused. Codex has
 * no session on a joined machine yet, so it isn't offered.
 */
export const headlessAgentHosts = (
  remote: Pick<RemoteHostsShape, "list"> | undefined,
): AgentHosts["Service"] => {
  const claude: AgentHost = {
    kind: "claude",
    capabilities: CLAUDE_CAPABILITIES,
    open: () => Effect.fail(unavailable("claude", RUNS_NOTHING_HERE)),
    // What the default machine's Claude Code lists, as its host last reported it.
    listModels: () =>
      Effect.suspend(() => {
        const machines: ReadonlyArray<PlaceableMachine> = remote?.list() ?? [];
        const picked = defaultMachine(machines);
        if ("error" in picked) return Effect.fail(unavailable("claude", picked.error));
        const machine = machines.find((each) => each.id === picked.id);
        return machine?.models === undefined
          ? Effect.fail(
              unavailable(
                "claude",
                `${machine?.name ?? picked.id} hasn't said which models its Claude Code offers yet.`,
              ),
            )
          : Effect.succeed(machine.models);
      }),
  };
  return AgentHosts.of({
    elsewhere: true,
    get: (agent) =>
      agent === "claude"
        ? Effect.succeed(claude)
        : Effect.fail(
            new AgentUnavailable({
              agent,
              message: `${agent} sessions don't run on a joined machine yet, and this Gram runs none itself.`,
            }),
          ),
  });
};

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
      return Layer.succeed(AgentHosts, headlessAgentHosts(remote));
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
