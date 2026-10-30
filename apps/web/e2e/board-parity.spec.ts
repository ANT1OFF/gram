import { expect, test, type Locator, type Page } from "@playwright/test";

import { openOrchestrator, threadRow } from "./thread-row";

// The Board view: tidying up, Waiting on you, folds and every way that opens it. Mock state lives
// in memory, so every step after the seed navigates inside the app; nothing reloads.

const MOCK_SETTINGS_KEY = "gram.mock.settings";

/** Seeds a scenario, opens its orchestrator from the overview, and picks Board. */
const start = async <T extends { orchestratorThreadId: string; workspaceId: string }>(
  page: Page,
  seed: () => Promise<T>,
): Promise<T> => {
  await page.goto("/t/t-flaky");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  const made = await page.evaluate(seed);
  await openOrchestrator(page, made.orchestratorThreadId);
  await pickBoard(page);
  return made;
};

const pickBoard = async (page: Page) => {
  await page
    .getByRole("radiogroup", { name: "View" })
    .getByRole("radio", { name: /^Board\b/ })
    .click();
  await expect(page.getByTestId("rail-board")).toBeVisible();
};

/** Goes to `path` inside the app, as a link would, so the mock's state stays. */
const goInApp = (page: Page, path: string) =>
  page.evaluate((to) => {
    window.history.pushState({}, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);

const board = (page: Page) => page.getByTestId("rail-board");
/** The title bar, which on Board carries its header: one bar, not two. */
const bar = (page: Page) => page.getByTestId("shell-titlebar");
/** The closed fold around `locator`, if one hides it: a closed fold is inert, not unrendered. */
const foldAround = (locator: Locator) => locator.locator("xpath=ancestor-or-self::*[@inert]");
const line = (page: Page, feature: string) =>
  board(page).locator(`[data-testid="rail-row"][data-feature="${feature}"]`);
const band = (page: Page, group: string) =>
  board(page).locator(`[data-testid="rail-group"][data-group="${group}"]`);

test("the header tidies up, pauses and resumes, and shows archived work on asking", async ({
  page,
}) => {
  const made = await start(page, () => window.gramMock!.simulateFinishedWork());
  // Wide enough that the bar keeps Tidy up out of its folded "…".
  await page.setViewportSize({ width: 1680, height: 900 });
  const header = bar(page);

  // Tidy up sends its one message to the orchestrator.
  await header.getByTestId("titlebar-tidy").click();
  await expect(header.getByTestId("titlebar-tidy")).toHaveAttribute("data-sent", /^(sent|queued)$/);
  await page
    .getByTestId("view-switcher")
    .getByRole("radio", { name: /^Chat\b/ })
    .click();
  await expect(page.getByText(/^Please tidy up this workspace now/)).toHaveCount(1);
  await pickBoard(page);

  // Pause says so in a line, and Resume takes it away. Work is mid-turn, so it asks first.
  // The bar's Pause is a glyph, its word its name; the paused line is Board's, under the bar.
  const pause = header.getByTestId("titlebar-pause");
  await expect(pause).toHaveAccessibleName(/^Pause/);
  await pause.click();
  await page.getByTestId("titlebar-pause-confirm-pause").click();
  await expect(board(page).getByTestId("rail-paused-line")).toContainText("Paused by you");
  await expect(pause).toHaveAccessibleName(/Resume orchestration$/);
  await pause.click();
  await expect(board(page).getByTestId("rail-paused-line")).toHaveCount(0);
  await expect(pause).toHaveAccessibleName(/^Pause/);

  // Archived workers are off their lines until asked for, and the choice is kept per workspace.
  const toggle = header.getByTestId("rail-show-archived");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(line(page, "sse-spike")).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(line(page, "sse-spike")).toBeVisible();
  await expect(line(page, "sse-spike")).toHaveAttribute("data-reach", /\d/);
  const stored = await page.evaluate(
    () => JSON.parse(localStorage.getItem("gram.layout") ?? "{}").state?.boardArchivedShown,
  );
  expect(stored).toEqual([made.workspaceId]);
  await toggle.click();
  await expect(line(page, "sse-spike")).toHaveCount(0);
});

test("the waiting chip unfolds Waiting on you: waits with Done, questions answered in place", async ({
  page,
}) => {
  const made = await start(page, async () => {
    const mock = window.gramMock!;
    const seeded = await mock.simulateOrchestration("board");
    mock.simulateWaitOnUser(seeded.orchestratorThreadId, {
      kind: "action",
      title: "Run assume example-prod",
    });
    mock.simulateWaitOnUser(seeded.inReview, {
      kind: "draft",
      title: "PR description",
      copy: "Adds the mail trigger.",
    });
    return seeded;
  });
  const chip = bar(page).getByTestId("rail-waiting-chip");
  const waiting = board(page).getByTestId("rail-waiting");
  await expect(chip).toHaveAttribute("aria-expanded", "false");
  const before = Number((await chip.getAttribute("aria-label"))!.split(" ")[0]);
  expect(before).toBeGreaterThan(0);
  await expect(foldAround(waiting)).toHaveCount(1);

  await chip.click();
  await expect(chip).toHaveAttribute("aria-expanded", "true");
  await expect(foldAround(waiting)).toHaveCount(0);
  // The orchestrator's own first, its open questions answered in place, then each worker's.
  const groups = waiting.getByTestId("board-waiting-group");
  await expect(groups.first()).toHaveAttribute("data-thread", made.orchestratorThreadId);
  await expect(groups.first()).toContainText("Run assume example-prod");
  await expect(waiting.getByTestId("memory-question").first()).toBeVisible();
  const reviewing = waiting.locator(
    `[data-testid="board-waiting-group"][data-thread="${made.inReview}"]`,
  );
  await expect(reviewing).toContainText("PR description");

  // Done on a worker's item takes it off, and the chip counts one fewer.
  await reviewing.getByTestId("waiting-done").click();
  await expect(reviewing).toHaveCount(0);
  await expect(chip).toHaveAttribute("aria-label", `${before - 1} waiting on you`);

  await chip.click();
  await expect(chip).toHaveAttribute("aria-expanded", "false");
});

test("a line carries its stage as a chip, its sheet's steps set it, and Set stage… edits the plan there", async ({
  page,
}) => {
  const made = await start(page, async () => {
    const seeded = await window.gramMock!.simulateAsks();
    await window.gramMock!.setOrchestratorStage(seeded.workspaceId, {
      feature: "mail-trigger",
      plan: ["contract", "build", "rollout"],
      stage: "build",
      note: "Contract agreed with the payments team.",
    });
    return seeded;
  });
  const mail = line(page, "mail-trigger");
  const chip = mail.getByTestId("rail-stage-chip");
  await expect(chip).toContainText("build");
  await expect(chip).toContainText("2/3");
  await expect(chip).toHaveAttribute("title", /Contract agreed with the payments team\./);
  // The stations say how far it has come, so the line draws no steps of its own.
  await expect(mail.getByTestId("stage-stepper")).toHaveCount(0);

  // In the feature's sheet, a click on a step sets it at once, as the user.
  await mail.getByTestId("rail-feature").click();
  const mailSheet = page.getByTestId("feature-sheet");
  await expect(mailSheet).toHaveAttribute("data-feature", "mail-trigger");
  await mailSheet.getByRole("button", { name: "rollout (upcoming)" }).click();
  await page.keyboard.press("Escape");
  await expect(mailSheet).toBeHidden();
  await expect(chip).toContainText("rollout");
  await expect(chip).toHaveAttribute("title", /set by you/);
  await expect
    .poll(() =>
      page.evaluate(
        async (id) =>
          (await window.gramMock!.listWorkspaces()).find((w) => w.workspace.id === id)?.stages?.[
            "mail-trigger"
          ]?.stage,
        made.workspaceId,
      ),
    )
    .toBe("rollout");

  // A line with no stage offers Set stage…, which opens the sheet with the editor.
  const paging = line(page, "docs-refresh");
  await paging.hover();
  await paging.getByTestId("feature-menu").click();
  await page.getByRole("menuitem", { name: "Set stage…" }).click();
  const sheet = page.getByTestId("feature-sheet");
  await expect(sheet).toHaveAttribute("data-feature", "docs-refresh");
  const editor = sheet.getByTestId("stage-editor");
  await expect(editor).toBeVisible();
  await editor.getByRole("textbox").first().fill("waiting on the API team");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor).toHaveCount(0);
  await expect(sheet.getByTestId("stage-stepper")).toHaveAttribute(
    "data-stage",
    "waiting on the API team",
  );
  await page.keyboard.press("Escape");
  await expect(paging.getByTestId("rail-stage-chip")).toContainText("waiting on the API team");
});

test("lines gather under their group's band, which folds and remembers it, and the menu moves them", async ({
  page,
}) => {
  const made = await start(page, () => window.gramMock!.simulateWorkerWaits());
  const cleanup = band(page, "casefile-cleanup");
  const toggle = cleanup.getByTestId("rail-group-toggle");
  await expect(cleanup).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(cleanup.getByTestId("rail-group-state")).toBeVisible();
  const members = cleanup.getByTestId("rail-row");
  const count = await members.count();
  expect(count).toBeGreaterThan(0);

  // Folding hides its lines and is kept.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(foldAround(members.first())).toHaveCount(1);
  const folds = await page.evaluate(
    () => JSON.parse(localStorage.getItem("gram.layout") ?? "{}").state?.workspacesCollapsedNodes,
  );
  expect(folds).toContain(`board:${made.workspaceId}/group:casefile-cleanup`);
  await toggle.click();
  await expect(foldAround(members.first())).toHaveCount(0);

  // The submenu opens from the keyboard too.
  const paging0 = line(page, "registry-paging");
  await paging0.getByTestId("feature-menu").focus();
  await page.keyboard.press("Enter");
  await page.getByTestId("feature-menu-group").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("feature-group-menu")).toBeVisible();
  await expect(page.getByTestId("feature-group-menu")).toHaveCSS("opacity", "1");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("feature-menu-popup")).toHaveCount(0);

  // Move to group: a new group by name, then out of it again.
  const paging = line(page, "registry-paging");
  await paging.hover();
  await paging.getByTestId("feature-menu").click();
  await page.getByTestId("feature-menu-group").click();
  const groups = page.getByTestId("feature-group-menu");
  await expect(groups).toBeVisible();
  await groups.getByRole("menuitem", { name: "New group…" }).click();
  const dialog = page.getByTestId("feature-new-group-dialog");
  await dialog.getByRole("textbox", { name: "Group name" }).fill("Paging Rollout");
  await dialog.getByRole("button", { name: "Move to paging-rollout" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(band(page, "paging-rollout").getByTestId("rail-row")).toHaveAttribute(
    "data-feature",
    "registry-paging",
  );

  const moved = line(page, "registry-paging");
  await moved.hover();
  await moved.getByTestId("feature-menu").click();
  await page.getByTestId("feature-menu-group").click();
  await page
    .getByTestId("feature-group-menu")
    .getByRole("menuitem", { name: "Remove from paging-rollout" })
    .click();
  await expect(band(page, "paging-rollout")).toHaveCount(0);
  await expect(line(page, "registry-paging")).toBeVisible();
});

test("a finished group folds to one line, and a group's plan is set from its band", async ({
  page,
}) => {
  await start(page, () => window.gramMock!.simulateFinishedWork());
  await bar(page).getByTestId("rail-show-archived").click();
  const cleanup = band(page, "q3-cleanup");
  await expect(cleanup).toHaveAttribute("data-finished", "true");
  await expect(cleanup.getByTestId("rail-group-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(foldAround(cleanup.getByTestId("rail-row").first())).toHaveCount(1);
  await cleanup.getByTestId("rail-group-toggle").click();
  await expect(foldAround(cleanup.getByTestId("rail-row").first())).toHaveCount(0);

  await cleanup.getByTestId("rail-group-plan").click();
  const editor = cleanup.getByTestId("stage-editor");
  // It opens on the stage's label, ready to type in.
  await expect(editor.getByRole("textbox").first()).toBeFocused();
  await editor.getByRole("textbox").first().fill("released");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(cleanup.getByTestId("rail-group-stage-chip")).toContainText("released");
});

test("the Failing strip lists a stopped worker and red CI, opens one, and dismisses with Undo", async ({
  page,
}) => {
  const made = await start(page, () => window.gramMock!.simulateFailures());
  const strip = board(page).getByTestId("board-failing");
  const failure = (threadId: string) =>
    strip.locator(`[data-testid="board-failure"][data-thread-id="${threadId}"]`);
  await expect(failure(made.stopped)).toHaveAttribute("data-kind", "error");
  await expect(failure(made.failing)).toHaveAttribute("data-kind", "checks");
  await expect(failure(made.failing)).toContainText("checks failing");
  // Above the docked stack.
  const stripBox = await strip.boundingBox();
  const stackBox = await board(page).getByTestId("ask-stack").boundingBox();
  expect(stripBox!.y).toBeLessThan(stackBox!.y);

  // Dismiss holds behind the stack's Undo; Undo brings it back.
  await failure(made.failing).getByTestId("board-failure-dismiss").click();
  await expect(failure(made.failing)).toHaveCount(0);
  await expect(board(page).getByTestId("ask-undo-line")).toContainText("Dismissed");
  await board(page).getByTestId("ask-undo").click();
  await expect(failure(made.failing)).toBeVisible();

  // Once it goes, it is kept in settings (`inbox.cleared`).
  await failure(made.failing).getByTestId("board-failure-dismiss").click();
  await expect
    .poll(
      () =>
        page.evaluate(
          (key) =>
            (JSON.parse(sessionStorage.getItem(key) ?? "{}") as { inbox?: { cleared?: string[] } })
              .inbox?.cleared ?? [],
          MOCK_SETTINGS_KEY,
        ),
      { timeout: 10_000 },
    )
    .toContainEqual(expect.stringContaining("failure:checks:"));

  // Open goes to the worker, in Chat.
  await failure(made.stopped).getByTestId("board-failure-open").click();
  await expect(page).toHaveURL(new RegExp(`/t/${made.stopped}$`));
  await expect(page.getByTestId("view-board")).toHaveCount(0);
});

test("a worker's own red CI leaves the Failing strip and Needs you, and returns once the user holds it", async ({
  page,
}, testInfo) => {
  // Held, so t-flaky's scripted approval can't land mid-test and move the count this compares.
  await page.addInitScript(() => {
    window.gramMockHoldGates = true;
  });
  const made = await start(page, () => window.gramMock!.simulateFailures());
  const strip = board(page).getByTestId("board-failing");
  const failed = strip.locator(
    `[data-testid="board-failure"][data-thread-id="${made.failing}"][data-kind="checks"]`,
  );
  const stopped = strip.locator(`[data-testid="board-failure"][data-thread-id="${made.stopped}"]`);
  const pill = page.getByTestId("overview-needs-you");
  // Taken over, the red build is the user's.
  await expect(failed).toHaveCount(1);
  await expect(stopped).toHaveCount(1);
  const before = Number(await pill.getAttribute("data-count"));
  const unownedShot = testInfo.outputPath("unowned-ci.png");
  await page.screenshot({ path: unownedShot });
  await testInfo.attach("unowned-ci", { path: unownedShot });

  // Handed back, the idle worker owns it, monitored or not: it isn't the user's to fix.
  await page.evaluate((id) => window.gramMock!.releaseWorker(id), made.failing);
  await expect(failed).toHaveCount(0);
  await expect(stopped).toHaveCount(1);
  await expect(pill).toHaveAttribute("data-count", String(before - 1));
  const ownedShot = testInfo.outputPath("worker-owned-ci.png");
  await page.screenshot({ path: ownedShot });
  await testInfo.attach("worker-owned-ci", { path: ownedShot });

  await page.evaluate((id) => window.gramMock!.takeOverWorker(id), made.failing);
  await expect(failed).toHaveCount(1);
  await expect(pill).toHaveAttribute("data-count", String(before));
});

test("⌘⇧D, the orchestrator's header, the palette and Memory all open the Board view", async ({
  page,
}) => {
  const made = await start(page, () => window.gramMock!.simulateWorkerWaits());
  const chat = () =>
    page
      .getByTestId("view-switcher")
      .getByRole("radio", { name: /^Chat\b/ })
      .click();
  const onBoard = async () => {
    await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
    await expect(board(page)).toBeVisible();
  };

  // ⌘⇧D from a thread elsewhere.
  await chat();
  await goInApp(page, "/t/t-flaky");
  await expect(page.getByTestId("view-board")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Shift+D");
  await onBoard();

  // The orchestrator's bar: Board beside its header, and its questions count.
  await chat();
  await bar(page)
    .getByRole("radio", { name: /^Board\b/ })
    .click();
  await onBoard();
  await chat();
  const questions = page.getByTestId("banner-questions");
  if ((await questions.count()) > 0) {
    await questions.click();
    await onBoard();
    await expect(bar(page).getByTestId("rail-waiting-chip")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await chat();
  }

  // The palette's Open board.
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByTestId("command-palette");
  await palette.getByRole("combobox").fill(">open board");
  await palette.getByText("Open board", { exact: true }).first().click();
  await onBoard();

  // Memory's way back.
  await chat();
  await goInApp(page, `/w/${made.workspaceId}/memory`);
  await page.getByTestId("memory-board").click();
  await onBoard();
});
