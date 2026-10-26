import type { Settings } from "@gram/contracts";
import { create } from "zustand";

/** The server's settings as last loaded; absent until `settings.get` succeeds. */
export const useServerSettings = create<{ settings: Settings | undefined }>()(() => ({
  settings: undefined,
}));
