import type { HostId } from "@gram/contracts";
import { LOCAL_MACHINE_NAMES, namesThisMachine } from "../../host/paired-machines.ts";

/** A joined machine as a name is matched against it. */
export interface NameableMachine {
  readonly id: HostId;
  readonly name: string;
  readonly onDemand?: string | undefined;
}

const refused = (code: "unknown_machine" | "ambiguous_machine", message: string) =>
  ({ kind: "refused", code, message }) as const;

/**
 * The machine a spawn's `machine` names, among those joined: the one resolver every reader of the
 * name uses (the spawn itself and `spawn_worker`'s `sandbox` planner), so what one takes a name
 * for the other does too.
 *
 * - `here`: this machine (`LOCAL_MACHINE_NAMES`).
 * - A joined machine by its id or its name, case aside, as people type them. A machine started for
 *   an orchestrator's workers is the exception: it answers only to its exact name or id, so no
 *   other spelling of it reaches the machine past the checks its name is held to.
 */
export const machineNamedIn = (
  machines: ReadonlyArray<NameableMachine>,
  named: string,
):
  | { readonly kind: "here" }
  | { readonly kind: "machine"; readonly id: HostId }
  | {
      readonly kind: "refused";
      readonly code: "unknown_machine" | "ambiguous_machine";
      readonly message: string;
    } => {
  const typed = named.trim();
  const wanted = typed.toLowerCase();
  if (wanted === "")
    return refused(
      "unknown_machine",
      `machine is blank. Name a joined machine, or omit machine (or say ${LOCAL_MACHINE_NAMES.map((n) => `“${n}”`).join(" or ")}) to run here.`,
    );
  if (namesThisMachine(wanted)) {
    const legacy = machines.filter((m) => m.name.trim().toLowerCase() === wanted);
    return legacy.length > 0
      ? refused(
          "ambiguous_machine",
          `“${named}” names both this machine and a joined machine. Use the joined machine's id (${legacy.map((m) => m.id).join(", ")}), or omit machine to run here.`,
        )
      : { kind: "here" };
  }
  const found = machines.filter((m) =>
    m.onDemand === "worker"
      ? m.id === typed || m.name === typed
      : m.id.toLowerCase() === wanted || m.name.trim().toLowerCase() === wanted,
  );
  if (found.length === 1) return { kind: "machine", id: found[0]!.id };
  const known =
    machines.length === 0
      ? "No machine is joined to this Gram."
      : `Joined machines: ${machines.map((m) => m.name).join(", ")}.`;
  return found.length === 0
    ? refused(
        "unknown_machine",
        `No joined machine is named “${named}”. ${known} Omit machine, or say “local”, to run on this machine.`,
      )
    : refused(
        "ambiguous_machine",
        `More than one joined machine is named “${named}”; name it by its id.`,
      );
};
