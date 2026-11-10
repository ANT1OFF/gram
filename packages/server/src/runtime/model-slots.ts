import {
  isTierRef,
  slotModel,
  type AvailableModels,
  type ModelRef,
  type ModelSlot,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import type { AgentHosts } from "./agent-hosts.ts";

/**
 * What this machine's harnesses list on their own logins, for resolving a following slot. A
 * harness that can't list (not installed, signed out) counts as having none. Never a gateway's.
 */
export const availableHere = (hosts: AgentHosts["Service"]): Effect.Effect<AvailableModels> =>
  Effect.gen(function* () {
    const [claude, codex] = yield* Effect.forEach(
      ["claude", "codex"] as const,
      (agent) =>
        hosts.get(agent).pipe(
          Effect.flatMap((host) => host.listModels()),
          Effect.orElseSucceed(() => undefined),
        ),
      { concurrency: 2 },
    );
    return { claude, codex };
  });

/**
 * What a slot runs on here and now: a pinned one as saved, a following one resolved through the
 * recommendation against what this machine lists, listing only then. Undefined for an unset slot
 * or a tier nothing here fills, so the caller's own fallback (discovery) takes over.
 */
export const resolveSlot = (
  hosts: AgentHosts["Service"],
  slot: ModelSlot | undefined,
): Effect.Effect<ModelRef | undefined> =>
  slot === undefined || !isTierRef(slot)
    ? Effect.succeed(slot)
    : availableHere(hosts).pipe(Effect.map((available) => slotModel(slot, available)));
