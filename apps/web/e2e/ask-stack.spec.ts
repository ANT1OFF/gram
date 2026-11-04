import { expect, test, type Page } from "@playwright/test";

import { flakyAsked } from "./seed-asks";
import { slowdown } from "./slowdown";
import { openOrchestrator, threadRow } from "./thread-row";

// The ask stack above the orchestrator's composer. Mock state lives
// in memory, so every step after the seed navigates inside the app; nothing reloads.

const MOCK_SETTINGS_KEY = "gram.mock.settings";
/** The stack's undo window (`UNDO_MS`) and then some, for an answer to have gone out. */
const SENT_MS = 8_000;
/** Past the stack's settle time (`SETTLE_MS`), so a key isn't taken for a slip. */
const SETTLED_MS = 400;

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const start = async (page: Page, settings: Record<string, unknown> = {}) => {
  await page.addInitScript(([key, more]) => sessionStorage.setItem(key, JSON.stringify(more)), [
    MOCK_SETTINGS_KEY,
    settings,
  ] as const);
  // The undo window runs on the installed clock, so waiting past it takes no real time.
  await page.clock.install();
  await page.goto("/t/t-flaky");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  const made = await page.evaluate(() => {
    // Every answer the stack sends, as the server would hear it.
    const mock = window.gramMock!;
    const sent: unknown[] = [];
    (window as unknown as { sentAnswers: unknown[] }).sentAnswers = sent;
    const respondMany = mock.respondMany.bind(mock);
    mock.respondMany = (answers) => {
      sent.push(...answers.map((a) => ({ requestId: a.requestId, answer: a.answer })));
      return respondMany(answers);
    };
    // One answer each: what `respondMany` passes on to `respond` is the same answer again.
    let many = 0;
    mock.respondMany = ((inner) => async (answers) => {
      many++;
      try {
        return await inner(answers);
      } finally {
        many--;
      }
    })(mock.respondMany);
    const respond = mock.respond.bind(mock);
    mock.respond = (threadId, requestId, answer) => {
      if (many === 0) sent.push({ requestId, answer });
      return respond(threadId, requestId, answer);
    };
    const answerQuestion = mock.answerQuestion.bind(mock);
    mock.answerQuestion = (input) => {
      sent.push({ questionId: input.questionId, answer: input.answer });
      return answerQuestion(input);
    };
    return mock.simulateAsks();
  });
  // The seed's own answers aren't the stack's.
  await page.evaluate(() => {
    (window as unknown as { sentAnswers: unknown[] }).sentAnswers.length = 0;
  });
  // In the app, as a user would: the workspace's row in the overview.
  await openOrchestrator(page, made.orchestratorThreadId);
  await expect(page.getByTestId("ask-stack")).toBeVisible();
  return made;
};

const sentAnswers = (page: Page) =>
  page.evaluate(() => (window as unknown as { sentAnswers: unknown[] }).sentAnswers);

/** The ask the keys act on; one answered or stepped from may still be folding away, inert. */
const currentAsk = (page: Page) =>
  page.getByTestId("ask-stack").locator('li:not([inert]) [data-testid="ask-item"][data-current]');

/** The stack, whose `data-count` is how many asks it holds: it shows no count of its own. */
const count = (page: Page) => page.getByTestId("ask-stack");

/** Steps with › until the current ask's title holds `text`. */
const goTo = async (page: Page, text: string) => {
  const stack = page.getByTestId("ask-stack");
  await expect(currentAsk(page)).toBeVisible();
  for (let tries = 0; tries < 8; tries++) {
    const title = await currentAsk(page).getByTestId("ask-title").textContent();
    if (title?.includes(text)) return;
    await stack.getByTestId("ask-next").click();
  }
  await expect(currentAsk(page).getByTestId("ask-title")).toContainText(text);
};

/** Focus on nothing that types or activates, as after a click on the transcript. */
const blur = async (page: Page) => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(SETTLED_MS);
};

const pending = (page: Page, threadId: string) =>
  page.evaluate(
    (id) => window.gramMock!.world.summary(id as never).pendingRequests.map((r) => r.id),
    threadId,
  );

test("each ask shows once with what its Allow covers, and 1 then ⌘⏎ allows all three after the undo window", async ({
  page,
}) => {
  const made = await start(page);
  const stack = page.getByTestId("ask-stack");
  await goTo(page, "git push");
  const top = currentAsk(page);
  // The exact command, once for all three workers, and where each would run it.
  await expect(top.getByTestId("ask-command")).toHaveText("git push -u origin feat/mail-trigger");
  await expect(top.getByTestId("ask-title")).toContainText("× 3");
  await expect(top.getByTestId("ask-description")).toHaveText(
    "Publish the branch so the pull request can be opened.",
  );
  await expect(top.getByTestId("ask-option").first()).toContainText("Allow 3");
  await top.getByTestId("ask-details").click();
  await expect(top.getByTestId("ask-member")).toHaveCount(3);
  await expect(top.getByTestId("ask-member").first()).toContainText("(feat/mail-trigger)");
  await expect(stack.getByTestId("ask-elsewhere")).toContainText("in billing");

  // Nowhere else: the worker rows say only that they ask, the overview has no inbox, the tray no
  // questions.
  const overview = page.getByTestId("overview-sidebar");
  await expect(overview.getByTestId("approval-card")).toHaveCount(0);
  await expect(threadRow(page, made.pushers[0]).getByTestId("overview-worker-now")).toHaveText(
    "asks you",
  );
  await expect(overview.getByText(/^Approve: /)).toHaveCount(0);
  await expect(page.getByTestId("waiting-questions")).toHaveCount(0);

  await blur(page);
  const before = Number(await count(page).getAttribute("data-count"));
  // Enter no longer answers: a number picks, and ⌘⏎ sends what is picked.
  await page.keyboard.press("Enter");
  await page.waitForTimeout(SETTLED_MS);
  await expect(stack.getByTestId("ask-undo-line")).toHaveCount(0);
  await page.keyboard.press("1");
  await expect(top.getByTestId("ask-option").first()).toHaveAttribute("data-picked", "true");
  await expect(top.getByTestId("ask-option").first().getByTestId("ask-kbd")).toHaveText(
    /^(⌘|Ctrl)/,
  );
  await expect(stack.getByTestId("ask-undo-line")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(stack.getByTestId("ask-undo-line")).toContainText("Allowed 3");
  await expect(stack.getByTestId("drawn-check")).toBeVisible();
  await expect(count(page)).toHaveAttribute("data-count", String(before - 1));
  // Held for the undo window, then sent to all three at once, as Allow, once.
  expect(await pending(page, made.pushers[0])).toHaveLength(1);
  await page.clock.runFor(SENT_MS);
  for (const worker of made.pushers) {
    await expect.poll(() => pending(page, worker)).toEqual([]);
  }
  expect(await sentAnswers(page)).toEqual(
    made.pushers.map((worker) => ({
      requestId: `${worker === made.waitingApart ? "r-push-again" : "r-push"}-${worker}`,
      answer: { kind: "approval", decision: "allow", scope: "once" },
    })),
  );
  // Sent, the undo line goes: there is nothing left to take back.
  await expect(stack.getByTestId("ask-undo-line")).toHaveCount(0);
  await expect(count(page)).toHaveAttribute("data-count", String(before - 1));
});

test("typing in the composer is never taken: plain keys type, ⌥ picks and ⌘⏎ sends", async ({
  page,
}) => {
  await start(page);
  const stack = page.getByTestId("ask-stack");
  const composer = page.getByLabel("Message", { exact: true });
  const before = await count(page).getAttribute("data-count");
  await composer.focus();
  await page.waitForTimeout(SETTLED_MS);
  // The hints say what picks from here.
  await expect(currentAsk(page).getByTestId("ask-kbd").first()).toHaveText(/^(⌥|Alt)/);
  await page.keyboard.type("2 tests fail");
  await expect(composer).toHaveValue("2 tests fail");
  await composer.fill("");
  await page.keyboard.type("1. fix");
  await expect(composer).toHaveValue("1. fix");
  await composer.fill("");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowRight");
  await expect(stack.getByTestId("ask-undo-line")).toHaveCount(0);
  await expect(count(page)).toHaveAttribute("data-count", before!);

  // ⌥2 picks the second option and ⌘⏎ sends it, from the empty composer.
  await goTo(page, "pip and uv");
  await composer.focus();
  await page.waitForTimeout(SETTLED_MS);
  await expect(currentAsk(page).getByTestId("ask-send")).toBeDisabled();
  await page.keyboard.press("Alt+Digit2");
  await expect(currentAsk(page).getByTestId("ask-option").nth(1)).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(stack.getByTestId("ask-undo-line")).toHaveCount(0);
  await expect(composer).toHaveValue("");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(stack.getByTestId("ask-undo-line")).toContainText("Keep both");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(stack.getByTestId("ask-undo-line")).toHaveCount(0);
  await page.waitForTimeout(SETTLED_MS);
  // Back, nothing is picked: ⌘⏎ sends nothing until something is.
  await page.keyboard.press("ControlOrMeta+Enter");
  await page.waitForTimeout(SETTLED_MS);
  await expect(stack.getByTestId("ask-undo-line")).toHaveCount(0);
  await page.keyboard.press("Alt+Digit1");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(stack.getByTestId("ask-undo-line")).toContainText("uv only");
});

test("Enter with only an attachment in the composer sends the draft, not an answer", async ({
  page,
}) => {
  await start(page);
  const stack = page.getByTestId("ask-stack");
  const composer = page.getByLabel("Message", { exact: true });
  const before = await count(page).getAttribute("data-count");
  await composer.evaluate((element, base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "shot.png", { type: "image/png" }));
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: data });
    element.dispatchEvent(event);
  }, PNG_BASE64);
  const chip = page.getByTestId("attachment-chip");
  await expect(chip).toHaveAttribute("data-status", "ready");
  await page.waitForTimeout(SETTLED_MS);
  // Nor ⌘⏎ while there is something to send.
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(stack.getByTestId("ask-undo-line")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(chip).toHaveCount(0);
  await expect(stack.getByTestId("ask-undo-line")).toHaveCount(0);
  await expect(count(page)).toHaveAttribute("data-count", before!);
  expect(await sentAnswers(page)).toEqual([]);
});

test("→ and the arrows step; 1 and 2 pick an option and Send answer sends exactly it", async ({
  page,
}) => {
  const made = await start(page);
  const stack = page.getByTestId("ask-stack");
  await goTo(page, "registry page");
  await blur(page);
  await page.keyboard.press("ArrowRight");
  await expect(currentAsk(page).getByTestId("ask-title")).toContainText("pip and uv");
  // The hints stay put under the pointer, so the click lands on what it pressed.
  await stack.getByTestId("ask-prev").click();
  await expect(currentAsk(page).getByTestId("ask-title")).toContainText("registry page");
  await stack.getByTestId("ask-next").click();
  await expect(currentAsk(page).getByTestId("ask-title")).toContainText("pip and uv");

  // A question's own options, by number.
  await expect(currentAsk(page).getByTestId("ask-option")).toHaveText([/uv only/, /Keep both/]);
  await blur(page);
  await page.keyboard.press("2");
  await expect(currentAsk(page).getByTestId("ask-option").nth(1)).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(stack.getByTestId("ask-undo-line")).toHaveCount(0);
  // A click picks too, and only picks: Send answer sends.
  await currentAsk(page).getByTestId("ask-option").first().click();
  await expect(currentAsk(page).getByTestId("ask-option").first()).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(stack.getByTestId("ask-undo-line")).toHaveCount(0);
  await page.keyboard.press("2");
  await currentAsk(page).getByTestId("ask-send").click();
  await expect(stack.getByTestId("ask-undo-line")).toContainText("Keep both");
  // In real time: a clock jump here leaves the expanded stack unable to collapse below, which
  // nothing in the product does, so this one wait stays real.
  await expect
    .poll(() => pending(page, made.choosing), { timeout: SENT_MS * slowdown })
    .toEqual([]);
  expect(await sentAnswers(page)).toEqual([
    {
      requestId: `r-question-${made.choosing}`,
      answer: {
        kind: "question",
        answers: {
          "The setup guide covers both pip and uv. Keep both, or uv only?": ["Keep both"],
        },
      },
    },
  ]);

  // All of them at once.
  const shown = Number(await count(page).getAttribute("data-count"));
  await stack.getByTestId("ask-expand").click();
  await expect(stack.getByTestId("ask-item")).toHaveCount(shown);
  await stack.getByTestId("ask-expand").click();
  await expect(stack.getByTestId("ask-item")).toHaveCount(1);
});

test("an answer can be taken back with ⌘Z or Undo, and nothing is sent", async ({ page }) => {
  const made = await start(page);
  const stack = page.getByTestId("ask-stack");
  await goTo(page, "git push");
  const before = await count(page).getAttribute("data-count");
  await blur(page);
  await page.keyboard.press("1");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(stack.getByTestId("ask-undo-line")).toContainText("Allowed 3");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(count(page)).toHaveAttribute("data-count", before!);
  await expect(stack.getByTestId("ask-undo-line")).toHaveCount(0);
  // The ask taken back is the one the keys reach again.
  await expect(currentAsk(page).getByTestId("ask-command")).toHaveText(
    "git push -u origin feat/mail-trigger",
  );

  // An approval's verb acts on a click, and Undo follows it.
  await currentAsk(page).getByTestId("ask-option").nth(1).click();
  await expect(stack.getByTestId("ask-undo-line")).toContainText("Denied 3");
  await stack.getByTestId("ask-undo").click();
  await expect(count(page)).toHaveAttribute("data-count", before!);

  // Past the window, the pushes still wait on the user, and nothing went out.
  await page.clock.runFor(SENT_MS);
  for (const worker of made.pushers) expect(await pending(page, worker)).toHaveLength(1);
  expect(await sentAnswers(page)).toEqual([]);
});

test("a second key right after an answer, or after the top ask changed by itself, answers nothing", async ({
  page,
}) => {
  const made = await start(page);
  const stack = page.getByTestId("ask-stack");
  await goTo(page, "git push");
  const before = Number(await count(page).getAttribute("data-count"));
  await blur(page);
  // The second key would pick on the next ask: on the first answer's heels, it doesn't.
  await page.keyboard.press("1");
  await page.keyboard.press("ControlOrMeta+Enter");
  await page.keyboard.press("1");
  await expect(stack.getByTestId("ask-undo-line")).toContainText("Allowed 3");
  await expect(count(page)).toHaveAttribute("data-count", String(before - 1));
  await expect(currentAsk(page).locator("[data-picked]")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(count(page)).toHaveAttribute("data-count", String(before));

  // Closed somewhere else, the question gives way to the push, and a pick and a send on its heels
  // don't allow the push it never saw.
  await goTo(page, "preview deploy");
  await blur(page);
  const landed = await page.evaluate(async (workspaceId) => {
    const mock = window.gramMock!;
    mock.simulateCloseQuestion(workspaceId, "Q3", "Yes, a merged PR is enough.");
    const current =
      '[data-testid="ask-stack"] li:not([inert]) [data-current] [data-testid="ask-title"]';
    const title = () => document.querySelector(current)?.textContent ?? "";
    for (let waited = 0; waited < 5_000 && !title().includes("git push"); waited += 10) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
    );
    return title();
  }, made.workspaceId);
  expect(landed).toContain("git push");
  await page.waitForTimeout(SETTLED_MS);
  await expect(stack.getByTestId("ask-undo-line")).toHaveCount(0);
  expect(await pending(page, made.pushers[0])).toHaveLength(1);
});

test("the orchestrator's own questions are asks: its pick is tagged, never picked for you", async ({
  page,
}) => {
  await start(page);
  const stack = page.getByTestId("ask-stack");
  await goTo(page, "429");
  const first = currentAsk(page).getByTestId("ask-option").first();
  await expect(first).toContainText("Retry with backoff");
  await expect(first.getByTestId("ask-recommended")).toHaveText("Recommended");
  await expect(first).toHaveAttribute("aria-checked", "false");
  await blur(page);
  await page.keyboard.press("1");
  await expect(first).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(stack.getByTestId("ask-undo-line")).toContainText("Retry with backoff");
  await page.clock.runFor(SENT_MS);
  await expect
    .poll(() => sentAnswers(page))
    .toEqual([{ questionId: "Q1", answer: "Retry with backoff" }]);
  // Answered, it leaves the stack for good.
  await expect(stack.getByTestId("ask-undo-line")).toHaveCount(0);
  await expect(stack.getByText(/429/)).toHaveCount(0);
});

test("a free-form question offers the helper's short replies, which fill the field but never send", async ({
  page,
}) => {
  const made = await start(page);
  const stack = page.getByTestId("ask-stack");
  await goTo(page, "registry page");
  const top = currentAsk(page);
  const chips = top.getByTestId("ask-reply-chip");
  await expect(chips).toHaveText([...made.replies]);
  await chips.first().click();
  await expect(top.getByTestId("ask-reply-input")).toHaveValue(made.replies[0]!);
  await expect(top.getByTestId("ask-reply-input")).toBeFocused();
  expect(await pending(page, made.freeForm.threadId)).toEqual([made.freeForm.requestId]);

  // What is typed stays with its ask through a step away and back.
  await top.getByTestId("ask-reply-input").fill("Say no packages yet, with a link");
  await stack.getByTestId("ask-next").click();
  await stack.getByTestId("ask-prev").click();
  await expect(currentAsk(page).getByTestId("ask-reply-input")).toHaveValue(
    "Say no packages yet, with a link",
  );
  await currentAsk(page).getByTestId("ask-reply-input").press("Enter");
  await expect(stack.getByTestId("ask-undo-line")).toContainText("Replied");
  await page.clock.runFor(SENT_MS);
  await expect.poll(() => pending(page, made.freeForm.threadId)).toEqual([]);
});

test("with helpers off the free-form question has no chips and no placeholder", async ({
  page,
}) => {
  await start(page, { helpers: { enabled: false } });
  await goTo(page, "registry page");
  const top = currentAsk(page);
  await expect(top.getByTestId("ask-reply-input")).toBeVisible();
  await expect(top.getByLabel("Suggested replies")).toHaveCount(0);
  await expect(top.getByTestId("ask-reply-chip")).toHaveCount(0);
});

test("an ask in another workspace is a link to its orchestrator", async ({ page }) => {
  const made = await start(page);
  await page.getByTestId("ask-stack").getByTestId("ask-elsewhere").click();
  await expect(page).toHaveURL(new RegExp(`/t/${made.other.orchestratorThreadId}$`));
  await goTo(page, "gh pr merge");
  await expect(currentAsk(page).getByTestId("ask-command")).toHaveText("gh pr merge 91 --squash");
  await expect(page.getByTestId("ask-stack").getByTestId("ask-elsewhere")).toContainText(
    "in agent-platform",
  );
});

test("every needs-you count is the list it opens, and a workspace's count opens its orchestrator", async ({
  page,
}) => {
  const made = await start(page);
  // With what the threads outside any workspace ask: the seed's question and plan, and t-flaky's
  // approval once its turn raises it.
  await flakyAsked(page);
  const workspace = (id: string) =>
    page.locator(`[data-testid="overview-workspace"][data-workspace-id="${id}"]`);
  const badge = async (id: string) =>
    Number((await workspace(id).getByTestId("overview-workspace-asks").textContent()) ?? "0");
  // The stack shows no count of its own; another workspace's asks are a link, with none either.
  const here = Number(await count(page).getAttribute("data-count"));
  await expect(page.getByTestId("ask-stack").getByTestId("ask-elsewhere")).not.toContainText(/\d/);
  // Each workspace's badge counts at least the asks its stack shows: with its failures and waits.
  expect(await badge(made.workspaceId)).toBeGreaterThanOrEqual(here);
  const needsYou = page.getByTestId("overview-needs-you");
  const all = Number(await needsYou.getAttribute("data-count"));
  await expect(needsYou).toContainText(`${all} need you`);

  // The list the pill opens has `all` items, each workspace's section as many as its badge, and
  // the threads outside any workspace the rest.
  await needsYou.click();
  await page.getByTestId("needs-you-see-all").click();
  const panel = page.getByTestId("needs-you-panel");
  await expect(panel.getByTestId("needs-you-item")).toHaveCount(all);
  for (const id of [made.workspaceId, made.other.workspaceId]) {
    await expect(
      panel
        .locator(`[data-testid="needs-you-group"][data-workspace="${id}"]`)
        .getByTestId("needs-you-item"),
    ).toHaveCount(await badge(id));
  }
  const threads = await panel
    .locator('[data-testid="needs-you-group"]:not([data-workspace])')
    .getByTestId("needs-you-item")
    .count();
  expect(threads).toBeGreaterThanOrEqual(2);
  expect((await badge(made.workspaceId)) + (await badge(made.other.workspaceId)) + threads).toBe(
    all,
  );
  // The workspace switcher's badges are the same numbers, row for row.
  await page.getByTestId("workspace-switcher-button").click();
  for (const id of [made.workspaceId, made.other.workspaceId]) {
    const name = (await workspace(id)
      .getByTestId("overview-workspace-row")
      .getAttribute("aria-label"))!.split(",")[0]!;
    await expect(
      page
        .getByTestId("workspace-switcher")
        .locator("[data-switcher-item]")
        .filter({ hasText: name })
        .getByTestId("workspace-ask-count"),
    ).toHaveText(String(await badge(id)));
  }
  await page.keyboard.press("Escape");

  // Away on a solo thread, the workspace's row brings back its orchestrator and its stack.
  await threadRow(page, "t-flaky").click();
  await expect(page).toHaveURL(/\/t\/t-flaky$/);
  await workspace(made.workspaceId).getByRole("button").first().click();
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  await expect(page.getByTestId("ask-stack")).toBeVisible();
  // Needs you lists both workspaces' asks, each under its workspace's name, then the threads'.
  await needsYou.click();
  const popover = page.getByTestId("needs-you-popover");
  await expect(popover).toBeVisible();
  await expect(popover.getByRole("region")).toHaveCount(3);
  await expect(popover.getByRole("region", { name: "Threads" })).toBeVisible();
  await expect(popover.getByTestId("needs-you-see-all")).toHaveText(`See all ${all}`);
});
