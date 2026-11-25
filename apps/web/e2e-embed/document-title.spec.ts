import { expect, test, type Page } from "@playwright/test";

// The browser tab as the embedding app names it (`shell.document.title`), from the page's name and
// Gram's count of what needs the person.

const mounted = async (page: Page, path = "/") => {
  await page.goto(path);
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-embed-shell", "on");
};

type Update = {
  embed: {
    update: (next: object) => void;
    navigate: (to: string) => Promise<void>;
  };
};

test("the browser tab takes the embedding app's title, with the page and the count", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mounted(page);
  // Gram's own, until the app names the tab.
  await expect(page).toHaveTitle(/Gram$/);
  await page.evaluate(() => {
    (window as unknown as Update).embed.update({
      document: {
        title: ({ name, needsYou }: { name: string | undefined; needsYou: number }) =>
          `${needsYou > 0 ? `(${needsYou}) ` : ""}${name ?? "Fixture"} · Fixture`,
      },
    });
  });
  await expect(page).toHaveTitle(/^(\(\d+\) )?Home · Fixture$/);
  await page.evaluate(() => (window as unknown as Update).embed.navigate("/govern/policies"));
  await expect(page).toHaveTitle(/^(\(\d+\) )?Policies · Fixture$/);
  // Gram's own Settings names its section too.
  await page.evaluate(() => (window as unknown as Update).embed.navigate("/settings/appearance"));
  await expect(page).toHaveTitle(/^(\(\d+\) )?Settings · Fixture$/);
  // Taken away again, Gram's own returns.
  await page.evaluate(() => (window as unknown as Update).embed.update({ document: undefined }));
  await expect(page).toHaveTitle(/Gram$/);
  expect(errors).toEqual([]);
});
