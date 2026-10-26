import { expect, test, type Locator, type Page } from "@playwright/test";

import { openOrchestratorTile } from "./overview-rail";

// An orchestrator question with four long choices and a long context, in each place an ask is
// answered: the stack over the composer and Quiet's card. Synthetic mock state; nothing reaches a provider.

/** Past the stack's settle time (`SETTLE_MS`), so a key isn't taken for a slip. */
const SETTLED_MS = 400;

const QUESTION = "Where should a running worker show while the orchestrator chat stays open?";
const CONTEXT = [
  "The orchestrator chat is where most decisions happen, so whatever we pick must leave its width",
  "alone at 1000 px. Workers today open in their own tab, which hides the chat they report to.",
  "Several users asked to keep one worker in view while answering the orchestrator's questions,",
  "and the dock already exists for the terminal. The choice decides where the worker's live",
  "output, its asks and its stop button live, and which of them stay visible on a narrow window.",
].join(" ");
const OPTIONS = [
  {
    label: "Docked workers panel beside the chat",
    description: "One tab per worker to the right; the chat keeps its width above 1200 px.",
  },
  {
    label: "Floating worker windows over the chat",
    description: "Each worker in a small window that can be moved and pinned.",
  },
  {
    label: "Inline worker cards in the stream",
    description: "A card per worker in the orchestrator's own stream, folded by default.",
  },
  {
    label: "Docked Workers panel at the bottom",
    description: "Under the composer, as the terminal is; short on small screens.",
  },
] as const;
/** The orchestrator's pick, which comes first so ⏎ takes it. */
const RECOMMENDED = OPTIONS[2].label;
/** In key order: the pick, then the rest as asked. */
const IN_ORDER = [OPTIONS[2], OPTIONS[0], OPTIONS[1], OPTIONS[3]];

const start = async (page: Page) => {
  await page.setViewportSize({ width: 1000, height: 820 });
  await page.goto("/t/t-flaky");
  // At this width the overview is its compact rail.
  await expect(page.getByTestId("overview-rail")).toBeVisible();
  const made = await page.evaluate(
    async ([question, context, options, recommended]) => {
      const mock = window.gramMock!;
      const seeded = await mock.simulateAsks();
      mock.simulateAskUser(seeded.workspaceId, { question, context, options, recommended });
      return seeded;
    },
    [QUESTION, CONTEXT, OPTIONS, RECOMMENDED] as const,
  );
  await openOrchestratorTile(page, made.orchestratorThreadId);
  await expect(page.getByTestId("ask-stack")).toBeVisible();
  return made;
};

/** Every option is on screen whole: inside `box`, and no label cut short. */
const allFit = async (options: Locator, box: Locator) => {
  await expect(options).toHaveCount(OPTIONS.length);
  const outer = (await box.boundingBox())!;
  for (const option of await options.all()) {
    // A narrow detail pane may scroll to them; nothing is ever clipped sideways.
    await option.scrollIntoViewIfNeeded();
    await expect(option).toBeInViewport({ ratio: 0.95 });
    const inner = (await option.boundingBox())!;
    expect(inner.x).toBeGreaterThanOrEqual(outer.x - 0.5);
    expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width + 0.5);
    expect(await option.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
  }
  await expect(options).toHaveText(IN_ORDER.map((option) => new RegExp(option.label)));
  await expect(options.getByTestId("ask-choice-description")).toHaveText(
    IN_ORDER.map((option) => option.description),
  );
  await expect(options.first().getByTestId("ask-recommended")).toHaveText("Recommended");
  await expect(options.getByTestId("ask-recommended")).toHaveCount(1);
};

/** The context opens past its lines with More, and folds again with Less. */
const contextOpens = async (text: Locator, more: Locator) => {
  await expect(text).not.toHaveAttribute("data-open");
  await expect(more).toHaveText("More");
  const folded = (await text.boundingBox())!.height;
  await more.click();
  await expect(text).toHaveAttribute("data-open", "true");
  await expect(more).toHaveText("Less");
  await expect(more).toHaveAttribute("aria-expanded", "true");
  expect((await text.boundingBox())!.height).toBeGreaterThan(folded * 1.5);
  expect(await text.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(
    true,
  );
  await more.click();
  await expect(text).not.toHaveAttribute("data-open");
};

const currentAsk = (page: Page) =>
  page.getByTestId("ask-stack").locator('li:not([inert]) [data-testid="ask-item"][data-current]');

test("in the stack, four long choices all show with their descriptions, and the context opens", async ({
  page,
}) => {
  await start(page);
  const stack = page.getByTestId("ask-stack");
  for (let tries = 0; tries < 8; tries++) {
    if ((await currentAsk(page).getByTestId("ask-title").textContent())?.includes(QUESTION)) break;
    await stack.getByTestId("ask-next").click();
  }
  const ask = currentAsk(page);
  await expect(ask.getByTestId("ask-title")).toHaveText(QUESTION);
  await expect(ask.getByTestId("ask-choices")).toHaveAttribute("data-layout", "list");
  await allFit(ask.getByTestId("ask-option"), stack);
  await contextOpens(ask.getByTestId("ask-description"), ask.getByTestId("ask-description-more"));

  // The keys still pick by number, and an answer can still be taken back.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(SETTLED_MS);
  await page.keyboard.press("4");
  await expect(stack.getByTestId("ask-undo-line")).toContainText(IN_ORDER[3]!.label);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(stack.getByTestId("ask-undo-line")).toHaveCount(0);
  await expect(currentAsk(page).getByTestId("ask-title")).toHaveText(QUESTION);

  // A short two-way approval keeps its row of buttons.
  for (let tries = 0; tries < 8; tries++) {
    if ((await currentAsk(page).getByTestId("ask-title").textContent())?.includes("× 3")) break;
    await stack.getByTestId("ask-next").click();
  }
  await expect(currentAsk(page).getByTestId("ask-choices")).toHaveAttribute("data-layout", "row");
});

test("Quiet's card shows the same choices whole", async ({ page }) => {
  await start(page);
  await expect(page.getByTestId("ask-stack")).toBeVisible();
  // By its key: at this width the title bar's usage meter overlaps the Quiet toggle.
  await page.keyboard.press("ControlOrMeta+Alt+4");
  const card = page.getByTestId("quiet-view").getByTestId("quiet-card");
  for (let tries = 0; tries < 12; tries++) {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.waitForTimeout(SETTLED_MS);
    if ((await card.getByTestId("quiet-title").textContent())?.includes(QUESTION)) break;
    await page.keyboard.press("ArrowRight");
  }
  await expect(card.getByTestId("quiet-title")).toHaveText(QUESTION);
  await allFit(card.getByTestId("quiet-option"), card);
  await contextOpens(
    card.getByTestId("quiet-description"),
    card.getByTestId("quiet-description-more"),
  );
});
