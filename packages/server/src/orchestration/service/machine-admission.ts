// Admission of a direct Codex, OpenCode or Grok Build worker on a joined machine, from what the
// machine reports of that CLI.

import { hostListing, type ModelRef } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { refusal } from "../rules.ts";
import { type OrchestrationKit, toolError } from "./kit.ts";

type JoinedMachine = ReturnType<OrchestrationKit["joinedMachines"]>[number];

/**
 * A direct Codex worker on a joined machine, as the machine says of its Codex. Where its status
 * isn't in yet, nothing is refused on it: the open there says what is wrong, as for Claude.
 */
export const admitMachineCodex = (
  tool: string,
  machine: JoinedMachine | undefined,
  name: string,
  chosen: ModelRef,
) =>
  Effect.gen(function* () {
    // A status without Codex comes from a host that doesn't run Codex sessions.
    if (machine?.tools !== undefined && machine.codex === undefined)
      return yield* toolError(
        tool,
        refusal(
          "not_admitted",
          `${name}'s Gram is older than this one and doesn't run Codex sessions. Update Gram there (Settings → Machines), or choose a Claude worker model.`,
        ),
      );
    const codex = machine?.codex;
    if (codex === undefined) return;
    if (!codex.found)
      return yield* toolError(
        tool,
        refusal(
          "not_admitted",
          `${name}: Codex is not installed. Install it there and run codex login before spawning a Codex worker.`,
        ),
      );
    if (codex.models !== undefined && hostListing(codex.models, chosen.model) === undefined)
      return yield* toolError(
        tool,
        refusal(
          "not_admitted",
          `${name}'s Codex doesn't list ${chosen.model}. Pick a model it lists, or update Codex there.`,
        ),
      );
    if (codex.signIn === "notSignedIn")
      return yield* toolError(
        tool,
        refusal(
          "not_admitted",
          `${name} is not signed in to Codex. Run codex login on that machine before spawning a Codex worker.`,
        ),
      );
  });

/** A direct Grok Build worker on a joined machine, as the machine says of its Grok Build. */
export const admitMachineGrok = (
  tool: string,
  machine: JoinedMachine | undefined,
  name: string,
  chosen: ModelRef,
) =>
  Effect.gen(function* () {
    // A status without Grok Build comes from a host that doesn't run Grok Build sessions.
    if (machine?.tools !== undefined && machine.grok === undefined)
      return yield* toolError(
        tool,
        refusal(
          "not_admitted",
          `${name} doesn't run Grok Build sessions: its Gram is older than this one, or it has no Grok Build. Update Gram there (Settings → Machines), or choose another worker model.`,
        ),
      );
    const grok = machine?.grok;
    if (grok === undefined) return;
    if (!grok.found)
      return yield* toolError(
        tool,
        refusal(
          "not_admitted",
          `${name}: Grok Build is not installed. Install it there before spawning a Grok Build worker.`,
        ),
      );
    if (grok.models !== undefined && hostListing(grok.models, chosen.model) === undefined)
      return yield* toolError(
        tool,
        refusal(
          "not_admitted",
          `${name}'s Grok Build doesn't list ${chosen.model}. Pick a model it lists.`,
        ),
      );
  });

/**
 * A direct OpenCode worker on a joined machine, as the machine says of its OpenCode. Where its
 * status isn't in yet, nothing is refused on it: the open there says what is wrong.
 */
export const admitMachineOpenCode = (
  tool: string,
  machine: JoinedMachine | undefined,
  name: string,
  chosen: ModelRef,
) =>
  Effect.gen(function* () {
    // A status without OpenCode comes from a host that doesn't run OpenCode sessions.
    if (machine?.tools !== undefined && machine.opencode === undefined)
      return yield* toolError(
        tool,
        refusal(
          "not_admitted",
          `${name}'s Gram is older than this one and doesn't run OpenCode sessions. Update Gram there (Settings → Machines), or choose another worker model.`,
        ),
      );
    const opencode = machine?.opencode;
    if (opencode === undefined) return;
    if (!opencode.found)
      return yield* toolError(
        tool,
        refusal(
          "not_admitted",
          `${name}: OpenCode is not installed. Install it there before spawning an OpenCode worker.`,
        ),
      );
    if (opencode.models !== undefined && hostListing(opencode.models, chosen.model) === undefined)
      return yield* toolError(
        tool,
        refusal(
          "not_admitted",
          `${name}'s OpenCode doesn't list ${chosen.model}. Pick a model it lists, or check its providers there.`,
        ),
      );
  });
