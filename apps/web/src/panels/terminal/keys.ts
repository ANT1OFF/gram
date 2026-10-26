import { effectiveKeys } from "@/keyboard/bindings-store";
import { isMac, matches, parseKeys, type Shortcut } from "@/keyboard/registry";

/**
 * Off macOS, Ctrl+Shift+C copies a terminal's selection and Ctrl+Shift+V pastes, as in other
 * terminals. On macOS ⌘C is a copy too: the selection is drawn on a canvas, so the browser's own
 * copy has nothing to take, and the emulator leaves the chord to it. ⌘V needs no help there.
 */
export function terminalClipboardKey(
  event: KeyboardEvent,
  mac = isMac(),
): "copy" | "paste" | undefined {
  if (event.type !== "keydown") return undefined;
  if (mac) return matches("mod+c", event, mac) ? "copy" : undefined;
  if (matches("ctrl+shift+c", event, mac)) return "copy";
  if (matches("ctrl+shift+v", event, mac)) return "paste";
  return undefined;
}

/**
 * Whether the app rather than the shell answers `keys` while a terminal has focus. On macOS that is
 * every ⌘ chord, plus Ctrl chords with Shift, Alt or Tab. Off macOS `mod` is Ctrl, which shells use
 * for line editing and signals (Ctrl+B, Ctrl+K, Ctrl+W, Ctrl+\…), so a plain Ctrl chord only reaches
 * the app for digits, zoom keys, `,`, Tab and the terminal's own shortcuts; Ctrl+Shift and Ctrl+Alt
 * chords always do.
 */
const answeredByApp = (shortcut: Shortcut, keys: string, mac: boolean): boolean => {
  const chord = parseKeys(keys);
  if (mac) return chord.mod || (chord.ctrl && (chord.shift || chord.alt || chord.key === "tab"));
  if (!chord.mod && !chord.ctrl) return false;
  if (chord.shift || chord.alt) return true;
  return shortcut.group === "Terminal" || /^(?:[0-9=,-]|tab)$/.test(chord.key);
};

/**
 * Whether a key event belongs to an app shortcut while a terminal has focus; everything else goes to
 * the shell. Disabled bindings and the terminal's copy and paste chords never do.
 */
export function isAppShortcut(
  event: KeyboardEvent,
  shortcuts: readonly Shortcut[],
  mac = isMac(),
): boolean {
  if (event.type !== "keydown" || terminalClipboardKey(event, mac) !== undefined) return false;
  return shortcuts.some((shortcut) => {
    const keys = effectiveKeys(shortcut.id, shortcut.keys);
    return keys !== undefined && answeredByApp(shortcut, keys, mac) && matches(keys, event, mac);
  });
}
