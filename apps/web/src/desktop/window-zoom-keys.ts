import type { WindowZoomStep } from "@gram/contracts";

/**
 * Which zoom step a key press asks for, by the character it types: ⌘+ or ⌘= in, ⌘- out, ⌘0 actual
 * size. By character because the keys move: `+` is Shift+`=` on a US keyboard and a key of its own,
 * unshifted, on a Nordic or German one, and Electron's menu role spells its accelerator as the US
 * chord (Plus means Shift). So the menu registers none of them (see `menu.ts`): every zoom press
 * arrives in the renderer, a focused terminal takes it for its font first, and the rest land here.
 *
 * macOS only, where ⌘ is free for it. Elsewhere `mod` is Ctrl and a browser tab zooms itself.
 *
 * Never while an IME is composing, when every key is its own: the shortcut registry leaves those
 * events unhandled for that reason, and this listener comes after it. `keyCode` 229 covers the
 * browsers that report the key before `isComposing` is set.
 */
export const windowZoomStep = (
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey"> & {
    readonly isComposing?: boolean;
    readonly keyCode?: number;
  },
  mac: boolean,
): WindowZoomStep | undefined => {
  if (event.isComposing === true || event.keyCode === 229) return undefined;
  if (!mac || !event.metaKey || event.ctrlKey || event.altKey) return undefined;
  switch (event.key) {
    case "+":
    case "=":
      return "in";
    case "-":
      return "out";
    case "0":
      return "reset";
    default:
      return undefined;
  }
};
