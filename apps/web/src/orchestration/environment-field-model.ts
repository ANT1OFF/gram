import type { ShellEnvironment, ShellEnvironmentList } from "@/embed/contract";

/**
 * The environment a workspace with `value` starts in, as its field shows it: its own pick while
 * the app still offers it, else the app's default, with `gone` when a pick it had is no longer
 * offered (deleted, or not this person's to use).
 */
export const environmentShown = (
  list: ShellEnvironmentList,
  value: string | undefined,
): { readonly picked: ShellEnvironment; readonly gone: boolean } => {
  const fallback = list.environments.find((each) => each.id === list.default) ??
    list.environments[0] ?? { id: list.default, label: list.default };
  if (value === undefined) return { picked: fallback, gone: false };
  const own = list.environments.find((each) => each.id === value);
  return own === undefined ? { picked: fallback, gone: true } : { picked: own, gone: false };
};

/** The environment's name for a step or a line: its label, or the default's. */
export const environmentLabel = (
  list: ShellEnvironmentList | undefined,
  value: string | undefined,
): string | undefined =>
  list === undefined ? undefined : environmentShown(list, value).picked.label;
