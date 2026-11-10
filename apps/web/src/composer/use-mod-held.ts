import { useEffect, useState } from "react";

import type { HeldDelivery } from "./send-action";

const heldOf = (event: KeyboardEvent): HeldDelivery =>
  event.metaKey || event.ctrlKey ? "interrupt" : event.altKey ? "queue" : undefined;

/**
 * The delivery the held modifier picks, watched only while `active`, for the send button that
 * changes under it: ⌘/Ctrl interrupts, ⌥ queues, nothing steers.
 */
export function useHeldDelivery(active: boolean): HeldDelivery {
  const [held, setHeld] = useState<HeldDelivery>(undefined);
  useEffect(() => {
    if (!active) return;
    const read = (event: KeyboardEvent) => setHeld(heldOf(event));
    // Switching away with the key down never delivers its key-up.
    const release = () => setHeld(undefined);
    window.addEventListener("keydown", read);
    window.addEventListener("keyup", read);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", read);
      window.removeEventListener("keyup", read);
      window.removeEventListener("blur", release);
      setHeld(undefined);
    };
  }, [active]);
  return active ? held : undefined;
}

/** The delivery a click's own modifiers pick, as `useHeldDelivery` reads them from the keyboard. */
export const clickDelivery = (event: {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
}): HeldDelivery => heldOf(event as KeyboardEvent);
