import { expect, test, type Page } from "@playwright/test";

// The inline boot script in index.html paints the stored theme before any module loads. A palette
// stored in the other mode (the default `neutral-dark`, with Light picked later) must paint as its
// partner, not dark until ThemeRoot pairs it.

const bootOnly = async (page: Page, state: object) => {
  await page.addInitScript((saved) => {
    localStorage.setItem("gram.theme", JSON.stringify({ state: saved, version: 1 }));
  }, state);
  // The inline bootstrap alone: the app's modules are held back.
  await page.route(/\/(?:src\/main\.tsx|assets\/[^/]+\.js)(?:\?.*)?$/, (route) =>
    route.fulfill({ contentType: "application/javascript", body: "export {}" }),
  );
  await page.goto("/", { waitUntil: "domcontentloaded" });
  return page.locator("html");
};

for (const [state, palette, mode] of [
  [{ palette: "neutral-dark", mode: "light" }, "neutral", "light"],
  [{ palette: "tokyo-light", mode: "dark" }, "tokyo-night", "dark"],
  [{ palette: "neutral-dark", mode: "dark" }, "neutral-dark", "dark"],
  [{ mode: "light" }, "neutral", "light"],
  [{}, "neutral-dark", "dark"],
] as const) {
  test(`boots ${JSON.stringify(state)} as ${palette}`, async ({ page }) => {
    const root = await bootOnly(page, state);
    await expect(root).toHaveAttribute("data-palette", palette);
    await expect(root).toHaveAttribute("data-mode", mode);
  });
}

test("boots the system mode's partner when the OS is light", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  const root = await bootOnly(page, { palette: "neutral-dark", mode: "system" });
  await expect(root).toHaveAttribute("data-palette", "neutral");
  await expect(root).toHaveAttribute("data-mode", "light");
});
