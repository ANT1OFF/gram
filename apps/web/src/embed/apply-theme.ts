import { installHostTheme } from "@/theme/host-theme";

import type { HostTheme } from "./contract";
import { bootTheme } from "./theme-boot";

/**
 * Puts Gram's look on the page before Gram mounts, as mounting does: the person's stored mode,
 * palette and motion setting on `<html>`, and your app's own `theme` (the one you mount with) over
 * them. For a page of yours drawn with the light kit (sign-in, a landing page) that should look as
 * Gram will once it mounts. A mode that follows the system is read once, as the page opens.
 */
export function applyGramTheme(theme?: HostTheme): void {
  if (typeof document === "undefined") return;
  let storage: Storage | undefined;
  try {
    storage = window.localStorage;
  } catch {
    // Storage that can't be read (a private window, blocked site data) boots the defaults.
  }
  installHostTheme(document, theme);
  const root = document.documentElement;
  bootTheme(root, storage, undefined, theme);
  // Mounting Gram clears it once its theme is in; here nothing else is coming.
  requestAnimationFrame(() => root.removeAttribute("data-theme-booting"));
}
