import { expect } from "vitest";

import { LABEL_WORD_CAP, labelWords, MENU_CAP } from "./menu-caps";

/** An item's label as it reads, without its shortcut. */
export const labelOf = (item: Element) => {
  const copy = item.cloneNode(true) as Element;
  copy.querySelectorAll("kbd").forEach((kbd) => kbd.remove());
  return copy.textContent?.trim() ?? "";
};

/** Every item but the last is within the cap, the last is More…, and every label is short. */
export function expectCapped(name: string, items: readonly string[]) {
  expect(items.at(-1), `${name} ends with More…`).toBe("More…");
  expect(items.length - 1, `${name}: ${items.join(", ")}`).toBeLessThanOrEqual(MENU_CAP);
  for (const label of items) {
    expect(labelWords(label), `${name}: "${label}"`).toBeLessThanOrEqual(LABEL_WORD_CAP);
  }
}
