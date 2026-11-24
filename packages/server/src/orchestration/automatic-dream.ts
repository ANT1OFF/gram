import {
  InvalidState,
  type ModelRef,
  type Settings,
  type WorkspaceState,
  defaultSlotOf,
  isTierAgent,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { ThreadStore } from "../persistence/thread-store.ts";
import type { AgentHosts } from "../runtime/agent-hosts.ts";
import { resolveSlot } from "../runtime/model-slots.ts";
import { readOutbox } from "./outbox.ts";
import { admittedForRole } from "./rules.ts";

/** A proven refusal before any Dream row or provider launch; never an uncertain failure. */
export class AutomaticDreamDeferred extends InvalidState {}

/**
 * Shared with manual start: the saved default model, never substituted for another provider. With
 * none saved, the first local agent that lists models, Claude Code first, as a new thread discovers
 * it, so a Codex-only user's dream doesn't wait on a Claude Code they don't have.
 */
export const defaultDreamModel = (
  settings: Settings,
  hosts: AgentHosts["Service"],
): Effect.Effect<ModelRef> =>
  Effect.gen(function* () {
    const preferred = yield* resolveSlot(hosts, defaultSlotOf(settings));
    if (preferred !== undefined)
      return admittedForRole(preferred.agent, "dream")
        ? preferred
        : { agent: "claude", model: "default" };
    for (const agent of ["claude", "codex"] as const) {
      const models = yield* hosts.get(agent).pipe(
        Effect.flatMap((host) => host.listModels()),
        Effect.orElseSucceed(() => []),
      );
      if (models.length > 0) return { agent, model: "default" };
    }
    return { agent: "claude", model: "default" };
  });

/**
 * The model a memory update runs on when nobody picked one: the recommendation's Scoped tier
 * (`claude-sonnet-5-5` on Claude Code, `gpt-6.2-sol` on Codex) on the harness of the saved default,
 * since the update reads short, distilled records rather than transcripts and files what lasts.
 * A default on a gateway profile is kept as it is: that choice of where the text goes is the user's.
 */
export const memoryUpdateModel = (
  settings: Settings,
  hosts: AgentHosts["Service"],
): Effect.Effect<ModelRef> =>
  Effect.gen(function* () {
    const fallback = yield* defaultDreamModel(settings, hosts);
    if (fallback.profileId !== undefined || !isTierAgent(fallback.agent)) return fallback;
    const scoped = yield* resolveSlot(hosts, { tier: "scoped", agent: fallback.agent });
    return scoped !== undefined && scoped.agent === fallback.agent && scoped.profileId === undefined
      ? scoped
      : fallback;
  });

/**
 * What holds an automatic memory update of a workspace, said for its status line, and whether the
 * model it would run on is there. Starting one is `makeMemoryUpdateSchedule`'s.
 */
export const makeAutomaticDream = (deps: {
  store: ThreadStore["Service"];
  hosts: AgentHosts["Service"];
}) => {
  const { store, hosts } = deps;
  const gate = (workspace: WorkspaceState) =>
    Effect.gen(function* () {
      if (workspace.paused !== undefined) return "Waiting until you resume this workspace.";
      const holder = workspace.workspace.orchestratorThreadId;
      const threads = yield* store.listThreads;
      if (threads.some((t) => t.id === holder && t.parked))
        return "Waiting until you unpark the orchestrator.";
      const outbox = readOutbox(yield* store.getOutbox(workspace.workspace.id));
      if (outbox._tag === "unreadable" || (outbox._tag === "read" && outbox.setAside !== undefined))
        return "Waiting for this workspace's recovery.";
      if (Object.values(outbox.state.workers).some((worker) => worker.userIntervened))
        return "Waiting while a worker is held by you.";
      if ((yield* store.listDreams(workspace.workspace.id)).some((d) => d.status === "running"))
        return "Waiting for the running memory update to end.";
      return undefined;
    });
  const modelAvailable = (model: ModelRef) =>
    hosts.get(model.agent).pipe(
      Effect.flatMap((host) =>
        host.listModels(model.profileId === undefined ? undefined : { profileId: model.profileId }),
      ),
      Effect.option,
      Effect.map(
        (available) =>
          Option.isSome(available) &&
          available.value.length > 0 &&
          (model.model === "default" || available.value.some((m) => m.id === model.model)),
      ),
    );
  return { gate, modelAvailable };
};
