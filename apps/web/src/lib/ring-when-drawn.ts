/** How long a card a jump lands on stays ringed. */
const FLASH_MS = 1_600;
/** How long a jump looks for a card that isn't drawn yet before it gives up. */
const FIND_MS = 3_000;

/**
 * Scrolls to the first element `selector` finds once its thread has drawn it, rings it for a
 * moment and gives it focus. Cards above the composer are found this way (a Needs you jump, a waiting tool row's link
 * to its approval); transcript messages go through the reveal store, which also pages earlier
 * history in.
 */
export const ringWhenDrawn = (selector: string) => {
  const until = performance.now() + FIND_MS;
  const look = () => {
    // Drawn and shown: an approval queue keeps the others hidden until it shows this one.
    const found = [...document.querySelectorAll<HTMLElement>(selector)].find(
      (element) => element.offsetParent !== null,
    );
    if (found === undefined) {
      if (performance.now() < until) requestAnimationFrame(look);
      return;
    }
    found.scrollIntoView({ block: "center" });
    found.setAttribute("data-needs-you-flash", "true");
    if (!found.hasAttribute("tabindex")) found.tabIndex = -1;
    // The dialog that closed for this jump (the Inbox) holds focus until it has left the page,
    // and takes back any it loses meanwhile: the card takes focus once the dialog has let go.
    const take = () => {
      if (!found.isConnected || performance.now() >= until) return;
      if (document.activeElement?.closest('[role="dialog"]') != null) {
        requestAnimationFrame(take);
        return;
      }
      found.focus({ preventScroll: true });
    };
    take();
    setTimeout(() => found.removeAttribute("data-needs-you-flash"), FLASH_MS);
  };
  requestAnimationFrame(look);
};

/** A value quoted for an attribute selector: its backslashes and quotes escaped. */
export const attr = (value: string) => value.replace(/["\\]/gu, "\\$&");
