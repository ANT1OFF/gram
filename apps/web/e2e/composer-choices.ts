import { expect, type Locator, type Page } from "@playwright/test";

/**
 * The composer's one choices chip (model · effort · mode · speed) in `scope`: a thread's toolbar,
 * the `/new` form, or the page.
 */
export const choicesChip = (scope: Page | Locator) => scope.getByTestId("composer-choices");

/**
 * The open choices popover; not one still animating out after a pick, whose headings are on their
 * way out of the page.
 */
export const choicesPopup = (page: Page) =>
  page.locator('[data-testid="composer-choices-popup"][data-open]');

/**
 * Opens the chip's popover on `section`: it opens on Model, and a heading opens another. Leaves it
 * open; the section's list is then the page's only one.
 */
export async function openChoices(
  page: Page,
  scope: Page | Locator,
  section: "model" | "effort" | "mode" | "speed" = "model",
): Promise<void> {
  if (!(await choicesPopup(page).isVisible())) await choicesChip(scope).click();
  await expect(choicesPopup(page)).toBeVisible();
  const heading = choicesPopup(page).getByTestId(`choices-${section}`);
  if ((await heading.getAttribute("aria-expanded")) !== "true") await heading.click();
  await expect(heading).toHaveAttribute("aria-expanded", "true");
}

/** Picks `option` in `section`'s list, which closes the popover. */
export async function pickChoice(
  page: Page,
  scope: Page | Locator,
  section: "effort" | "mode" | "speed",
  option: string,
): Promise<void> {
  await openChoices(page, scope, section);
  await page
    .getByRole("listbox", { name: section[0]!.toUpperCase() + section.slice(1) })
    .getByRole("option", { name: option, exact: true })
    .click();
  await expect(choicesPopup(page)).toBeHidden();
}

/**
 * What the chip draws: its one word, the model's name, whole even where it truncates, and the
 * glyphs after it, each its section and value: the mode's always ("mode:default"), Fast's bolt
 * while on ("speed:fast").
 */
export const chipFace = (chip: Locator) =>
  chip.evaluate((el) => ({
    words: (el as HTMLElement).innerText.trim(),
    glyphs: [...el.querySelectorAll<HTMLElement>("[data-chip-glyph]")].map((glyph) =>
      [glyph.dataset["chipGlyph"], glyph.dataset["value"]].filter(Boolean).join(":"),
    ),
  }));

/** The model's name on the chip: shown, however narrow, as wide as it has room for. */
export const chipModelName = (chip: Locator) => chip.getByTestId("choices-model-name");
