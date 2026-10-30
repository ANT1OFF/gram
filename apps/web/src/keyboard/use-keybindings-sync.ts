import { useEffect } from "react";

import { useApi } from "@/api/context";
import { isNotImplemented } from "@/api/errors";
import type { Api } from "@/api/types";

import { useBindingsStore } from "./bindings-store";

/**
 * Reads `keybindings.json` into the bindings store, unless `cancelled()` by then. Also run after a
 * reconnect, since a `keybindings.changed` sent while the socket was down never arrives.
 */
export function loadKeybindings(api: Api, cancelled: () => boolean = () => false): Promise<void> {
  return api.getKeybindings().then(
    (snapshot) => {
      if (!cancelled()) useBindingsStore.getState().apply(snapshot);
    },
    (error: unknown) => {
      if (!isNotImplemented(error)) console.error("keybindings: load", error);
    },
  );
}

/** Loads `keybindings.json` once; later changes arrive as `keybindings.changed` events. */
export function useKeybindingsSync() {
  const api = useApi();
  useEffect(() => {
    let cancelled = false;
    void loadKeybindings(api, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [api]);
}
