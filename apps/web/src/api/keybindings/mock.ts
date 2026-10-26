import { createMockKeybindings } from "../mock-depth";
import type { MockWorld } from "../mock-world";
import type { KeybindingsApi } from "./types";

/** `KeybindingsApi` over overrides kept in the page's storage, announced as the server's watcher does. */
export function createKeybindingsMock(world: MockWorld): KeybindingsApi {
  const keybindings = createMockKeybindings();
  return {
    getKeybindings: async () => keybindings.get(),
    setKeybindings: async (bindings) => {
      const state = keybindings.set(bindings);
      world.emit({ type: "keybindings.changed", keybindings: state });
      return state;
    },
  };
}
