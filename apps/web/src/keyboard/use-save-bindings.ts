import { useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";

import { useBindingsStore, type BindingOverrides } from "./bindings-store";

/**
 * Writes `keybindings.json` and takes the server's answer into the bindings store, with why the
 * last write failed. Settings → Keyboard and the Voice page's key both save through it, so they
 * edit the one file.
 */
export function useSaveBindings(): {
  save: (next: BindingOverrides) => Promise<void>;
  error: string | undefined;
} {
  const api = useApi();
  const [error, setError] = useState<string>();
  const save = async (next: BindingOverrides) => {
    setError(undefined);
    try {
      useBindingsStore.getState().apply(await api.setKeybindings(next));
    } catch (cause) {
      setError(`Couldn't save keybindings.json: ${errorMessage(cause)}`);
    }
  };
  return { save, error };
}
