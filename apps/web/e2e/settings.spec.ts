import { expect, test } from "@playwright/test";

import { openReviewsTab, reviewsInPanel } from "./reviews-panel";
import { openAdvancedPage, settingsNav as nav } from "./settings-nav";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test("general settings persist across a reload", async ({ page }) => {
  await page.goto("/settings/general");
  const general = page.getByTestId("general-settings");

  const folder = general.getByLabel("Default folder", { exact: true });
  await folder.fill("~/work");
  await folder.press("Enter");
  await general.getByRole("radio", { name: "fix", exact: true }).click();
  await nav(page).getByRole("link", { name: "Notifications" }).click();
  const notifications = page.getByTestId("notification-settings");
  await notifications.getByRole("radio", { name: "None" }).click();
  await expect(notifications.getByRole("radio", { name: "None" })).toHaveAttribute(
    "aria-checked",
    "true",
  );

  await page.reload();
  await expect(notifications.getByRole("radio", { name: "None" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(notifications.getByLabel("Desktop notifications")).toBeChecked();
  await page.goto("/settings/general");
  await expect(general.getByLabel("Default folder", { exact: true })).toHaveValue("~/work");
  await expect(general.getByRole("radio", { name: "fix", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("each tab is a page, with history, and Settings reopens on the last one", async ({ page }) => {
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings\/general$/);
  const general = nav(page).getByRole("link", { name: "General", exact: true });
  await expect(general).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { level: 2, name: "General" })).toBeVisible();

  // Six groups, one link each; the rest open from Advanced.
  await expect(nav(page).getByRole("link")).toHaveText([
    "General",
    "Agents",
    "Workspaces",
    "Appearance",
    "Notifications",
    "Advanced",
  ]);
  await expect(nav(page).getByRole("link", { name: "Workspaces" })).toHaveAttribute(
    "href",
    "/settings/workspaces",
  );
  await expect(nav(page).getByRole("link", { name: "Keyboard" })).toHaveCount(0);
  const advanced = nav(page).getByRole("link", { name: "Advanced", exact: true });
  await advanced.click();
  await expect(page).toHaveURL(/\/settings\/advanced$/);
  const rows = page.getByTestId("settings-subpages");
  await expect(rows.getByRole("link", { name: "What's New" })).toHaveAttribute(
    "href",
    "/settings/help",
  );
  // Experimental is a row too, landing on its switches in Diagnostics.
  await expect(rows.getByRole("link", { name: "Experimental" })).toHaveAttribute(
    "href",
    /\/settings\/diagnostics\?highlight=experimental/,
  );

  await rows.getByRole("link", { name: "Keyboard" }).click();
  await expect(page).toHaveURL(/\/settings\/keyboard$/);
  // A page under Advanced keeps Advanced current, and says where it sits.
  await expect(advanced).toHaveAttribute("aria-current", "page");
  await expect(general).not.toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("settings-subpage-back")).toHaveText("Advanced");
  await expect(page.getByTestId("general-settings")).toHaveCount(0);
  const scroller = page.locator("main :has(> [data-settings-results])");
  await scroller.evaluate((el) => el.scrollTo({ top: 400 }));

  // A new page opens at the top; Back returns to the page and to where it was left.
  await nav(page).getByRole("link", { name: "Notifications" }).click();
  await expect(page.getByTestId("notification-settings")).toBeVisible();
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(0);
  await page.goBack();
  await expect(page).toHaveURL(/\/settings\/keyboard$/);
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(400);
  await page.goForward();
  await expect(page).toHaveURL(/\/settings\/notifications$/);

  // Esc leaves Settings from any tab, and ⌘, comes back to the one left open.
  await page.getByRole("heading", { name: "Settings", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(page).not.toHaveURL(/\/settings/);
  await page.keyboard.press("ControlOrMeta+,");
  await expect(page).toHaveURL(/\/settings\/notifications$/);
});

test("search finds settings on every page, grouped by page", async ({ page }) => {
  await page.goto("/settings/general");
  const general = page.getByTestId("general-settings");
  await expect(general.getByLabel("Default folder", { exact: true })).toBeVisible();
  const results = page.locator("[data-settings-results]");
  const pageHeading = (name: string) => results.getByRole("heading", { level: 2, name });

  await page.keyboard.press("ControlOrMeta+f");
  const search = page.getByRole("textbox", { name: "Search settings" });
  await expect(search).toBeFocused();

  // A field on another page, live under that page's heading; the open page goes.
  await search.fill("font size");
  await expect(page.getByLabel("Terminal font size")).toBeVisible();
  await expect(page.getByLabel("Interface font")).toBeHidden();
  await expect(pageHeading("Appearance")).toBeVisible();
  await expect(pageHeading("General")).toBeHidden();

  // A keyword finds an Appearance control.
  await search.fill("dark");
  await expect(page.getByRole("group", { name: "Mode" })).toBeVisible();
  await expect(page.getByLabel("Terminal font size")).toBeHidden();

  // A page that isn't built from fields is found by its name, with its description.
  await search.fill("litellm");
  await expect(pageHeading("Gateways")).toBeVisible();
  await expect(results).toContainText("OpenAI-compatible gateways");
  // Workspaces were under Experimental until 0.7, and the old word still finds them.
  await search.fill("experimental");
  await expect(pageHeading("Workspaces")).toBeVisible();
  await expect(page.getByRole("switch", { name: /Resume workers on restart/ })).toBeVisible();

  // A page's name shows the whole page, and one query can match on several pages.
  await search.fill("NOTIFICATIONS");
  await expect(page.getByLabel("Desktop notifications")).toBeVisible();
  await expect(page.getByTestId("notification-settings").getByText("Maximum age")).toBeVisible();
  await search.fill("review");
  await expect(pageHeading("Notifications")).toBeVisible();
  await expect(pageHeading("Review bots")).toBeVisible();

  // A shortcut's name finds its row, under its group and the Keyboard heading.
  await search.fill("find in thread");
  await expect(page.getByTestId("binding-thread.find")).toBeVisible();
  await expect(page.getByTestId("binding-terminal.find")).toBeHidden();
  await expect(pageHeading("Keyboard")).toBeVisible();
  await expect(page.getByRole("region", { name: "Thread", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Terminal", exact: true })).toBeHidden();
  await search.fill("search settings");
  await expect(page.getByTestId("binding-settings.search")).toBeVisible();

  await search.fill("zzzz");
  await expect(page.getByTestId("settings-search-empty")).toHaveText("No settings match “zzzz”.");
  await expect(results.getByRole("heading")).toHaveCount(0);

  // Esc clears first; from an empty box it steps out, and only the next one leaves Settings.
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  await expect(page.getByTestId("settings-search-empty")).toBeHidden();
  await expect(general.getByLabel("Default folder", { exact: true })).toBeVisible();
  await expect(pageHeading("Keyboard")).toBeHidden();
  await search.press("Escape");
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeFocused();
  await expect(page).toHaveURL(/\/settings\/general$/);

  // Enter opens the page of the first match, with it marked: a row under Advanced included.
  await search.fill("log level");
  await search.press("Enter");
  await expect(page).toHaveURL(/\/settings\/diagnostics\?highlight=log/);
  await expect(search).toHaveValue("");
  await expect(page.getByTestId("settings-subpage-back")).toHaveText("Advanced");
  await expect(page.locator("[data-setting-spotlight]").first()).toBeInViewport();
  await page.goto("/settings/general");
  await page.keyboard.press("ControlOrMeta+f");

  // A result's page is one click away, with what the search found marked and in view.
  await search.fill("font size");
  await pageHeading("Appearance").getByRole("link").click();
  await expect(page).toHaveURL(/\/settings\/appearance\?highlight=font/);
  await expect(search).toHaveValue("");
  const size = page
    .locator("[data-setting-spotlight]")
    .filter({ has: page.getByLabel("Terminal font size") });
  await expect(size).toBeInViewport();
  await page.mouse.click(1, 1);
  await expect(page.locator("[data-setting-spotlight]")).toHaveCount(0);

  // The group list clears a search too.
  const scroller = page.locator("main :has(> [data-settings-results])");
  await scroller.evaluate((el) => el.scrollTo({ top: 200 }));
  await search.fill("font");
  await nav(page).getByRole("link", { name: "Advanced", exact: true }).click();
  await expect(search).toHaveValue("");
  await expect(pageHeading("Advanced")).toBeInViewport();

  // Back to the highlighted entry returns to where it was left, and doesn't mark it again.
  await page.goBack();
  await expect(page).toHaveURL(/\/settings\/appearance\?highlight=font/);
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(200);
  await expect(page.locator("[data-setting-spotlight]")).toHaveCount(0);
});

test("a link into Settings lands on its page and marks the setting", async ({ page }) => {
  // The review requests list, in the right panel's Reviews tab, links to its settings from its menu.
  await reviewsInPanel(page, { requests: true });
  await page.goto("/t/t-question");
  await openReviewsTab(page);
  await page.getByTestId("review-requests").click({ button: "right" });
  await page
    .getByTestId("review-requests-menu")
    .getByRole("menuitem", { name: "Notification settings…" })
    .click();
  await expect(page).toHaveURL(/\/settings\/notifications/);
  await expect(
    page.locator("[data-setting-spotlight]").getByRole("heading", { name: "Review requests" }),
  ).toBeInViewport();
});

test("diagnostics set the log level and copy a report to the clipboard", async ({ page }) => {
  await page.goto("/settings/diagnostics");
  const diagnostics = page.getByTestId("diagnostics");
  await expect(diagnostics).toContainText("1.0.0-mock");

  await diagnostics.getByRole("radio", { name: "debug" }).click();
  await expect(diagnostics.getByRole("radio", { name: "debug" })).toHaveAttribute(
    "aria-checked",
    "true",
  );

  await diagnostics.getByRole("button", { name: "Copy diagnostics" }).click();
  await expect(diagnostics.getByRole("status")).toHaveText("Diagnostics copied to the clipboard.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("Gram diagnostics");
});

test("what's new lists the shipped highlights", async ({ page }) => {
  await page.goto("/settings/help");
  const whatsNew = page.getByTestId("whats-new");
  await expect(whatsNew).toContainText("You're running Gram 1.0.0-mock.");
  await expect(whatsNew.getByRole("region", { name: "What's new in 1.0.0" })).toContainText(
    "Your own Claude Code and Codex",
  );
});

const MOCK_SETTINGS_KEY = "gram.mock.settings";

test("what's new shows once after an update and reopens from its page", async ({ page }) => {
  await page.goto("/settings/help");
  const help = page.getByTestId("whats-new");
  const dialog = page.getByTestId("whats-new-dialog");
  await expect(help).toContainText("You're running Gram 1.0.0-mock.");

  // A first launch records the version without showing anything.
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(sessionStorage.getItem(key) ?? "{}").onboarding?.lastSeenVersion,
        MOCK_SETTINGS_KEY,
      ),
    )
    .toBe("1.0.0-mock");
  await expect(dialog).toBeHidden();

  // As if the previous launch ran an older version.
  await page.evaluate((key) => {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? "{}");
    saved.onboarding.lastSeenVersion = "0.0.9";
    sessionStorage.setItem(key, JSON.stringify(saved));
  }, MOCK_SETTINGS_KEY);
  await page.reload();
  await expect(dialog.getByRole("region", { name: "What's new in 1.0.0" })).toContainText(
    "Your own Claude Code and Codex",
  );
  await dialog.getByRole("button", { name: "Got it" }).click();
  await expect(dialog).toBeHidden();

  await page.reload();
  await expect(help).toContainText("You're running Gram 1.0.0-mock.");
  await expect(dialog).toBeHidden();

  await help.getByRole("button", { name: "Show What's New" }).click();
  await expect(dialog).toContainText("Your own Claude Code and Codex");
});

test("side panel position, fonts and the Windows shell apply live", async ({ page }) => {
  await page.goto("/settings/general");
  const general = page.getByTestId("general-settings");

  await general.getByRole("radio", { name: "Left", exact: true }).click();
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-panel-side", "left");
  await openAdvancedPage(page, "Terminal");
  const terminal = page.getByTestId("terminal-settings");
  await terminal.getByRole("radio", { name: "Git Bash" }).click();
  await expect(terminal.getByRole("radio", { name: "Git Bash" })).toHaveAttribute(
    "aria-checked",
    "true",
  );

  await nav(page).getByRole("link", { name: "Appearance" }).click();
  const fonts = page.getByTestId("font-settings");
  await fonts.getByLabel("Interface font").fill("Courier New");
  await fonts.getByLabel("Interface font").press("Enter");
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--font-ui")))
    .toContain("Courier New");

  await page.goto("/t/t-flaky");
  const panel = page.getByTestId("right-panel");
  await expect(panel).toBeVisible();
  const panelBox = await panel.boundingBox();
  const mainBox = await page.locator("main").boundingBox();
  expect(panelBox!.x).toBeLessThan(mainBox!.x);
});

test("a narrow window gives Settings its width: no right panel, and the tabs fold into a picker", async ({
  page,
}) => {
  // Under 1280 px the overview is its 60 px rail, so this leaves Settings about 640 px: under the
  // 672 px where its tabs fold.
  await page.setViewportSize({ width: 700, height: 700 });
  await page.goto("/settings/general");
  await expect(page.getByTestId("general-settings")).toBeVisible();
  await expect(page.getByTestId("right-panel")).toHaveCount(0);
  await expect(nav(page).getByRole("link", { name: "Notifications" })).toBeHidden();
  const picker = nav(page).getByRole("combobox", { name: "Settings section" });
  await expect(picker).toHaveText(/General/);
  await picker.click();
  await page.getByRole("option", { name: "Notifications" }).click();
  await expect(page).toHaveURL(/\/settings\/notifications$/);
  await expect(page.getByTestId("notification-settings")).toBeVisible();
  const width = await page.evaluate(() => {
    const results = document.querySelector<HTMLElement>("[data-settings-results]")!;
    return results.getBoundingClientRect().width;
  });
  expect(width).toBeGreaterThan(560);

  // The panel is still there for the thread pages, and can be shown here too.
  await page.getByRole("button", { name: "Show right panel" }).click();
  await expect(page.getByTestId("right-panel")).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(nav(page).getByRole("link", { name: "Notifications" })).toBeVisible();
});
