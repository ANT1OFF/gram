import { expect, test, type Page } from "@playwright/test";

// The embedding app's account on the compact strip: given `placement: "rail"`, at its foot.

const mounted = async (page: Page, path = "/") => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(path);
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-embed-shell", "on");
  return errors;
};

type Update = { embed: { update: (next: object) => void } };

test("the compact strip has the app's account at its foot, under History", async ({ page }) => {
  const errors = await mounted(page);
  await page.evaluate(() => {
    const own = window as unknown as Update & { fixtureSidebar: object };
    own.embed.update({ sidebar: { ...own.fixtureSidebar, peek: false } });
  });
  await page.getByTestId("overview-sidebar").getByTestId("overview-compact").click();
  const rail = page.getByTestId("overview-rail");
  const account = rail.getByTestId("embed-account");
  await expect(account).toHaveAttribute("data-placement", "rail");
  const tile = account.getByTestId("fixture-account-rail");
  await expect(tile).toBeVisible();
  const history = await rail.getByTestId("overview-rail-history").boundingBox();
  const own = await tile.boundingBox();
  expect(own?.y ?? 0).toBeGreaterThan(history?.y ?? 0);
  // It fits the strip: no wider than its tiles' column.
  const strip = await rail.boundingBox();
  expect((own?.x ?? 0) + (own?.width ?? 0)).toBeLessThanOrEqual(
    (strip?.x ?? 0) + (strip?.width ?? 0),
  );
  // Without an account of the app's, the strip's foot has none.
  await page.evaluate(() => {
    (window as unknown as Update).embed.update({ sidebar: { peek: false } });
  });
  await expect(page.getByTestId("overview-rail").getByTestId("embed-account")).toHaveCount(0);
  expect(errors).toEqual([]);
});
