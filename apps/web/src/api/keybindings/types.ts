import type { KeybindingOverrides, KeybindingsState } from "@gram/contracts";

/** `keybindings.*`: the user's shortcut overrides in `keybindings.json`. */
export interface KeybindingsApi {
  getKeybindings(): Promise<KeybindingsState>;
  /** Replaces every override and rewrites `keybindings.json`. */
  setKeybindings(bindings: KeybindingOverrides): Promise<KeybindingsState>;
}
