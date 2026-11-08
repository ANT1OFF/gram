import { expect, test, type Page } from "@playwright/test";

// The overview's calm forms over the realistic morning: workspaces at rest fold into one Idle row,
// a worker at work with nothing more to say than its dot takes one 36 px line, and the compact
// rail tells its workspaces apart by a monogram of each name.

const open = async (page: Page, width: number) => {
  await page.addInitScript(() => sessionStorage.setItem("gram.mock.orchestration", "realistic"));
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/");
  await page.getByTestId("app-shell").waitFor();
  return page.evaluate(async () => (await window.gramMock!.startedRealistic())!);
};

const names = (page: Page, scope: string) =>
  page
    .getByTestId("overview-sidebar")
    .locator(`${scope} [data-testid="overview-workspace"]`)
    .evaluateAll((rows) =>
      rows
        .filter((row) => row.checkVisibility())
        .map((row) => row.querySelector(".truncate.font-medium")?.textContent ?? ""),
    );

test("workspaces at rest fold into one Idle row at the list's end, which unfolds to their rows", async ({
  page,
}) => {
  await open(page, 1440);
  const sidebar = page.getByTestId("overview-sidebar");
  const idle = sidebar.getByTestId("overview-idle");
  const fold = sidebar.getByTestId("overview-idle-fold");
  // web and infra have nothing running and nothing asking: one folded row says them.
  await expect(fold).toHaveText("Idle · 2");
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(idle.getByTestId("overview-workspace").first()).toBeHidden();
  await expect.poll(() => names(page, "")).toEqual(["Gram", "billing-api"]);
  // Unfolded, their rows, kept open across a reload.
  await fold.click();
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => names(page, '[data-testid="overview-idle"]')).toEqual(["web", "infra"]);
  await page.reload();
  await expect(sidebar.getByTestId("overview-idle-fold")).toHaveAttribute("aria-expanded", "true");
  // ← folds it from the keyboard, as a workspace's own line.
  await sidebar.getByTestId("overview-idle-fold").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(sidebar.getByTestId("overview-idle-fold")).toHaveAttribute("aria-expanded", "false");
});

test("a worker at work with no step to say is one 36 px line; one waiting keeps its reason", async ({
  page,
}) => {
  await open(page, 1440);
  const sidebar = page.getByTestId("overview-sidebar");
  const workers = sidebar.getByTestId("overview-worker");
  await expect(workers.first()).toBeVisible();
  const rows = await workers.evaluateAll((each) =>
    each.map((row) => ({
      tone: row.querySelector("[data-tone]")?.getAttribute("data-tone"),
      height: Math.round(row.getBoundingClientRect().height),
      words: row.querySelector(
        '[data-testid="overview-worker-step"], [data-testid="overview-worker-now"], [data-testid="overview-worker-state"], [data-testid="overview-worker-waiting"]',
      )?.textContent,
    })),
  );
  // Every row is one height or the other, never between.
  expect(rows.every((row) => row.height === 36 || row.height === 48)).toBe(true);
  // Working with no plan step: the dot says it, so no "Running" line.
  expect(rows.some((row) => row.tone === "working" && row.height === 36)).toBe(true);
  expect(rows.filter((row) => row.height === 36).every((row) => row.words === undefined)).toBe(
    true,
  );
  expect(rows.some((row) => row.words === "Running")).toBe(false);
  // A wait keeps its reason; an ask keeps its line.
  expect(rows.some((row) => row.tone === "waiting" && row.height === 48)).toBe(true);
});

test("the compact rail marks each workspace with a monogram of its name, the solo threads with a glyph", async ({
  page,
}) => {
  await open(page, 900);
  const rail = page.getByTestId("overview-rail");
  const tiles = rail.locator('[data-testid="overview-tile"][data-workspace-id]');
  await expect(tiles).toHaveCount(4);
  const marks = await tiles.evaluateAll((each) =>
    each.map((tile) => ({
      mark: tile.querySelector('[data-testid="overview-tile-mark"]')?.textContent,
      label: tile.getAttribute("aria-label"),
    })),
  );
  expect(marks.map((tile) => tile.mark)).toEqual(["G", "B", "W", "I"]);
  // The whole name is still its accessible name.
  expect(marks.map((tile) => tile.label?.split(",")[0])).toEqual([
    "Gram",
    "billing-api",
    "web",
    "infra",
  ]);
  await expect(
    rail.locator('[data-tile="solo"] svg'),
    "the solo threads' tile keeps its glyph",
  ).toHaveCount(1);
  // The rail's count is a neutral outline with only its number amber.
  const pill = rail.getByTestId("overview-rail-needs-you");
  await expect(pill).toHaveAttribute("data-asks", "true");
  const fill = await pill.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(fill).toBe("rgba(0, 0, 0, 0)");
});
