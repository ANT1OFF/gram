import { expect, test } from "@playwright/test";

import { openReviewsTab, reviewsInPanel } from "./reviews-panel";
import { openSettingsPage, settingsNav as nav } from "./settings-nav";

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

test("a folder field says how to save, then Saved, and why a path can't be saved", async ({
  page,
}) => {
  await page.goto("/settings/general");
  const general = page.getByTestId("general-settings");
  const folder = general.getByLabel("Default folder", { exact: true });
  const row = general
    .locator("[data-setting]")
    .filter({ has: page.getByLabel("Default folder", { exact: true }) });

  await folder.fill("~/work/sandbox");
  await expect(row.getByTestId("setting-unsaved")).toHaveText("Enter to save · Esc to cancel");
  await folder.press("Enter");
  // The row that saved says so, though the save changed its value and its reset now shows.
  await expect(row.getByTestId("setting-saved")).toBeVisible();
  await expect(row.getByTestId("setting-unsaved")).toHaveCount(0);
  await expect(row.getByTestId("setting-reset")).toBeVisible();

  // A relative path is not saved: the field says why, in place, and keeps the draft to fix.
  await folder.fill("work");
  await folder.press("Enter");
  await expect(row.getByText("Use a full path, starting with ~/ or /.")).toBeVisible();
  await expect(folder).toHaveAttribute("aria-invalid", "true");
  await expect(folder).toHaveValue("work");
  // Escape puts the saved value back.
  await folder.press("Escape");
  await expect(folder).toHaveValue("~/work/sandbox");
  await expect(row.getByText("Use a full path, starting with ~/ or /.")).toHaveCount(0);

  await page.reload();
  await expect(folder).toHaveValue("~/work/sandbox");

  // A pointer saves with the Save beside the dirty field, and Undo puts the old path back.
  await folder.fill("~/work/other");
  await expect(row.getByTestId("setting-unsaved")).toHaveText("Enter to save · Esc to cancel");
  await row.getByRole("button", { name: "Save", exact: true }).click();
  await expect(row.getByTestId("setting-saved")).toBeVisible();
  await expect(row.getByTestId("setting-draft-actions")).toHaveCount(0);
  await row.getByTestId("setting-undo").click();
  await expect(folder).toHaveValue("~/work/sandbox");
  // Cancel drops a draft without saving it.
  await folder.fill("~/elsewhere");
  await row.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(folder).toHaveValue("~/work/sandbox");
  await page.reload();
  await expect(folder).toHaveValue("~/work/sandbox");
});

test("each tab is a page, with history, and Settings reopens on the last one", async ({ page }) => {
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings\/general$/);
  const general = nav(page).getByRole("link", { name: "General", exact: true });
  await expect(general).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { level: 2, name: "General" })).toBeVisible();

  // The groups, one link each, and no catch-all Advanced: each page sits in the group it is about.
  await expect(nav(page).locator(":scope > ul > li > a")).toHaveText([
    "General",
    "Agents & models",
    "Usage",
    "Workspaces & merging",
    "Appearance",
    "Notifications",
    "Keyboard",
    "Voice",
    "About",
  ]);
  await expect(nav(page).getByRole("link", { name: "Workspaces & merging" })).toHaveAttribute(
    "href",
    "/settings/workspaces",
  );
  await expect(nav(page).getByRole("link", { name: "Advanced" })).toHaveCount(0);

  // A group's own pages are linked at the end of its page and under it in the nav.
  const about = nav(page).getByRole("link", { name: "About", exact: true });
  await about.click();
  await expect(page).toHaveURL(/\/settings\/about$/);
  const rows = page.getByTestId("settings-subpages");
  await expect(rows.getByRole("link", { name: /What's New/ })).toHaveAttribute(
    "href",
    "/settings/help",
  );
  await expect(nav(page).getByTestId("settings-nav-subpages").getByRole("link")).toHaveText([
    "Diagnostics",
    "What's New",
  ]);
  await rows.getByRole("link", { name: /Diagnostics/ }).click();
  await expect(page).toHaveURL(/\/settings\/diagnostics$/);
  // A page in a group keeps its group marked, and says where it sits.
  await expect(about).toHaveAttribute("aria-current", "true");
  await expect(
    nav(page).getByTestId("settings-nav-subpages").getByRole("link", { name: "Diagnostics" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(general).not.toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("settings-subpage-back")).toHaveText("About");

  await nav(page).getByRole("link", { name: "Keyboard", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/keyboard$/);
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
  await expect(pageHeading("Workspaces & merging")).toBeVisible();
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

  // Enter opens the page of the first match, with it marked: a page within a group included.
  await search.fill("log level");
  await search.press("Enter");
  await expect(page).toHaveURL(/\/settings\/diagnostics\?highlight=log/);
  await expect(search).toHaveValue("");
  await expect(page.getByTestId("settings-subpage-back")).toHaveText("About");
  await expect(page.locator("[data-setting-spotlight]").first()).toBeInViewport();
  await page.goto("/settings/general");
  await page.keyboard.press("ControlOrMeta+f");

  // A result's page is one click away, with what the search found marked and in view.
  await search.fill("font size");
  await pageHeading("Appearance").getByRole("link").click();
  await expect(page).toHaveURL(/\/settings\/appearance\?highlight=font/);
  await expect(search).toHaveValue("");
  // Transcript text size answers "font size" too, and comes first on the page, so it is in view.
  const spotlit = page.locator("[data-setting-spotlight]");
  await expect(spotlit.filter({ hasText: "Transcript text size" })).toBeInViewport();
  await expect(spotlit.filter({ has: page.getByLabel("Terminal font size") })).toHaveCount(1);
  await page.mouse.click(1, 1);
  await expect(page.locator("[data-setting-spotlight]")).toHaveCount(0);

  // The group list clears a search too.
  const scroller = page.locator("main :has(> [data-settings-results])");
  await scroller.evaluate((el) => el.scrollTo({ top: 200 }));
  await search.fill("font");
  await nav(page).getByRole("link", { name: "About", exact: true }).click();
  await expect(search).toHaveValue("");
  await expect(pageHeading("About")).toBeInViewport();

  // Back to the highlighted entry returns to where it was left, and doesn't mark it again.
  await page.goBack();
  await expect(page).toHaveURL(/\/settings\/appearance\?highlight=font/);
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(200);
  await expect(page.locator("[data-setting-spotlight]")).toHaveCount(0);
});

test("old Advanced and Updates links land on the pages' new homes", async ({ page }) => {
  await page.goto("/settings/advanced");
  await expect(page).toHaveURL(/\/settings\/general$/);
  await page.goto("/settings/advanced/gateways");
  await expect(page).toHaveURL(/\/settings\/gateways$/);
  await expect(page.getByTestId("settings-subpage-back")).toHaveText("Agents & models");
  await page.goto("/settings/advanced/updates");
  await expect(page).toHaveURL(/\/settings\/about$/);
  await page.goto("/settings/updates");
  await expect(page).toHaveURL(/\/settings\/about$/);
  await expect(
    page.locator("[data-settings-results]").getByRole("heading", { level: 2, name: "About" }),
  ).toBeVisible();

  // The old word still finds what it held, each page under its new group.
  await page.getByRole("textbox", { name: "Search settings" }).fill("advanced");
  const results = page.locator("[data-settings-results]");
  for (const name of ["Gateways", "Connectors", "Review bots", "Storage", "Keyboard"])
    await expect(results.getByRole("heading", { level: 2, name })).toBeVisible();
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
  // Which version this is shows on About; Diagnostics keeps the paths.
  await page.goto("/settings/about");
  await expect(page.locator("[data-settings-results]")).toContainText("1.0.0-mock");
  await page.goto("/settings/diagnostics");
  const diagnostics = page.getByTestId("diagnostics");
  await expect(diagnostics).toContainText("/mock/gram-state");

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
  await openSettingsPage(page, "Terminal");
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
  // Settings has no overview beside it, so the window is its width: under the 672 px where its
  // tabs fold.
  await page.setViewportSize({ width: 640, height: 700 });
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

test("Settings is focused: the overview gives way to Back, and General's sections are linked", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByTestId("overview-sidebar")).toBeVisible();
  await page
    .getByTestId("top-left-nav")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await expect(page).toHaveURL(/\/settings\/general$/);
  // One column of navigation, not two: the overview steps aside, and the title bar says where you
  // are, with Back.
  await expect(page.getByTestId("overview-sidebar")).toHaveCount(0);
  const title = page.getByTestId("settings-title");
  await expect(title).toHaveText("Settings");

  // General's subsections, linked under it, scroll the page to each.
  const sections = page.getByTestId("settings-page-sections");
  await expect(sections.getByRole("link")).toHaveText([
    "Launch",
    "Navigation",
    "Folders & branches",
    "Sending",
    "Running work",
    "Editor",
    "Links",
  ]);
  await sections.getByRole("link", { name: "Running work" }).click();
  await expect(page.getByRole("region", { name: "Running work" })).toBeInViewport();
  await expect(sections.getByRole("link", { name: "Running work" })).toHaveAttribute(
    "aria-current",
    "location",
  );

  // A search shows matches from every page, so the page's own links step aside.
  const search = page.getByRole("textbox", { name: "Search settings" });
  await search.fill("branch prefix");
  await expect(sections).toHaveCount(0);
  await search.fill("");
  await expect(sections).toBeVisible();

  // Back leaves Settings, and the overview returns as it was.
  await title.getByRole("button", { name: /^Back/ }).click();
  await expect(page).not.toHaveURL(/\/settings/);
  await expect(page.getByTestId("overview-sidebar")).toBeVisible();
  await expect(page.getByTestId("settings-title")).toHaveCount(0);
});

test("opening Settings never shows its title bar beside the thread it is leaving", async ({
  page,
}) => {
  // Settings' code arrives late, as on a cold start, so the router keeps the thread up meanwhile.
  await page.route(/\/src\/(settings|routes\/settings)/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.continue();
  });
  await page.goto("/t/t-deps");
  const composer = page.getByLabel("Message", { exact: true });
  await expect(composer).toBeVisible();
  await page.evaluate(() => {
    const probe = { mixed: 0 };
    (window as unknown as { gramMixedFrames: typeof probe }).gramMixedFrames = probe;
    const sample = () => {
      const strip = document.querySelector('[data-testid="settings-title"]');
      const thread = document.querySelector('[aria-label="Message"]');
      if (strip && thread) probe.mixed++;
      if (!document.querySelector('[data-testid="general-settings"]'))
        requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.keyboard.press("ControlOrMeta+,");
  await expect(page.getByTestId("general-settings")).toBeVisible();
  await expect(page.getByTestId("settings-title")).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { gramMixedFrames: { mixed: number } }).gramMixedFrames.mixed,
    ),
  ).toBe(0);
});
