import { expect, test, type Page } from "@playwright/test";

import type { MockOneThreadSimulation } from "../src/api/mock-asks";
import { pressFirstWorkspaceKey } from "./thread-row";

// History: every past chat in one list, from the sidebar's foot, ⌘⇧H, the palette and ⌘J. Searched
// by title and repo as you type, narrowed by chip, grouped by date or by orchestrator, a page at a
// time. Mock state lives in memory, so every step after the seed stays inside the app, bar the
// reload the grouping is kept across.

const start = async (page: Page) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    if (sessionStorage.getItem("gram.mock.settings") === null)
      sessionStorage.setItem("gram.mock.settings", JSON.stringify({ panel: { open: false } }));
  });
  await page.goto("/t/t-flaky");
  await page.getByLabel("Message", { exact: true }).waitFor();
  const made: MockOneThreadSimulation = await page.evaluate(() =>
    window.gramMock!.simulateOneThread(),
  );
  await pressFirstWorkspaceKey(page);
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  await expect(page.getByTestId("feature-card").first()).toBeVisible();
  return made;
};

const history = (page: Page) => page.getByTestId("history");
const rows = (page: Page) => history(page).getByTestId("history-row");
const row = (page: Page, threadId: string) =>
  history(page).locator(`[data-testid="history-row"][data-thread-id="${threadId}"]`);
const chip = (page: Page, name: string) =>
  history(page).getByRole("radiogroup", { name: "Show" }).getByRole("radio", { name });
const ids = (page: Page) =>
  rows(page).evaluateAll((els) => els.map((el) => el.getAttribute("data-thread-id")!));
const attrs = (page: Page, name: string) =>
  rows(page).evaluateAll((els, attr) => els.map((el) => el.getAttribute(attr)), name);

const openFromSidebar = async (page: Page) => {
  const entry = page.getByTestId("overview-history");
  await expect(entry).toHaveText(/History/);
  await entry.click();
  await expect(history(page)).toBeVisible();
  await expect(page.getByTestId("history-search")).toBeFocused();
};

test("History lists finished workers, done and archived threads and past sessions, by date", async ({
  page,
}) => {
  const made = await start(page);
  await openFromSidebar(page);
  await expect(chip(page, "All")).toHaveAttribute("aria-checked", "true");

  // The workspace's finished workers, older ones too, the solo thread marked done, the archived
  // one, and a past CLI session no thread shows.
  await expect(row(page, made.doneToday)).toBeVisible();
  for (const id of [...made.earlier, "t-dark", "t-grpc"])
    await expect(row(page, id)).toBeAttached();
  await expect(rows(page).and(page.locator('[data-kind="imported"]')).first()).toBeAttached();

  // Under their days this week ("3 Nov", the shared day format) and their months before, today's
  // first.
  const groups = history(page).getByTestId("history-group");
  await expect(groups.first()).toHaveText("Today");
  for (const group of await groups.allTextContents())
    expect(group).toMatch(/^(Today|Yesterday|\d{1,2} [A-Z][a-z]{2}( \d{4})?|[A-Z][a-z]+ \d{4})$/);

  // A row says its title, workspace and repo, outcome, agent and time, 24-hour.
  const merged = row(page, made.doneToday);
  await expect(merged).toHaveAttribute("data-outcome", "merged");
  await expect(merged.getByTestId("history-where")).toHaveText("agent-platform · api");
  await expect(merged.getByTestId("history-outcome")).toHaveText("merged");
  await expect(merged.getByTestId("history-time")).toHaveText(/^\d{2}:\d{2}$/);
  await expect(merged).toHaveAccessibleName(
    // Its time is the shared stamp, the clock alone today; its group heading says "Today".
    /, agent-platform · api, merged, \d{2}:\d{2}, Claude/,
  );
  const dark = row(page, "t-dark");
  await expect(dark).toHaveAttribute("data-kind", "thread");
  await expect(dark.getByTestId("history-where")).toHaveText(/^Solo threads · /);
  await expect(dark.getByTestId("history-outcome")).toHaveText("delivered");
  await expect(row(page, "t-grpc")).toHaveAttribute("data-archived", "true");
  // Older than the week, a row says its date and its clock.
  await expect(row(page, made.earlier.at(-1)!).getByTestId("history-time")).toHaveText(
    /^\d{1,2} \w{3}( \d{4})? \d{2}:\d{2}$/,
  );

  // A click opens the thread where it was, and History goes.
  await merged.click();
  await expect(history(page)).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/t/${made.doneToday}$`));
});

test("History filters by title and repo as you type, and by kind with its chips", async ({
  page,
}) => {
  const made = await start(page);
  await openFromSidebar(page);
  const search = page.getByTestId("history-search");

  // By a word of a title.
  await search.fill("retry-after");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first().getByTestId("history-title")).toHaveText("Retry-After header");
  // By repo, every word counted.
  await search.fill("docs");
  for (const where of await rows(page).getByTestId("history-where").allTextContents())
    expect(where).toContain("docs");
  await search.fill("no such thing anywhere");
  await expect(history(page).getByTestId("history-empty").getByTestId("empty-title")).toHaveText(
    "No matches",
  );
  await search.fill("");

  // Each chip keeps only its kind.
  await chip(page, "Workers").click();
  await expect(chip(page, "Workers")).toHaveAttribute("aria-checked", "true");
  await expect(row(page, made.doneToday)).toBeVisible();
  expect(new Set(await attrs(page, "data-kind"))).toEqual(new Set(["worker"]));

  await chip(page, "Threads").click();
  await expect(row(page, "t-dark")).toBeVisible();
  for (const kind of await attrs(page, "data-kind"))
    expect(["thread", "orchestrator"]).toContain(kind);

  await chip(page, "Archived").click();
  await expect(row(page, "t-grpc")).toBeVisible();
  expect(new Set(await attrs(page, "data-archived"))).toEqual(new Set(["true"]));

  await chip(page, "Imported").click();
  await expect(rows(page).first()).toBeVisible();
  expect(new Set(await attrs(page, "data-kind"))).toEqual(new Set(["imported"]));
  // The search works within a chip.
  await search.fill("tracing");
  await expect(rows(page)).toHaveCount(1);
  // Its status says what it is; what Enter does is the cursor row's action, apart from it.
  await expect(rows(page).first().getByTestId("history-outcome")).toHaveText("imported");
  await expect(rows(page).first().getByTestId("history-action")).toHaveText(/^Resume/);

  // The chip is kept for the next opening.
  await page.keyboard.press("Escape");
  await expect(history(page)).toBeHidden();
  await openFromSidebar(page);
  await expect(chip(page, "Imported")).toHaveAttribute("aria-checked", "true");
});

test("an imported session resumes into a thread from History, with the keyboard", async ({
  page,
}) => {
  await start(page);
  await openFromSidebar(page);
  await chip(page, "Imported").click();
  await page.getByTestId("history-search").fill("flaky retry");
  const session = rows(page).first();
  await expect(session).toHaveAttribute("data-kind", "imported");
  await expect(session).toHaveAttribute("aria-selected", "true");
  await expect(session.getByTestId("history-where")).toHaveText("Imported sessions · api");
  await page.keyboard.press("Enter");
  await expect(history(page)).toBeHidden();
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  await expect(page).not.toHaveURL(/\/t\/t-flaky$/);
  await expect(page.getByTestId("pane-header").getByRole("heading").first()).toHaveText(
    "Speed up the flaky retry suite",
  );

  // Shown by a thread now, it is that thread's, not a session to resume again.
  await page.keyboard.press("ControlOrMeta+Shift+KeyH");
  await expect(history(page)).toBeVisible();
  await page.getByTestId("history-search").fill("flaky retry");
  await expect(rows(page)).toHaveCount(0);
});

test("⌘⇧H toggles History, the palette has it, and ⌘J leads to its finished workers", async ({
  page,
}) => {
  const made = await start(page);
  await page.keyboard.press("ControlOrMeta+Shift+KeyH");
  await expect(history(page)).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Shift+KeyH");
  await expect(history(page)).toBeHidden();

  await page.keyboard.press("ControlOrMeta+KeyK");
  await page.getByLabel("Go to, or > for commands").fill(">History");
  await page
    .getByRole("option", { name: /^History/ })
    .first()
    .click();
  await expect(history(page)).toBeVisible();
  // The palette finishes closing first: an Escape during its exit leaves it behind History.
  await expect(page.getByTestId("command-palette")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(history(page)).toBeHidden();

  // ⌘J lists the workers on now; the finished ones are a click away, in History on Workers.
  await page.keyboard.press("ControlOrMeta+KeyJ");
  const list = page.getByTestId("workers-list");
  await expect(list).toBeVisible();
  await expect(list.getByTestId("workers-section-done")).toHaveCount(0);
  await list.getByTestId("workers-history").click();
  await expect(list).toBeHidden();
  await expect(history(page)).toBeVisible();
  await expect(chip(page, "Workers")).toHaveAttribute("aria-checked", "true");
  await expect(row(page, made.doneToday)).toBeVisible();
});

test("History shows thirty rows, Show more pages on through every finished worker the server keeps", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/t/t-flaky");
  await page.getByLabel("Message", { exact: true }).waitFor();
  // 120 workers only the archive keeps, 18 hours apart: more than the server's first page of 50.
  const made = await page.evaluate(() => window.gramMock!.simulateLongHistory(120));
  await pressFirstWorkspaceKey(page);
  await openFromSidebar(page);
  await chip(page, "Workers").click();
  const more = history(page).getByTestId("history-more");
  await expect(rows(page)).toHaveCount(30);
  await expect(more).toHaveText("Show more");
  await more.click();
  await expect(rows(page)).toHaveCount(60);
  // Latest first, past what the server's first page held: the next pages come as they're needed.
  for (let click = 0; click < 10 && (await more.count()) > 0; click++) {
    const before = await rows(page).count();
    await more.click();
    await expect.poll(() => rows(page).count()).toBeGreaterThan(before);
  }
  await expect(more).toHaveCount(0);
  const listed = await ids(page);
  expect(listed).toEqual(expect.arrayContaining([...made.history]));
  expect(new Set(listed).size).toBe(listed.length);
  expect(listed.at(-1)).toBe(made.history.at(-1));
  // A few months back, by month.
  await expect(history(page).getByTestId("history-group").last()).toHaveText(/^[A-Z][a-z]+ \d{4}$/);
});

test("History groups by orchestrator on request, a choice kept across a reload", async ({
  page,
}) => {
  const made = await start(page);
  await openFromSidebar(page);
  const grouping = history(page).getByTestId("done-grouping");
  await expect(grouping).toHaveAttribute("title", "Group by date");
  await grouping.click();
  await page.getByRole("menuitemradio", { name: "Group by orchestrator" }).click();
  await expect(grouping).toHaveAttribute("title", "Group by orchestrator");
  const groups = history(page).getByTestId("history-group");
  await expect(groups.first()).toHaveAttribute("data-grouping", "orchestrator");
  const names = await groups.allTextContents();
  expect(names).toEqual(
    expect.arrayContaining(["agent-platform", "Solo threads", "Imported sessions"]),
  );
  expect(new Set(names).size).toBe(names.length);
  // Today's rows show a time, older ones their date and time.
  await expect(row(page, made.doneToday).getByTestId("history-time")).toHaveText(/^\d{2}:\d{2}$/);
  await expect(row(page, made.earlier[0]!).getByTestId("history-time")).toHaveText(
    /^\d{1,2} \w{3}( \d{4})? \d{2}:\d{2}$/,
  );

  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem("gram.layout") ?? "{}").state?.doneGrouping,
      ),
    )
    .toBe("orchestrator");
  await page.goto("/t/t-flaky");
  await page.getByLabel("Message", { exact: true }).waitFor();
  await openFromSidebar(page);
  await expect(history(page).getByTestId("done-grouping")).toHaveAttribute(
    "title",
    "Group by orchestrator",
  );
  // The workspace went with the reload; the solo threads and past sessions are still grouped.
  await expect(groups.filter({ hasText: /^Solo threads$/ })).toHaveCount(1);
  await expect(groups.filter({ hasText: /^agent-platform$/ })).toHaveCount(0);
});

test("the sidebar's Done shows the latest three and hands the rest to History's Done chip", async ({
  page,
}) => {
  await start(page);
  const done = page.getByTestId("overview-section-doneToday");
  const shown = done.getByTestId("overview-done");
  await expect(shown).toHaveCount(3);
  // One line each: every row is the same height, its title cut at the end.
  const heights = await shown.evaluateAll((els) =>
    els.map((el) => el.getBoundingClientRect().height),
  );
  expect(new Set(heights).size).toBe(1);
  const sidebarIds = await shown.evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-thread-id")!),
  );
  const more = done.getByTestId("overview-done-more");
  await expect(more).toHaveText(/^\d+ more in History$/);
  await more.click();
  await expect(history(page)).toBeVisible();
  await expect(chip(page, "Done")).toHaveAttribute("aria-checked", "true");
  // The same list: the sidebar's three lead History's Done, which holds no archived chat.
  expect((await ids(page)).slice(0, 3)).toEqual(sidebarIds);
  expect(await attrs(page, "data-outcome")).not.toContain("archived");
});

test("the palette hands a search that matches finished threads to History", async ({ page }) => {
  await start(page);
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByTestId("command-palette");
  await palette.getByRole("combobox").fill("dark mode");
  // The solo thread marked done is History's, not listed beside the live threads.
  await expect(palette.getByRole("option", { name: /Add dark mode toggle/ })).toHaveCount(0);
  const handoff = palette.getByRole("option", { name: /1 finished in History/ });
  await expect(handoff).toBeVisible();
  await handoff.click();
  await expect(history(page)).toBeVisible();
  await expect(page.getByTestId("history-search")).toHaveValue("dark mode");
  await expect(row(page, "t-dark")).toBeVisible();
});

test("Mark unread on a solo thread's row keeps it unread until it is opened", async ({ page }) => {
  await start(page);
  const solo = page
    .getByTestId("overview-sidebar")
    .locator('[data-testid="overview-solo"][data-thread-id="t-flaky"]');
  // Mark unread shares the row's "Come back later" submenu with Snooze.
  await solo.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Come back later" }).hover();
  await page.getByRole("menuitem", { name: "Mark unread" }).click();
  await expect(solo).toHaveAttribute("data-unread", "true");
  await expect(solo).toHaveAccessibleName(/, unread,/);
  await solo.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Come back later" }).hover();
  await expect(page.getByRole("menuitem", { name: "Mark read" })).toBeVisible();
  // Escape closes the submenu, then the row menu.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await solo.click();
  await expect(page).toHaveURL(/\/t\/t-flaky$/);
  await expect(solo).not.toHaveAttribute("data-unread");
});
