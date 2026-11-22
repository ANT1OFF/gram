import { supersededModels, type AgentKind, type AgentModel } from "@gram/contracts";
import type { ReactNode } from "react";

import { SWITCH_PREFIX, type SwitchOffer } from "@/thread/agent-switch-model";

import type { PickerOption } from "./picker";

/**
 * The agent whose models the composer's chip lists under the current agent's, as a move: whenever
 * the thread offers the switch, the orchestrator's included, so searching the chip for the other
 * agent's model finds it. A pick there opens the switch's sheet; it never sets the model itself.
 */
export const chipSwitchAgent = (offer: SwitchOffer): AgentKind | undefined =>
  offer.offered ? offer.to : undefined;

/**
 * The other agent's rows in the chip: each model it lists, greyed when the move can't happen now,
 * or a heading alone while it lists none.
 */
export const switchChoices = (input: {
  readonly offer: SwitchOffer;
  readonly models: readonly AgentModel[] | undefined;
  readonly group: string;
  readonly icon: ReactNode;
}): PickerOption<string>[] => {
  const { offer, models, group, icon } = input;
  if (chipSwitchAgent(offer) === undefined) return [];
  const superseded = supersededModels(models ?? []);
  const row = (id: string, label: string): PickerOption<string> => ({
    ...(superseded.has(id) ? { legacy: true } : {}),
    value: `${SWITCH_PREFIX}${id}`,
    label: `${label}…`,
    group,
    icon,
    opens: true,
    disabled: offer.offered && offer.refusal !== undefined,
  });
  return models !== undefined && models.length > 0
    ? models.map((m) => row(m.id, m.displayName))
    : [{ ...row("", group), headingOnly: true }];
};
