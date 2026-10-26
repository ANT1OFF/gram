import { expect, test, type Page } from "@playwright/test";

import { openOrchestrator, threadRow } from "./thread-row";

// The Board draws only the feature lines near the view (performance pass item 11): with 60
// features a dozen or so lines are on the page, each where the whole list would put it, whatever
// its height. Tab walks on past the drawn ones, a group's band still folds the lines under it away,
// and a worker's chip drawn anew on scrolling doesn't glide in from where it last was.

const FEATURES = 60;

const board = (page: Page) => page.getByTestId("rail-board");
const features = (page: Page) => board(page).getByRole("list", { name: "Features", exact: true });
/** The Features list's own entries: its lines and its groups' bands, not the lines inside a band. */
const entries = (page: Page) => features(page).locator(":scope > [data-index]");

/** The board scenario's workspace with 60 more features, the first with four workers. */
const seed = async (page: Page, scenario: "board" | "workerWaits" = "board") => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/t/t-flaky");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  const made = await page.evaluate(
    async ({ count, which }) => {
      const mock = window.gramMock!;
      const seeded =
        which === "board"
          ? await mock.simulateOrchestration("board")
          : await mock.simulateWorkerWaits();
      for (let i = 0; i < count; i++) {
        await mock.simulateBrief(seeded.workspaceId, `bulk-${i}`, `Worker on bulk ${i}`);
      }
      for (let i = 1; i < 4; i++) {
        await mock.simulateBrief(seeded.workspaceId, "bulk-0", `Worker ${i} on bulk 0`);
      }
      return seeded;
    },
    { count: FEATURES, which: scenario },
  );
  await openOrchestrator(page, made.orchestratorThreadId);
  await page
    .getByRole("radiogroup", { name: "View" })
    .getByRole("radio", { name: /^Board\b/ })
    .click();
  await expect(board(page)).toBeVisible();
  return made;
};

const scrollBoard = (page: Page, top: number | "end") =>
  features(page).evaluate((list, to) => {
    const scroller = list.closest<HTMLElement>(".overflow-y-auto")!;
    scroller.scrollTop = to === "end" ? scroller.scrollHeight : to;
  }, top);

/** The drawn entries' boxes in order: each starts where the one before ends, rule included. */
const expectContiguous = async (page: Page) => {
  const boxes = await entries(page).evaluateAll((all) =>
    all
      .map((entry) => {
        const box = entry.getBoundingClientRect();
        return {
          index: Number((entry as HTMLElement).dataset["index"]),
          top: box.top,
          bottom: box.bottom,
        };
      })
      .toSorted((a, b) => a.index - b.index),
  );
  for (const [i, box] of boxes.entries()) {
    const before = boxes[i - 1];
    if (before === undefined || before.index !== box.index - 1) continue;
    expect(Math.abs(box.top - before.bottom)).toBeLessThan(0.1);
  }
  return boxes;
};

/** Whether the drawn entries sit edge to edge, once a fold's height has settled. */
const contiguous = (page: Page) => async () => {
  try {
    await expectContiguous(page);
    return true;
  } catch {
    return false;
  }
};

const focusedEntry = (page: Page) =>
  page.evaluate(() => {
    const entry = document.activeElement?.closest<HTMLElement>(
      "[data-virtual-list] > [data-index]",
    );
    return entry === null || entry === undefined ? -1 : Number(entry.dataset["index"]);
  });

test("an open group plan keeps its unsaved draft when another row takes focus and it scrolls away", async ({
  page,
}) => {
  await seed(page, "workerWaits");
  const group = board(page).locator('[data-testid="rail-group"][data-group="casefile-cleanup"]');
  await group.getByTestId("rail-group-plan").click();
  const note = group.getByTestId("stage-editor-note");
  await note.fill("Keep this unsaved plan note");
  // The last focused row is retained separately. An open editor must survive after focus leaves it.
  await board(page)
    .locator('[data-testid="rail-row"][data-feature="bulk-0"]')
    .getByTestId("rail-feature")
    .focus();
  await scrollBoard(page, "end");
  await expect(entries(page).last()).toHaveAttribute("data-index", String(FEATURES + 4));
  await expect(note).toHaveValue("Keep this unsaved plan note");
  await scrollBoard(page, 0);
  await expect(note).toBeVisible();
  await expect(note).toHaveValue("Keep this unsaved plan note");
  expect(await entries(page).count()).toBeLessThan(30);
  // Closing the editor releases the extra row once focus has gone elsewhere again.
  await group.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(group.getByTestId("stage-editor")).toHaveCount(0);
  await board(page)
    .locator('[data-testid="rail-row"][data-feature="bulk-0"]')
    .getByTestId("rail-feature")
    .focus();
  await scrollBoard(page, "end");
  await expect(group).toHaveCount(0);
});

test("60 features draw a dozen or so lines, each where the whole list puts it", async ({
  page,
}) => {
  await seed(page);
  await expect(board(page).locator('[data-testid="rail-row"][data-feature="bulk-0"]')).toHaveCount(
    1,
  );
  const drawn = await entries(page).count();
  expect(drawn).toBeGreaterThan(3);
  expect(drawn).toBeLessThan(30);
  const boxes = await expectContiguous(page);
  // Four workers stack in their station: that line is taller than a line with one.
  const tall = board(page).locator('[data-testid="rail-row"][data-feature="bulk-0"]');
  const short = board(page).locator('[data-testid="rail-row"][data-feature="bulk-1"]');
  if ((await tall.count()) > 0 && (await short.count()) > 0) {
    expect((await tall.boundingBox())!.height).toBeGreaterThan(
      (await short.boundingBox())!.height + 20,
    );
  }
  expect(boxes.length).toBe(drawn);
  await scrollBoard(page, "end");
  const total = await features(page).evaluate(
    (list) => list.closest<HTMLElement>(".overflow-y-auto")!.scrollHeight,
  );
  expect(total).toBeGreaterThan(900 * 3);
  await expect
    .poll(() =>
      entries(page).evaluateAll((all) =>
        Math.max(...all.map((entry) => Number((entry as HTMLElement).dataset["index"]))),
      ),
    )
    .toBeGreaterThanOrEqual(FEATURES - 1);
  await expectContiguous(page);
  expect(await entries(page).count()).toBeLessThan(30);
});

test("Tab goes on through the lines past the drawn ones", async ({ page }) => {
  await seed(page);
  const drawn = await entries(page).count();
  await entries(page).first().getByTestId("rail-feature").first().focus();
  let last = await focusedEntry(page);
  expect(last).toBe(0);
  // Each line has its name, its menu and its workers to stop on; the entries only go forward.
  for (let press = 0; press < 400 && last < drawn + 5; press++) {
    await page.keyboard.press("Tab");
    const now = await focusedEntry(page);
    expect(now).toBeGreaterThanOrEqual(last);
    expect(now - last).toBeLessThanOrEqual(1);
    last = now;
  }
  expect(last).toBe(drawn + 5);
  await expect(page.locator(":focus")).toBeInViewport();
});

test("a chip drawn anew on scrolling back stays put rather than gliding in", async ({ page }) => {
  await seed(page);
  const id = (await board(page).getByTestId("rail-worker").first().getAttribute("data-thread-id"))!;
  await scrollBoard(page, "end");
  await expect(
    board(page).locator(`[data-testid="rail-worker"][data-thread-id="${id}"]`),
  ).toHaveCount(0);
  // From the frame it is added back, its box and any transform Motion puts on it.
  const samples = await features(page).evaluate(
    (list, threadId) =>
      new Promise<{ top: number; transform: string }[]>((resolve) => {
        const seen: { top: number; transform: string }[] = [];
        const observer = new MutationObserver(() => {
          const chip = list.querySelector<HTMLElement>(
            `[data-testid="rail-worker"][data-thread-id="${threadId}"]`,
          );
          if (chip === null) return;
          observer.disconnect();
          const look = () => {
            seen.push({ top: chip.getBoundingClientRect().top, transform: chip.style.transform });
            if (seen.length < 40) requestAnimationFrame(look);
            else resolve(seen);
          };
          look();
        });
        observer.observe(list, { subtree: true, childList: true });
        list.closest<HTMLElement>(".overflow-y-auto")!.scrollTop = 0;
      }),
    id,
  );
  // A pixel or so as its line is measured; a glide would come from hundreds of pixels away.
  const last = samples.at(-1)!.top;
  for (const sample of samples) {
    expect(Math.abs(sample.top - last)).toBeLessThan(8);
    expect(sample.transform === "" || sample.transform === "none").toBe(true);
  }
});

test("a group's band folds its lines away and the lines under it move up", async ({ page }) => {
  await seed(page, "workerWaits");
  const band = board(page).locator('[data-testid="rail-group"][data-group="casefile-cleanup"]');
  await expect(band).toBeVisible();
  const toggle = band.getByTestId("rail-group-toggle");
  const height = async () => (await band.boundingBox())!.height;
  const open = await height();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect.poll(height).toBeLessThan(open - 20);
  await expect.poll(contiguous(page)).toBe(true);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect.poll(height).toBeGreaterThan(open - 1);
  await expect.poll(contiguous(page)).toBe(true);
});
