import { expect, test, type Locator, type Page } from "@playwright/test";

import { dragAndDrop } from "./drag";
import { setLayout } from "./layout";
import { threadRow } from "./thread-row";

// The overview's Solo threads draw only the rows near the view (performance pass item 11): with
// 150 threads a few dozen rows are on the page, laid out where all of them would be. The arrows,
// Home and End walk them by their order, ⌘⌥S scrolls the current one into view, the row last
// focused and a dragged one stay drawn, and folding, resizing and the menus behave as before.

const COUNT = 150;

const overview = (page: Page) => page.getByTestId("overview-sidebar");
const solo = (page: Page) => overview(page).getByTestId("overview-section-solo");
/** The unparked list, the first under Solo threads; the folded Parked line has its own. */
const scroller = (page: Page) => solo(page).locator("[data-virtual-list]").first();
const rows = (page: Page) => scroller(page).getByTestId("overview-solo");

/** 150 solo threads besides the seeded ones, three of them at work; their ids, latest first. */
const seed = async (page: Page, path = "/t/t-deps") => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(path);
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  const ids = await page.evaluate(
    (idle) => window.gramMock!.seedBusyThreads({ streaming: 3, idle }),
    COUNT - 3,
  );
  await expect(threadRow(page, ids[0]!)).toBeVisible();
  return ids;
};

/** Scrolls the overview's column by `top` pixels, from its top. */
const scrollOverview = (page: Page, top: number | "end") =>
  scroller(page).evaluate((list, to) => {
    let parent = list.parentElement;
    while (parent !== null && !/auto|scroll/.test(getComputedStyle(parent).overflowY)) {
      parent = parent.parentElement;
    }
    parent!.scrollTop = to === "end" ? parent!.scrollHeight : to;
  }, top);

/** The index a solo row has in its list, as its drawn wrapper carries it. */
const indexOf = (row: Locator) =>
  row.evaluate((element) => Number(element.closest<HTMLElement>("[data-index]")!.dataset["index"]));

/** The focused solo row's index in its list, or -1 off the list. */
const focusedIndex = (page: Page) =>
  page.evaluate(() => {
    const row = document.activeElement?.closest<HTMLElement>("[data-virtual-list] > [data-index]");
    return row === null || row === undefined ? -1 : Number(row.dataset["index"]);
  });

/** The drawn rows' boxes in order: each sits a pixel under the one before, none overlapping. */
const expectContiguous = async (page: Page) => {
  const boxes = await rows(page).evaluateAll((all) =>
    all
      .map((row) => {
        const wrapper = row.closest<HTMLElement>("[data-index]")!;
        const box = wrapper.getBoundingClientRect();
        return { index: Number(wrapper.dataset["index"]), top: box.top, bottom: box.bottom };
      })
      .toSorted((a, b) => a.index - b.index),
  );
  for (const [i, box] of boxes.entries()) {
    const before = boxes[i - 1];
    if (before === undefined || before.index !== box.index - 1) continue;
    // To the fraction of a pixel, as the page itself would stack them.
    expect(Math.abs(box.top - (before.bottom + 1))).toBeLessThan(0.1);
  }
  return boxes;
};

test("150 solo threads draw a few dozen rows, laid out as the whole list would be", async ({
  page,
}) => {
  await seed(page);
  const title = solo(page).getByRole("button").first();
  const listed = Number((await title.textContent())?.match(/\d+$/)?.[0]);
  expect(listed).toBeGreaterThanOrEqual(COUNT);
  const drawn = await rows(page).count();
  expect(drawn).toBeGreaterThan(5);
  expect(drawn).toBeLessThan(60);
  await expectContiguous(page);
  // The list is as tall as every row: scrolled to the end, its last row draws there.
  await scrollOverview(page, "end");
  await expect
    .poll(async () =>
      Math.max(
        ...(await rows(page).evaluateAll((all) =>
          all.map((row) => Number(row.closest<HTMLElement>("[data-index]")!.dataset["index"])),
        )),
      ),
    )
    .toBe(listed - 1);
  await expectContiguous(page);
  expect(await rows(page).count()).toBeLessThan(60);
});

test("rows keep a pixel apart as the overview narrows and widens, whatever their height", async ({
  page,
}) => {
  await seed(page);
  const handle = page.getByRole("separator", { name: "Resize overview" });
  for (const width of [180, 380, 260]) {
    const box = (await handle.boundingBox())!;
    const current = Number(await handle.getAttribute("aria-valuenow"));
    const y = box.y + 80;
    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + width - current, y, { steps: 6 });
    await page.mouse.up();
    await expect(handle).toHaveAttribute("aria-valuenow", String(width));
    await expectContiguous(page);
  }
  // A row grown taller (a long title wrapping, a larger text size) moves the ones under it down.
  const first = rows(page).first();
  const second = rows(page).nth(1);
  await first.evaluate((row) => {
    row.style.paddingBottom = "40px";
  });
  await expect
    .poll(async () => (await second.boundingBox())!.y - (await first.boundingBox())!.y)
    .toBeGreaterThan(60);
  await expectContiguous(page);
});

test("the arrows walk the rows in order past the drawn ones, and Home and End reach the ends", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem(
      "gram.mock.settings",
      JSON.stringify({
        layout: { overviewSections: { pullRequests: false, doneToday: false, usage: false } },
      }),
    ),
  );
  await seed(page);
  const first = rows(page).first();
  await first.focus();
  expect(await focusedIndex(page)).toBe(0);
  const drawn = await rows(page).count();
  // Well past what was drawn when the walk began.
  for (let step = 1; step <= drawn + 20; step++) {
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => focusedIndex(page)).toBe(step);
  }
  await expect(page.locator(":focus")).toBeInViewport();
  for (let step = drawn + 19; step >= drawn; step--) {
    await page.keyboard.press("ArrowUp");
    await expect.poll(() => focusedIndex(page)).toBe(step);
  }
  // End lands on the Parked line under the list; up from it is the list's last row, drawn only
  // then, and up again the one before.
  const listed = Number(
    (await solo(page).getByRole("button").first().textContent())?.match(/\d+$/)?.[0],
  );
  await page.keyboard.press("End");
  await expect(overview(page).getByTestId("overview-parked").getByRole("button")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => focusedIndex(page)).toBe(listed - 1);
  await expect(page.locator(":focus")).toBeInViewport();
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => focusedIndex(page)).toBe(listed - 2);
  await page.keyboard.press("Home");
  await expect(overview(page).getByTestId("overview-needs-you")).toBeFocused();
});

test("Tab goes on through the rows past the drawn ones, and Shift+Tab back", async ({ page }) => {
  await seed(page);
  await rows(page).first().focus();
  const drawn = await rows(page).count();
  for (let step = 1; step <= drawn + 10; step++) {
    await page.keyboard.press("Tab");
    await expect.poll(() => focusedIndex(page)).toBe(step);
  }
  await expect(page.locator(":focus")).toBeInViewport();
  await page.keyboard.press("Shift+Tab");
  await expect.poll(() => focusedIndex(page)).toBe(drawn + 9);
});

test("⌘⌥S focuses the open thread's row when it is scrolled far out of view", async ({ page }) => {
  const ids = await seed(page);
  const far = ids.at(-1)!;
  await page.evaluate((to) => {
    window.history.pushState({}, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, `/t/${far}`);
  await expect(page).toHaveURL(new RegExp(`/t/${far}$`));
  await scrollOverview(page, 0);
  await expect(threadRow(page, far)).toHaveCount(0);
  await page.getByLabel("Message", { exact: true }).click();
  await page.keyboard.press("ControlOrMeta+Alt+s");
  const row = threadRow(page, far);
  await expect(row).toBeFocused();
  await expect(row).toHaveAttribute("aria-current", "true");
  await expect(row).toBeInViewport();
});

test("the focused row stays on the page scrolled away, and the arrows go on from it", async ({
  page,
}) => {
  await seed(page);
  const row = rows(page).nth(2);
  const id = (await row.getAttribute("data-thread-id"))!;
  await row.focus();
  const index = await indexOf(row);
  await scrollOverview(page, "end");
  await expect(threadRow(page, id)).toBeFocused();
  await expect(threadRow(page, id)).not.toBeInViewport();
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => focusedIndex(page)).toBe(index + 1);
  await expect(page.locator(":focus")).toBeInViewport();
});

test("a row's menu gives the focus back to it, and a row drawn far down drags onto a pane", async ({
  page,
}) => {
  const ids = await seed(page);
  await scrollOverview(page, "end");
  const far = threadRow(page, ids.at(-2)!);
  await expect(far).toBeVisible();
  await far.focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menuitem", { name: "More…" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(far).toBeFocused();

  await setLayout(page, "2 columns");
  const panes = page.getByTestId("pane");
  await expect(panes).toHaveCount(2);
  await expect(page.getByTestId("empty-pane")).toHaveCount(1);
  await dragAndDrop(page, far, panes.nth(1));
  await expect(panes.nth(1)).toHaveAttribute("data-thread-id", ids.at(-2)!);
});

test("folded, Solo threads draw nothing that takes the focus; unfolded, they draw under the title", async ({
  page,
}) => {
  await seed(page);
  const title = solo(page).getByRole("button").first();
  await title.click();
  await expect(title).toHaveAttribute("aria-expanded", "false");
  await expect(rows(page).first()).toBeHidden();
  await title.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(":focus")).not.toHaveAttribute("data-testid", "overview-solo");
  await title.click();
  await expect(title).toHaveAttribute("aria-expanded", "true");
  const first = rows(page).first();
  await expect(first).toBeVisible();
  expect(await indexOf(first)).toBe(0);
  const head = (await title.boundingBox())!;
  const top = (await first.boundingBox())!;
  expect(top.y).toBeGreaterThanOrEqual(head.y + head.height);
  expect(top.y - (head.y + head.height)).toBeLessThan(8);
  await expectContiguous(page);
});

test("a thread at work keeps its working dot when its row draws on scrolling", async ({ page }) => {
  const ids = await seed(page);
  // The three at work are the latest; scrolled away and back, their rows draw anew.
  await scrollOverview(page, "end");
  await expect(threadRow(page, ids[0]!)).toHaveCount(0);
  await scrollOverview(page, 0);
  const row = threadRow(page, ids[0]!);
  await expect(row).toBeVisible();
  await expect(row).toHaveAccessibleName(/Working/);
  await expect(row.locator("span").first()).toHaveClass(/text-status-working/);
});

/** The overview column's scroll offset. */
const overviewScroll = (page: Page) =>
  scroller(page).evaluate((list) => {
    let parent = list.parentElement;
    while (parent !== null && !/auto|scroll/.test(getComputedStyle(parent).overflowY)) {
      parent = parent.parentElement;
    }
    return parent!.scrollTop;
  });

test("opening Parked, and unfolding Solo threads that filled while folded, move nothing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/t/t-deps");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  // Folded first, so the 150 rows are drawn while the section has no box.
  const title = solo(page).getByRole("button").first();
  await title.click();
  await expect(title).toHaveAttribute("aria-expanded", "false");
  await page.evaluate(() => window.gramMock!.seedBusyThreads({ streaming: 0, idle: 150 }));
  await expect(title).toContainText(/1[56]\d$/);
  expect(await overviewScroll(page)).toBe(0);
  await title.click();
  await expect(rows(page).first()).toBeVisible();
  await page.waitForTimeout(300);
  expect(await overviewScroll(page)).toBe(0);
  await expectContiguous(page);

  // Parked's rows were drawn closed; opened at the foot of the column, the column stays put.
  await scrollOverview(page, "end");
  const parkedLine = overview(page).getByTestId("overview-parked").getByRole("button").first();
  await expect(parkedLine).toBeInViewport();
  const before = await overviewScroll(page);
  await parkedLine.click();
  await expect(parkedLine).toHaveAttribute("aria-expanded", "true");
  await page.waitForTimeout(300);
  expect(Math.abs((await overviewScroll(page)) - before)).toBeLessThan(1);
});

test("with nothing after the list, End lands on its last row though it wasn't drawn", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem(
      "gram.mock.settings",
      JSON.stringify({
        layout: { overviewSections: { pullRequests: false, doneToday: false, usage: false } },
      }),
    ),
  );
  await seed(page);
  // No Parked line: the list's last row is the overview's last stop.
  const parked = await overview(page)
    .getByTestId("overview-parked")
    .locator("[data-thread-id]")
    .evaluateAll((all) => all.map((row) => row.getAttribute("data-thread-id")!));
  await page.evaluate(async (ids) => {
    for (const id of ids) await window.gramMock!.park(id as never, false);
  }, parked);
  await expect(overview(page).getByTestId("overview-parked")).toHaveCount(0);
  const listed = Number(
    (await solo(page).getByRole("button").first().textContent())?.match(/\d+$/)?.[0],
  );
  await rows(page).first().focus();
  await page.keyboard.press("End");
  await expect.poll(() => focusedIndex(page)).toBe(listed - 1);
  await expect(page.locator(":focus")).toBeInViewport();
});

test("Tab from Solo threads' title enters the list at its first row, a far row kept drawn or not", async ({
  page,
}) => {
  await seed(page);
  // A row far down keeps focus's place while it is scrolled away, and is drawn first.
  await scrollOverview(page, "end");
  const far = rows(page).last();
  await far.focus();
  await scrollOverview(page, 0);
  const title = solo(page).getByRole("button").first();
  await title.focus();
  await page.keyboard.press("Tab");
  await expect.poll(() => focusedIndex(page)).toBe(0);
  await page.keyboard.press("Shift+Tab");
  await expect(title).toBeFocused();
});

test("rows in view stay put when what is above them grows, as the browser keeps rows in flow", async ({
  page,
}) => {
  await seed(page);
  await scrollOverview(page, 2_000);
  const row = rows(page).and(page.getByRole("button", { name: /^Quiet thread 60,/ }));
  await expect(row).toBeInViewport();
  const top = async () => (await row.boundingBox())!.y;
  const at = await top();
  // A section above grows (a workspace's workers arriving), then one appears (turned on in Settings).
  await overview(page)
    .getByTestId("overview-section-orchestrators")
    .evaluate((section) => {
      const more = document.createElement("div");
      more.style.height = "40px";
      section.append(more);
    });
  await expect.poll(top).toBeCloseTo(at, 0);
  await overview(page)
    .getByTestId("overview-needs-you")
    .evaluate((pill) => {
      const added = document.createElement("div");
      added.style.height = "30px";
      pill.parentElement!.insertBefore(added, pill.nextSibling);
    });
  await page.waitForTimeout(200);
  await expect.poll(top).toBeCloseTo(at, 0);
});
