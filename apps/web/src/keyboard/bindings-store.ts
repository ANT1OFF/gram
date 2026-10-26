import { create } from "zustand";

/** Shortcut id → keys (`mod+shift+k`), or `null` to disable the shortcut. */
export type BindingOverrides = Readonly<Record<string, string | null>>;

interface KeybindingsSnapshot {
  /** Where `keybindings.json` lives, for "Edit keybindings.json". */
  path: string;
  bindings: BindingOverrides;
  /** Why parts of the file were ignored. */
  problems: readonly string[];
}

interface BindingsState {
  path: string | undefined;
  overrides: BindingOverrides;
  problems: readonly string[];
  apply(snapshot: KeybindingsSnapshot): void;
}

/** The user's overrides from `keybindings.json`, kept in step with the file by the server. */
export const useBindingsStore = create<BindingsState>()((set) => ({
  path: undefined,
  overrides: {},
  problems: [],
  apply: ({ path, bindings, problems }) => set({ path, overrides: bindings, problems }),
}));

/** The keys a shortcut answers to: the user's override, else its default; `undefined` when disabled. */
export function effectiveKeys(
  id: string,
  defaultKeys: string,
  overrides: BindingOverrides = useBindingsStore.getState().overrides,
): string | undefined {
  if (!Object.hasOwn(overrides, id)) return defaultKeys;
  return overrides[id] ?? undefined;
}
