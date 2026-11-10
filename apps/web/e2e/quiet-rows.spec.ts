import { expect, test, type Page } from "@playwright/test";

import { openOrchestrator, threadRow } from "./thread-row";

// The orchestrator's quiet stream over the realistic scenario: updates with nothing between them,
// and merged features' lines, read as one quiet row that opens on each by click or by key; a
// merged feature is a flat line, never a boxed card. Then the transcript's own ends: "Jump to
// latest" only with something below the view, and a files card's actions inside its edge.

/** The realistic "Gram" orchestrator, opened from the overview; what the scenario made. */
const openRealistic = async (page: Page) => {
  await page.addInitScript(() => sessionStorage.setItem("gram.mock.orchestration", "realistic"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByTestId("app-shell").waitFor();
  const made = await page.evaluate(async () => {
    const started = await window.gramMock!.startedRealistic();
    if (started === undefined)
      throw new Error("the mock did not start with the realistic scenario");
    return started;
  });
  await page
    .locator(`[data-testid="overview-workspace"][data-workspace-id="${made.workspaceId}"]`)
    .waitFor();
  await openOrchestrator(page, made.orchestratorThreadId);
  await page.getByLabel("Message", { exact: true }).waitFor();
  return made;
};

/** Show all activity, from the title bar's "…" under View; one toggle, the menu closes on it. */
const toggleAllActivity = async (page: Page) => {
  await page.getByTestId("titlebar-overflow").click();
  await page.getByTestId("menu-view").click();
  await page.getByTestId("menu-all-activity").click();
  await expect(page.getByTestId("titlebar-overflow-menu")).toHaveCount(0);
};

test("updates in a row are one row that opens on each, by click and by key", async ({ page }) => {
  await openRealistic(page);
  await page.evaluate(() => window.gramMock!.simulateDigestStream());
  // The quiet update before the merge and the merge's own update stood one under the other.
  const run = page
    .getByTestId("update-run")
    .filter({ has: page.getByTestId("update-run-words").getByText(/^Updates/) });
  await expect(run).toHaveCount(1);
  const toggle = run.getByTestId("update-run-toggle");
  await expect(run.getByTestId("update-run-words")).toHaveText("Updates · 1 merged · 1 change");
  await expect(toggle).toContainText(/^\d{2}:\d{2}–\d{2}:\d{2}/);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(run.getByTestId("update-run-body")).toHaveCount(0);
  // The merge and the reply to it still stand under the row, and the last quiet update alone.
  await expect(
    page.getByTestId("transcript").getByText("Search in Settings is on main."),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="update-block"][data-quiet="true"]').last(),
  ).toHaveAttribute("data-digests", "5");

  // Enter opens it on each update as it stood, and again closes it.
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const body = run.getByTestId("update-run-body");
  await expect(body).toBeVisible();
  await expect(body.getByTestId("update-block")).toHaveCount(2);
  await expect(run.getByTestId("update-run-toggle").getByTestId("update-block-fold")).toHaveText(
    "Less",
  );
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  // A click does the same, and Space too.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  // Show all activity has no runs: every update and reply as it was sent.
  await toggleAllActivity(page);
  await expect(page.getByTestId("update-run")).toHaveCount(0);
});

test("merged features are flat lines, and a stack of them is one row", async ({ page }) => {
  await openRealistic(page);
  const transcript = page.getByTestId("transcript");
  // The morning's merges sit at the top of the page, under the first reply.
  await transcript.evaluate((el) => {
    el.scrollTop = 0;
  });
  const merges = page
    .getByTestId("update-run")
    .filter({ has: page.getByTestId("update-run-words").getByText(/^\d+ merged$/) });
  await expect(merges).toHaveCount(1);
  await expect(merges.getByTestId("update-run-words")).toHaveText("6 merged");
  await merges.getByTestId("update-run-toggle").click();
  const lines = merges.locator('[data-testid="feature-card"][data-flat="true"]');
  await expect(lines).toHaveCount(6);
  // Each a line of meta with its PR chip: no border, no shadow, no box.
  const first = lines.first();
  await expect(first.getByTestId("pr-chip")).toBeVisible();
  await expect(first.getByTestId("worker-link")).toBeVisible();
  const box = await first.evaluate((el) => {
    const style = getComputedStyle(el);
    return { border: style.borderTopWidth, shadow: style.boxShadow };
  });
  expect(box).toEqual({ border: "0px", shadow: "none" });
  // A live feature keeps its card.
  await expect(page.locator('[data-testid="feature-card"]:not([data-flat])').first()).toBeVisible();
});

test("a feature with nothing to report is one line, and one that waits keeps its card", async ({
  page,
}) => {
  await openRealistic(page);
  // The morning's three workers at work, each alone on its feature with no PR yet: a line each,
  // its name, its worker and what the worker does, with no box and no stage line.
  const calm = page.locator('[data-testid="feature-card"][data-calm="true"]');
  await expect(calm).toHaveCount(3);
  const first = calm.first();
  await expect(first.getByTestId("worker-link")).toBeVisible();
  await expect(first.getByTestId("feature-card-now")).not.toBeEmpty();
  await expect(first.getByTestId("feature-card-stations")).toHaveCount(0);
  expect(await first.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("0px");
  // The one waiting on its PR's checks has something to say: its card, with its PR.
  const waiting = page
    .locator('[data-testid="feature-card"]:not([data-flat]):not([data-calm])')
    .filter({ has: page.getByTestId("pr-chip") });
  await expect(waiting.first()).toBeVisible();
  expect(await waiting.first().evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("1px");
});

test("Jump to latest shows only with something below the view", async ({ page }) => {
  const made = await openRealistic(page);
  await threadRow(page, made.searchWorker).click();
  await page.waitForURL(new RegExp(`/t/${made.searchWorker}$`));
  const card = page.getByTestId("turn-files-card");
  await expect(card).toContainText("3 files changed");
  const jump = page.getByRole("button", { name: "Jump to latest", exact: true });
  // A press in the transcript pauses following, so what was pressed stays put; at the bottom
  // there is nothing to jump to.
  await page.getByTestId("turn-fold").first().click();
  await card.scrollIntoViewIfNeeded();
  const transcript = page.getByTestId("transcript");
  await transcript.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect
    .poll(() => transcript.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBe(0);
  await expect(jump).toHaveCount(0);
  // Read back up, and it offers the way down again.
  await transcript.hover();
  await page.mouse.wheel(0, -400);
  await expect(jump).toHaveCount(1);
  await jump.click();
  await expect(jump).toHaveCount(0);
});

test("a key that works a control at the end leaves no Jump to latest", async ({ page }) => {
  await openRealistic(page);
  await page.evaluate(() => window.gramMock!.simulateDigestStream());
  const transcript = page.getByTestId("transcript");
  const toggle = page
    .getByTestId("update-run")
    .filter({ has: page.getByTestId("update-run-words").getByText(/^Updates/) })
    .getByTestId("update-run-toggle");
  await expect(toggle).toBeVisible();
  const gap = () => transcript.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  await expect.poll(gap).toBe(0);
  const jump = page.getByRole("button", { name: "Jump to latest", exact: true });
  // Space opens the run and closes it again: a control worked, not the reader scrolling away.
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect.poll(gap).toBe(0);
  await expect(jump).toHaveCount(0);
});

test("a files card keeps its actions inside its edge in a narrow pane", async ({ page }) => {
  await page.addInitScript(() => {
    const key = "gram.mock.settings";
    const settings = JSON.parse(sessionStorage.getItem(key) ?? "{}") as Record<string, unknown>;
    sessionStorage.setItem(
      key,
      JSON.stringify({
        ...settings,
        panel: { open: false },
        layout: {
          grid: {
            preset: "3c",
            panes: ["t-plan", "t-question", "t-deps"],
            colFr: [0.425, 0.425, 0.15],
            focused: 2,
          },
        },
      }),
    );
  });
  await page.setViewportSize({ width: 1728, height: 1095 });
  await page.goto("/t/t-deps");
  await expect(page.getByTestId("pane")).toHaveCount(3);
  const pane = page.locator('[data-testid="pane"][data-thread-id="t-deps"]');
  const card = pane.getByTestId("turn-files-card");
  await expect(card).toBeVisible();
  const edge = await card.boundingBox();
  for (const action of ["turn-undo", "turn-view-changes"]) {
    const box = await card.getByTestId(action).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(edge!.x + edge!.width);
  }
});
