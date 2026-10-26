/**
 * What the user has picked on one question: its checked labels, and "Other…" with the text typed
 * into it. The text outlives unchoosing Other, so picking an option and back doesn't lose it.
 */
export interface Choice {
  readonly selected: readonly string[];
  readonly other: string;
  readonly otherChosen: boolean;
}

export const NO_CHOICE: Choice = { selected: [], other: "", otherChosen: false };

/** Picks or unpicks an option; on a single-select question it replaces Other, too. */
export function toggleOption(choice: Choice, label: string, multiSelect: boolean): Choice {
  if (!multiSelect) return { ...choice, selected: [label], otherChosen: false };
  return {
    ...choice,
    selected: choice.selected.includes(label)
      ? choice.selected.filter((l) => l !== label)
      : [...choice.selected, label],
  };
}

/** Picks Other, which on a single-select question is instead of any option, or unpicks it. */
export function chooseOther(choice: Choice, chosen: boolean, multiSelect: boolean): Choice {
  if (!multiSelect && chosen) return { ...choice, selected: [], otherChosen: true };
  return { ...choice, otherChosen: chosen };
}

/** Typing into Other picks it, so nothing that looks unpicked is sent. */
export function typeOther(choice: Choice, text: string, multiSelect: boolean): Choice {
  return { ...chooseOther(choice, true, multiSelect), other: text };
}

/**
 * The answer as sent: the picked labels, then the Other text when Other is picked. A single-select
 * question never holds both, so its answer is one entry or none.
 */
export function choiceAnswer(choice: Choice): string[] {
  const custom = choice.otherChosen ? choice.other.trim() : "";
  return [...choice.selected, ...(custom === "" ? [] : [custom])];
}
