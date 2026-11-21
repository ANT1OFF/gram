import { expect, test, type Page } from "@playwright/test";

import { terminalText } from "./terminal";
import { openOrchestrator } from "./thread-row";

// A worker open in the right pane beside its orchestrator, on the realistic morning: the keys go
// into the pane when it opens and back to the worker's row when it closes, a finished worker is
// read only, and a link in the worker's own transcript opens the worker's own tool.

const realistic = async (page: Page) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("gram.mock.orchestration", "realistic");
  });
  await page.goto("/");
  await page.getByTestId("app-shell").waitFor();
  const made = await page.evaluate(async () => {
    const started = await window.gramMock!.startedRealistic();
    if (started === undefined) throw new Error("the mock did not start the realistic scenario");
    return started;
  });
  await openOrchestrator(page, made.orchestratorThreadId);
  await expect(page.locator(`[data-thread-view="${made.orchestratorThreadId}"]`)).toBeVisible();
  return made;
};

const pane = (page: Page) => page.getByTestId("beside-dock");
const row = (page: Page, threadId: string) =>
  page.locator(`[data-testid="workers-panel-row"][data-thread-id="${threadId}"]`);
const focused = (page: Page) =>
  page.evaluate(() => {
    const at = document.activeElement;
    return `${at?.getAttribute("data-testid") ?? at?.tagName}:${at?.getAttribute("data-thread-id") ?? ""}`;
  });

test("opening a worker puts the keys in the pane, so Esc and ↓ work at once, and Back puts them on the worker's row", async ({
  page,
}) => {
  const made = await realistic(page);
  const url = page.url();
  await page.keyboard.press("ControlOrMeta+KeyJ");
  await expect.poll(() => focused(page)).toMatch(/^workers-panel-row:/);

  // ⏎ on a row: the worker opens, its title holding the keys.
  await page.keyboard.press("Enter");
  await expect(pane(page)).toBeVisible();
  await expect.poll(() => focused(page)).toBe("beside-title:");
  const first = await pane(page).getAttribute("data-thread-id");
  // Esc at once goes back, the keys on the row it came from.
  await page.keyboard.press("Escape");
  await expect.poll(() => focused(page)).toBe(`workers-panel-row:${first}`);

  // A click opens it too, with the same keys; ↓ steps to the next worker and Esc goes back to
  // that one's row, current and in view, its group unfolded if it was folded.
  await row(page, made.searchWorker).click();
  await expect.poll(() => focused(page)).toBe("beside-title:");
  await page.keyboard.press("ArrowDown");
  await expect(pane(page)).not.toHaveAttribute("data-thread-id", made.searchWorker);
  const next = (await pane(page).getAttribute("data-thread-id"))!;
  await page.keyboard.press("Escape");
  await expect.poll(() => focused(page)).toBe(`workers-panel-row:${next}`);
  await expect(row(page, next)).toHaveAttribute("aria-current", "true");
  await expect(row(page, next)).toBeInViewport();
  // The orchestrator stayed in the main view throughout.
  expect(page.url()).toBe(url);
});

test("a finished worker is read only, and its PR's files are its Changes", async ({ page }) => {
  await realistic(page);
  await page.keyboard.press("ControlOrMeta+KeyJ");
  const done = page.getByTestId("workers-group-done");
  await done.getByRole("button").first().click();
  await done.getByTestId("workers-panel-row").first().click();
  await expect(pane(page)).toBeVisible();

  // No composer to steer it: a line saying it is read only instead.
  await expect(pane(page).getByTestId("beside-readonly-note")).toBeVisible();
  await expect(pane(page).getByRole("textbox", { name: "Message" })).toHaveCount(0);
  // Nothing runs in it, so no Terminal or Files; each says why.
  for (const tool of ["terminal", "files"]) {
    await expect(pane(page).getByTestId(`beside-tab-${tool}`)).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  }
  // Changes counts and lists what its merged PR changed, not an empty tree on main.
  const changes = pane(page).getByTestId("beside-tab-changes");
  await expect(changes).toHaveText(/Changes\d+/);
  const count = Number((await changes.textContent())!.replace(/\D/g, ""));
  await changes.click();
  await expect(pane(page).getByTestId("finished-files-all").locator("li")).toHaveCount(count);
});

test("View changes in a worker's transcript opens that worker's Changes, beside the chat", async ({
  page,
}) => {
  const made = await realistic(page);
  const url = page.url();
  await page.keyboard.press("ControlOrMeta+KeyJ");
  await row(page, made.searchWorker).click();
  await expect(pane(page).getByTestId("beside-tab-thread")).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await pane(page).getByTestId("turn-view-changes").first().click();
  await expect(pane(page).getByTestId("beside-tab-changes")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // The worker is still the one open, and the orchestrator still in the main view.
  await expect(pane(page)).toHaveAttribute("data-thread-id", made.searchWorker);
  expect(page.url()).toBe(url);
});

test("a worker's PR tool opens the PR it names, and its Files its own checkout", async ({
  page,
}) => {
  const made = await realistic(page);
  await page.keyboard.press("ControlOrMeta+KeyJ");
  await row(page, made.searchWorker).click();

  const pr = pane(page).getByTestId("beside-tab-pr");
  await expect(pr).toHaveText(/#142/);
  await pr.click();
  await expect(pane(page).getByText("No PR for this branch")).toHaveCount(0);
  await expect(pane(page).getByText("#142").first()).toBeVisible();

  await pane(page).getByTestId("beside-tab-files").click();
  await expect(pane(page).getByText(/^Not found/)).toHaveCount(0);
  await expect(pane(page).getByText("package.json")).toBeVisible();
});

/** Whether the keys are on something in the worker pane. */
const keysInPane = (page: Page) =>
  page.evaluate(() => document.activeElement?.closest('[data-testid="beside-dock"]') !== null);

test("View changes from the keys hands them to the Changes tab, so Esc and ↓ still work", async ({
  page,
}) => {
  const made = await realistic(page);
  await page.keyboard.press("ControlOrMeta+KeyJ");
  await row(page, made.searchWorker).click();
  const viewChanges = pane(page).getByTestId("turn-view-changes").first();

  // ⏎ on the link: its transcript goes, and the keys go to the tool it opened.
  await viewChanges.focus();
  await page.keyboard.press("Enter");
  await expect(pane(page).getByTestId("beside-tab-changes")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect.poll(() => focused(page)).toBe("beside-tab-changes:");
  // Esc at once goes back to the worker's row.
  await page.keyboard.press("Escape");
  await expect.poll(() => focused(page)).toBe(`workers-panel-row:${made.searchWorker}`);

  // A click on the link does the same, and ↓ from there steps to the next worker.
  await row(page, made.searchWorker).click();
  await pane(page).getByTestId("beside-tab-thread").click();
  await pane(page).getByTestId("turn-view-changes").first().click();
  await expect.poll(() => focused(page)).toBe("beside-tab-changes:");
  await page.keyboard.press("ArrowDown");
  await expect(pane(page)).not.toHaveAttribute("data-thread-id", made.searchWorker);
  await expect.poll(() => keysInPane(page)).toBe(true);
});

test("a clicked tool tab takes the tool row's keys, and a click from the chat's composer leaves them there", async ({
  page,
}) => {
  const made = await realistic(page);
  await page.keyboard.press("ControlOrMeta+KeyJ");
  await row(page, made.searchWorker).click();

  // The keys visit Changes, then a click picks Terminal: → moves on from Terminal.
  await pane(page).getByTestId("beside-tab-thread").focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => focused(page)).toBe("beside-tab-changes:");
  await pane(page).getByTestId("beside-tab-terminal").click();
  await expect(pane(page).getByTestId("beside-tab-terminal")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect.poll(() => focused(page)).toBe("beside-tab-terminal:");
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => focused(page)).toBe("beside-tab-files:");
  // ↑ ↓ still step between workers from the tool row.
  await page.keyboard.press("ArrowDown");
  await expect(pane(page)).not.toHaveAttribute("data-thread-id", made.searchWorker);

  // Typing to the orchestrator, a click on a tool leaves the keys in its composer.
  const composer = page
    .locator(`[data-thread-view="${made.orchestratorThreadId}"]`)
    .getByRole("combobox", { name: "Message" });
  await composer.click();
  await page.keyboard.type("half a thought");
  await pane(page).getByTestId("beside-tab-thread").click();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("half a thought");
});

test("the Terminal tab is a shell of your own in the worker's worktree, taken only by a click", async ({
  page,
}) => {
  const made = await realistic(page);
  const checkout = await page.evaluate(
    (worker) => window.gramMock!.world.summary(worker as never).thread.checkout.path,
    made.searchWorker,
  );
  const before = await page.evaluate(
    (worker) => window.gramMock!.world.messages(worker as never).length,
    made.searchWorker,
  );
  await page.keyboard.press("ControlOrMeta+KeyJ");
  await row(page, made.searchWorker).click();

  // Picked from the chat's composer, it opens the worker's shell and leaves the keys there.
  const composer = page
    .locator(`[data-thread-view="${made.orchestratorThreadId}"]`)
    .getByRole("combobox", { name: "Message" });
  await composer.click();
  await pane(page).getByTestId("beside-tab-terminal").click();
  const terminal = pane(page).getByTestId("terminal");
  await expect(terminalText(terminal)).toContainText(`Gram mock shell in ${checkout}`);
  await expect(composer).toBeFocused();
  await expect(pane(page).getByTestId("beside-terminal")).toHaveCount(0);

  // A click gives it the keys: what you type runs there, and Esc is the shell's, not Back.
  await terminal.getByTestId("terminal-surface").click();
  await page.keyboard.type("git status");
  await page.keyboard.press("Enter");
  await expect(terminalText(terminal)).toContainText("echo: git status");
  await page.keyboard.press("Escape");
  await expect(pane(page)).toHaveAttribute("data-thread-id", made.searchWorker);
  await expect(terminal).toBeVisible();

  // Your shell sends the worker nothing.
  expect(
    await page.evaluate(
      (worker) => window.gramMock!.world.messages(worker as never).length,
      made.searchWorker,
    ),
  ).toBe(before);
});

test("a worker's row, its head and its PR tab name the same PR, its chip before its status as in the sidebar", async ({
  page,
}) => {
  const made = await realistic(page);
  await page.keyboard.press("ControlOrMeta+KeyJ");
  const wide = row(page, made.searchWorker).locator("xpath=..");
  const rowChip = wide.getByTestId("overview-pr-chip");
  await expect(rowChip).toHaveAttribute("data-pr", "142");
  // In the wide row, the chip leads the status line, as it leads the sidebar's second line.
  const words = row(page, made.searchWorker).getByTestId("overview-worker-line");
  const [chipBox, wordsBox] = [await rowChip.boundingBox(), await words.boundingBox()];
  expect(chipBox!.y).toBeLessThan(wordsBox!.y + wordsBox!.height);
  expect(chipBox!.y + chipBox!.height).toBeGreaterThan(wordsBox!.y);

  await row(page, made.searchWorker).click();
  const head = pane(page).getByTestId("beside-state");
  const headChip = head.getByTestId("overview-pr-chip");
  await expect(headChip).toHaveAttribute("data-pr", "142");
  await expect(pane(page).getByTestId("beside-tab-pr")).toHaveText(/#142/);
  // The head says the number once, on its PR tab: the chip keeps its marks, and its status leaves
  // the number out too. The chip comes first.
  await expect(headChip).not.toContainText("#142");
  await expect(headChip).toHaveAccessibleName(/142/);
  const status = head.getByTestId("beside-status");
  await expect(status).not.toContainText("#142");
  expect((await headChip.boundingBox())!.x).toBeLessThan((await status.boundingBox())!.x);
  // The chip opens the PR its tab names, here, the orchestrator staying in the main view.
  const url = page.url();
  await headChip.click();
  await expect(pane(page).getByTestId("beside-tab-pr")).toHaveAttribute("aria-selected", "true");
  expect(page.url()).toBe(url);

  // Back in the list, the row's chip does the same: the worker opens here, on that PR.
  await pane(page).getByTestId("beside-back").click();
  await pane(page).getByTestId("beside-tab-thread").waitFor({ state: "detached" });
  await rowChip.click();
  await expect(pane(page)).toHaveAttribute("data-thread-id", made.searchWorker);
  await expect(pane(page).getByTestId("beside-tab-pr")).toHaveAttribute("aria-selected", "true");
  expect(page.url()).toBe(url);
});
