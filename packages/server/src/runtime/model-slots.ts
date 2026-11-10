import {
  isTierRef,
  slotHere,
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
 * A slot as it stands here and now (`slotHere`): a pinned one as saved, a following one resolved
 * through the recommendation against what this machine lists, listing only then. One that can't
 * run here comes back with why, for the caller to say beside whatever stands in.
 */
export const slotHereNow = (
  hosts: AgentHosts["Service"],
  slot: ModelSlot | undefined,
): Effect.Effect<{ readonly model?: ModelRef; readonly missing?: string }> =>
  slot === undefined || !isTierRef(slot)
    ? Effect.succeed(slotHere(slot, {}))
    : availableHere(hosts).pipe(Effect.map((available) => slotHere(slot, available)));

/**
 * What a slot runs on here and now. Undefined for an unset slot or one that can't run here, so the
 * caller's own fallback (discovery) takes over; `slotHereNow` also says why.
 */
export const resolveSlot = (
  hosts: AgentHosts["Service"],
  slot: ModelSlot | undefined,
): Effect.Effect<ModelRef | undefined> =>
  slotHereNow(hosts, slot).pipe(Effect.map((here) => here.model));
