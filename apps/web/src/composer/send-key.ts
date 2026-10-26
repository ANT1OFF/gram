import type { SendKey } from "@gram/contracts";

/**
 * Whether this key press in a composer's text area sends the message. With `enter`, plain Enter
 * sends and Shift+Enter is a new line; with `modEnter`, Enter is always a new line. ⌘/Ctrl+Enter
 * sends under either setting, but as a registered shortcut, not here. `undefined` is settings not
 * loaded yet, when nothing sends: a guess could post what was meant as a first line.
 *
 * Never while an IME is composing: there Enter accepts the candidate, and sending on it would post
 * half a word. `keyCode` 229 covers the browsers that report the key before `isComposing` is set.
 */
export const enterSends = (
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey"> & {
    readonly isComposing?: boolean;
    readonly keyCode?: number;
  },
  sendKey: SendKey | undefined,
): boolean =>
  sendKey === "enter" &&
  event.key === "Enter" &&
  !event.shiftKey &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.altKey &&
  event.isComposing !== true &&
  event.keyCode !== 229;
