import { expect, test, type Page } from "@playwright/test";

// The acceptance run for mounting Gram in an app of another's: the fixture app consumes only the
// built package, mounts it against the in-memory server, and adds two pages, a navigation group
// and a switcher.

const mounted = async (page: Page, path = "/") => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(path);
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-embed-shell", "on");
  return errors;
};

test("the whole app mounts from the built package, with its styles and theme", async ({ page }) => {
  const errors = await mounted(page);
  // Gram's own first screen, drawn by Gram's own code against the in-memory server.
  await expect(page.getByTestId("overview-sidebar")).toBeVisible();
  await expect(page.getByTestId("shell-titlebar")).toBeVisible();
  // The theme attributes the styles hang on, which Gram's own page sets in its HTML.
  await expect(page.locator("html")).toHaveAttribute("data-palette", "neutral-dark");
  await expect(page.locator("html")).not.toHaveAttribute("data-theme-booting", "");
  // The stylesheet is the package's: the sidebar has its token's colour, not the page default.
  const sidebar = await page
    .getByTestId("overview-sidebar")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(sidebar).not.toBe("rgba(0, 0, 0, 0)");
  // One of Gram's own pages, loaded as a lazy chunk of the package.
  await page.goto("/settings/about");
  await expect(page.getByRole("heading", { name: "About" }).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("the sidebar lists the added group, and its page opens inside Gram's shell", async ({
  page,
}) => {
  const errors = await mounted(page);
  const navigation = page.getByTestId("embed-navigation");
  await expect(navigation.getByRole("heading", { name: "Govern" })).toBeVisible();
  const policies = navigation.getByRole("link", { name: "Policies" });
  await expect(policies).not.toHaveAttribute("aria-current", "page");
  await policies.click();

  await expect(page).toHaveURL(/\/govern\/policies$/);
  await expect(page.getByTestId("fixture-policies")).toBeVisible();
  await expect(page.getByTestId("fixture-pathname")).toHaveText("/govern/policies");
  await expect(policies).toHaveAttribute("aria-current", "page");
  // Gram's shell is still around the page: its sidebar and title bar.
  await expect(page.getByTestId("overview-sidebar")).toBeVisible();
  await expect(page.getByTestId("shell-titlebar")).toBeVisible();

  // A link of the page's own moves the window without loading it again, and carries a parameter.
  await page.evaluate(() => {
    (window as unknown as { stayed: boolean }).stayed = true;
  });
  await page.getByRole("link", { name: "Agent 42" }).click();
  await expect(page.getByTestId("fixture-agent")).toHaveText("Agent a-42");
  // Under the group's destination, so it stays marked.
  expect(await page.evaluate(() => (window as unknown as { stayed?: boolean }).stayed)).toBe(true);

  // A destination may be one of Gram's own pages, and the added page can send the window to one.
  await navigation.getByRole("link", { name: "Spend" }).click();
  await expect(page.getByTestId("usage-overview")).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId("fixture-agent")).toBeVisible();
  expect(errors).toEqual([]);
});

test("an added page opens from its address, and from the palette", async ({ page }) => {
  const errors = await mounted(page, "/govern/agents/a-7");
  await expect(page.getByTestId("fixture-agent")).toHaveText("Agent a-7");

  await page.getByTestId("overview-search").click();
  await page.getByRole("combobox").fill("Policies");
  await page
    .getByRole("option", { name: /Policies/ })
    .first()
    .click();
  await expect(page.getByTestId("fixture-policies")).toBeVisible();
  expect(errors).toEqual([]);
});

test("the switcher is the embedding app's, in the sidebar and then in the title bar", async ({
  page,
}) => {
  const errors = await mounted(page);
  const inSidebar = page.locator('[data-testid="embed-switcher"][data-placement="sidebar"]');
  await expect(inSidebar.getByTestId("fixture-switcher")).toHaveText("Acme / Platform");
  // Its state is its own component's.
  await inSidebar.getByTestId("fixture-switcher").click();
  await expect(inSidebar.getByTestId("fixture-switcher")).toHaveText("Acme / Data");
  await expect(page.locator('[data-placement="titlebar"]')).toHaveCount(0);

  // Compact: a tile in the rail, and the group's destinations as icons.
  await page.getByTestId("overview-compact").click();
  await expect(page.locator('[data-testid="embed-switcher"][data-placement="rail"]')).toBeVisible();
  await expect(
    page.getByTestId("embed-rail-navigation").getByRole("link", { name: "Govern: Policies" }),
  ).toBeVisible();

  // Hidden: the title bar carries it instead.
  await page.getByTestId("overview-hide").click();
  await expect(
    page.locator('[data-testid="embed-switcher"][data-placement="titlebar"]'),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("the navigation and the switcher can be replaced after mounting", async ({ page }) => {
  await mounted(page);
  await page.evaluate(() => {
    (window as unknown as { embed: { update: (next: object) => void } }).embed.update({
      navigation: [
        {
          id: "build",
          label: "Build",
          items: [{ id: "agents", label: "Agents", to: "/govern/agents/a-1" }],
        },
      ],
    });
  });
  const navigation = page.getByTestId("embed-navigation");
  await expect(navigation.getByRole("heading", { name: "Build" })).toBeVisible();
  await expect(navigation.getByRole("heading", { name: "Govern" })).toHaveCount(0);
  await expect(page.getByTestId("embed-switcher")).toHaveCount(0);
  await navigation.getByRole("link", { name: "Agents" }).click();
  await expect(page.getByTestId("fixture-agent")).toHaveText("Agent a-1");
});

test("the app runs under a path of the embedding app's choosing", async ({ page }) => {
  const errors = await mounted(page, "/w/acme/");
  await page.getByTestId("embed-navigation").getByRole("link", { name: "Policies" }).click();
  await expect(page).toHaveURL(/\/w\/acme\/govern\/policies$/);
  // The page is told its path as the app names it, without the path it is served under.
  await expect(page.getByTestId("fixture-pathname")).toHaveText("/govern/policies");

  // A deep link under the path lands on the page it names, Gram's own included.
  await page.goto("/w/acme/settings/about");
  await expect(page.getByRole("heading", { name: "About" }).first()).toBeVisible();
  await page.goto("/w/acme/govern/agents/a-9");
  await expect(page.getByTestId("fixture-agent")).toHaveText("Agent a-9");
  expect(errors).toEqual([]);
});
