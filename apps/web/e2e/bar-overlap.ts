// Which two controls in a bar (the titlebar, the navigation dock) overlap on screen. Bombadil's
// `barControlsApart` (apps/web/bombadil/spec.ts) runs it from an extractor, and a Playwright spec
// with `locator.evaluate(barOverlap)`. So `barOverlap` is self-contained: it closes over nothing
// outside its own body, and imports nothing.
//
// Only what is drawn counts. A narrow titlebar folds its lesser buttons into "…" and keeps each
// folded copy laid out, unseen and inert, at the bar's end (shell/foldable.tsx), where it measures
// when it fits back: that copy sits over the panel toggle's box but is never drawn or hit.

export interface BarOverlap {
  readonly first: string;
  readonly second: string;
}

/** The first two drawn controls in `bar` that overlap by more than 2 px each way, or null. */
export function barOverlap(bar: Element): BarOverlap | null {
  const CONTROLS = 'button, a[href], input, [role="button"], [role="tab"], [role="link"]';
  const drawn = (control: Element) => {
    if (control.parentElement?.closest(CONTROLS)) return false; // a control inside another
    if (control.closest('[inert], [aria-hidden="true"]') !== null) return false;
    const box = control.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return false;
    return (
      typeof control.checkVisibility !== "function" ||
      control.checkVisibility({ visibilityProperty: true })
    );
  };
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page, so it lives inside
  const nameOf = (element: Element) =>
    element.getAttribute("aria-label") ??
    element.getAttribute("data-testid") ??
    (element.textContent ?? "").trim().slice(0, 30);
  const controls = [...bar.querySelectorAll(CONTROLS)].filter(drawn);
  const boxes = controls.map((control) => control.getBoundingClientRect());
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (overlapX > 2 && overlapY > 2)
        return { first: nameOf(controls[i]!), second: nameOf(controls[j]!) };
    }
  }
  return null;
}
