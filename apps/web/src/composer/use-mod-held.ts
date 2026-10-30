import { useEffect, useState } from "react";

/** Whether ⌘ or Ctrl is down, watched only while `active`, for a control that changes under it. */
export function useModHeld(active: boolean): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!active) return;
    const read = (event: KeyboardEvent) => setHeld(event.metaKey || event.ctrlKey);
    // Switching away with the key down never delivers its key-up.
    const release = () => setHeld(false);
    window.addEventListener("keydown", read);
    window.addEventListener("keyup", read);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", read);
      window.removeEventListener("keyup", read);
      window.removeEventListener("blur", release);
      setHeld(false);
    };
  }, [active]);
  return active && held;
}
