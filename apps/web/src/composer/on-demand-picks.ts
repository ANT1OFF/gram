import { create } from "zustand";

import type { OnDemandChoice } from "@/api/on-demand";

/**
 * What a person picked for their own machine from the Runs on chip, until it is used: the next
 * start (from the start card) or a start again of a machine that runs. Kept for this page only;
 * where the deployment keeps picks (`keeps`), "Keep as my default" saves them on their account.
 */
export const useOnDemandPicks = create<{
  readonly picks: Readonly<Record<string, string>>;
  readonly keep: boolean;
  pick(choice: string, option: string): void;
  setKeep(keep: boolean): void;
  clear(): void;
}>((set) => ({
  picks: {},
  keep: true,
  pick: (choice, option) => set((s) => ({ picks: { ...s.picks, [choice]: option } })),
  setKeep: (keep) => set({ keep }),
  clear: () => set({ picks: {} }),
}));

const usable = (choice: OnDemandChoice, option: string | undefined) =>
  option !== undefined && choice.options.some((each) => each.id === option && each.available);

/** Each choice's value: the person's pick where it can still be picked, else its default. */
export const pickedFor = (
  choices: ReadonlyArray<OnDemandChoice>,
  picks: Readonly<Record<string, string>>,
): Record<string, string> =>
  Object.fromEntries(
    choices.map((choice) => [
      choice.id,
      usable(choice, picks[choice.id]) ? picks[choice.id]! : choice.default,
    ]),
  );

/**
 * The picks that differ from their choice's default: all a start sends. A choice left alone
 * follows the default, which the deployment may change later.
 */
export const changedFor = (
  choices: ReadonlyArray<OnDemandChoice>,
  picks: Readonly<Record<string, string>>,
): Record<string, string> =>
  Object.fromEntries(
    choices.flatMap((choice) => {
      const wanted = picks[choice.id];
      return usable(choice, wanted) && wanted !== choice.default ? [[choice.id, wanted!]] : [];
    }),
  );

/** The choices whose value differs from what the person's machine has now. */
export const differsFromCurrent = (
  choices: ReadonlyArray<OnDemandChoice>,
  values: Readonly<Record<string, string>>,
): ReadonlyArray<OnDemandChoice> =>
  choices.filter((choice) => choice.current !== undefined && values[choice.id] !== choice.current);

/** Whether `value` is the person's own, not the deployment's default. Unknown: not. */
export const isOwn = (choice: OnDemandChoice, value: string): boolean =>
  choice.fallback !== undefined && value !== choice.fallback;

/** The words for an option: its short label where it has one. */
export const shortOf = (choice: OnDemandChoice, value: string): string => {
  const option = choice.options.find((each) => each.id === value);
  return option?.short ?? option?.label ?? value;
};
