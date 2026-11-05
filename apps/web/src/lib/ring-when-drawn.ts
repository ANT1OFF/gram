/** How long a card a jump lands on stays ringed. */
const FLASH_MS = 1_600;
/** How long a jump looks for a card that isn't drawn yet before it gives up. */
const FIND_MS = 3_000;

/**
 * Scrolls to the first element `selector` finds once its thread has drawn it, and rings it for a
 * moment. Cards above the composer are found this way (a Needs you jump, a waiting tool row's link
 * to its approval); transcript messages go through the reveal store, which also pages earlier
 * history in.
 */
export const ringWhenDrawn = (selector: string, focus: boolean) => {
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
    if (focus) {
      if (!found.hasAttribute("tabindex")) found.tabIndex = -1;
      found.focus({ preventScroll: true });
    }
    setTimeout(() => found.removeAttribute("data-needs-you-flash"), FLASH_MS);
  };
  requestAnimationFrame(look);
};

/** A value quoted for an attribute selector: its backslashes and quotes escaped. */
export const attr = (value: string) => value.replace(/["\\]/gu, "\\$&");
