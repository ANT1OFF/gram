import { useEffect } from "react";

import { useApi } from "@/api/context";
import { isNotImplemented } from "@/api/errors";

import { useBindingsStore } from "./bindings-store";

/** Loads `keybindings.json` once; later changes arrive as `keybindings.changed` events. */
export function useKeybindingsSync() {
  const api = useApi();
  useEffect(() => {
    let cancelled = false;
    api.getKeybindings().then(
      (snapshot) => {
        if (!cancelled) useBindingsStore.getState().apply(snapshot);
      },
      (error: unknown) => {
        if (!isNotImplemented(error)) console.error("keybindings: load", error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);
}
