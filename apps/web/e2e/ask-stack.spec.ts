import { expect, test, type Page } from "@playwright/test";

import { flakyAsked } from "./seed-asks";
import { openOrchestrator, threadRow } from "./thread-row";

// Answering asks in the Inbox, where the Asks dock's answers moved: one answer rule (a number or a
// click picks, ⌘⏎ or Send answer sends, an approval's verbs act on a click), Undo, the settle
// guard, and the counts everywhere in step. Above the orchestrator's composer only a slim line is
// left. Mock state lives in memory, so every step after the seed navigates inside the app.

const MOCK_SETTINGS_KEY = "gram.mock.settings";
/** The undo window (`UNDO_MS`) and then some, for an answer to have gone out. */
const SENT_MS = 8_000;
/** Past the settle time (`SETTLE_MS`), so a key isn't taken for a slip. */
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
  // In the app, as a user would: the workspace's row in the overview, then its line into the Inbox.
  await openOrchestrator(page, made.orchestratorThreadId);
  await expect(page.getByTestId("inbox-line")).toBeVisible();
  await page.getByTestId("inbox-line-open").click();
  await expect(page.getByTestId("inbox")).toBeVisible();
  return made;
};

const sentAnswers = (page: Page) =>
  page.evaluate(() => (window as unknown as { sentAnswers: unknown[] }).sentAnswers);

const inbox = (page: Page) => page.getByTestId("inbox");
/** The ask the detail pane shows, which the keys act on. */
const currentAsk = (page: Page) => page.getByTestId("inbox-detail").getByTestId("ask-item");
const undoLine = (page: Page) => page.getByTestId("needs-you-undo-line");

/** Everything that needs you, as the title bar's button counts it. */
const count = (page: Page) => page.getByTestId("inbox-button");

/** Picks the Inbox's row whose words hold `text`, so the detail shows it. */
const goTo = async (page: Page, text: string) => {
  const row = inbox(page).getByTestId("inbox-item").filter({ hasText: text }).first();
  await row.click();
  await expect(page.getByTestId("inbox-detail")).toHaveAttribute(
    "data-key",
    (await row.getAttribute("data-key"))!,
  );
};

/** Focus on the list, where nothing types, and past the settle time. */
const settle = async (page: Page) => {
  await inbox(page).getByTestId("inbox-list").focus();
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

  // Nowhere else: the worker rows say only that they ask, the overview has no cards.
  const overview = page.getByTestId("overview-sidebar");
  await expect(overview.getByTestId("approval-card")).toHaveCount(0);
  await expect(threadRow(page, made.pushers[0]).getByTestId("overview-worker-now")).toHaveText(
    "asks you",
  );
  await expect(page.getByTestId("ask-stack")).toHaveCount(0);

  await settle(page);
  const before = Number(await count(page).getAttribute("data-count"));
  // A number picks, and ⌘⏎ sends what is picked.
  await page.keyboard.press("1");
  await expect(top.getByTestId("ask-option").first()).toHaveAttribute("data-picked", "true");
  await expect(top.getByTestId("ask-option").first().getByTestId("ask-kbd")).toHaveText(
    /^(⌘|Ctrl)/,
  );
  await expect(undoLine(page)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(undoLine(page)).toContainText("Allowed 3");
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
  await expect(undoLine(page)).toHaveCount(0);
  await expect(count(page)).toHaveAttribute("data-count", String(before - 1));
});

test("the orchestrator's composer is its own: no key there answers, and Enter sends the draft", async ({
  page,
}) => {
  await start(page);
  await page.keyboard.press("Escape");
  await expect(inbox(page)).toBeHidden();
  const composer = page.getByLabel("Message", { exact: true });
  const before = await count(page).getAttribute("data-count");
  await composer.focus();
  await page.waitForTimeout(SETTLED_MS);
  await page.keyboard.type("2 tests fail");
  await expect(composer).toHaveValue("2 tests fail");
  await composer.fill("");
  await page.keyboard.press("Alt+Digit1");
  await page.keyboard.press("ControlOrMeta+Enter");
  await page.waitForTimeout(SETTLED_MS);
  await expect(page.getByTestId("inbox-line-undo")).toHaveCount(0);
  await expect(count(page)).toHaveAttribute("data-count", before!);

  // With only an attachment, Enter sends the draft.
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
  await page.keyboard.press("Enter");
  await expect(chip).toHaveCount(0);
  await expect(count(page)).toHaveAttribute("data-count", before!);
  expect(await sentAnswers(page)).toEqual([]);
});

test("j and k move; 1 and 2 pick an option and Send answer sends exactly it", async ({ page }) => {
  const made = await start(page);
  await goTo(page, "registry page");
  const items = inbox(page).getByTestId("inbox-item");
  const at = await items.evaluateAll((all) =>
    all.findIndex((each) => each.textContent?.includes("registry page")),
  );
  await settle(page);
  await page.keyboard.press("j");
  await expect(page.getByTestId("inbox-detail")).toHaveAttribute(
    "data-key",
    (await items.nth(at + 1).getAttribute("data-key"))!,
  );
  await page.keyboard.press("k");
  await expect(currentAsk(page).getByTestId("ask-title")).toContainText("registry page");

  await goTo(page, "pip and uv");
  // A question's own options, by number.
  await expect(currentAsk(page).getByTestId("ask-option")).toHaveText([/uv only/, /Keep both/]);
  await settle(page);
  await page.keyboard.press("2");
  await expect(currentAsk(page).getByTestId("ask-option").nth(1)).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(undoLine(page)).toHaveCount(0);
  // A click picks too, and only picks: Send answer sends.
  await currentAsk(page).getByTestId("ask-option").first().click();
  await expect(currentAsk(page).getByTestId("ask-option").first()).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(undoLine(page)).toHaveCount(0);
  await page.keyboard.press("2");
  await currentAsk(page).getByTestId("ask-send").click();
  await expect(undoLine(page)).toContainText("Keep both");
  await page.clock.runFor(SENT_MS);
  await expect.poll(() => pending(page, made.choosing)).toEqual([]);
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
});

test("an answer can be taken back with ⌘Z or Undo, and nothing is sent", async ({ page }) => {
  const made = await start(page);
  await goTo(page, "git push");
  const before = await count(page).getAttribute("data-count");
  await settle(page);
  await page.keyboard.press("1");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(undoLine(page)).toContainText("Allowed 3");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(count(page)).toHaveAttribute("data-count", before!);
  await expect(undoLine(page)).toHaveCount(0);
  // The ask taken back is the one shown again.
  await expect(currentAsk(page).getByTestId("ask-command")).toHaveText(
    "git push -u origin feat/mail-trigger",
  );

  // An approval's verb acts on a click, and Undo follows it.
  await currentAsk(page).getByTestId("ask-option").nth(1).click();
  await expect(undoLine(page)).toContainText("Denied 3");
  await page.getByTestId("needs-you-undo").click();
  await expect(count(page)).toHaveAttribute("data-count", before!);

  // Past the window, the pushes still wait on the user, and nothing went out.
  await page.clock.runFor(SENT_MS);
  for (const worker of made.pushers) expect(await pending(page, worker)).toHaveLength(1);
  expect(await sentAnswers(page)).toEqual([]);
});

test("an answer held in the Inbox hides the worker's own card until Undo brings it back", async ({
  page,
}) => {
  const made = await start(page);
  await goTo(page, "git push");
  await currentAsk(page).getByTestId("ask-option").first().click();
  await expect(undoLine(page)).toContainText("Allowed 3");
  await page.keyboard.press("Escape");
  // The worker's own card: answered, so not offered a second time while Undo stands.
  await openOrchestrator(page, made.orchestratorThreadId);
  await threadRow(page, made.pushers[0]).click();
  await expect(page).toHaveURL(new RegExp(`/t/${made.pushers[0]}$`));
  await expect(page.getByTestId("approval-card")).toHaveCount(0);
  // The orchestrator's line keeps the Undo; taken back, the card is there again.
  await openOrchestrator(page, made.orchestratorThreadId);
  await page.getByTestId("inbox-line-undo-button").click();
  await threadRow(page, made.pushers[0]).click();
  await expect(page.getByTestId("approval-card")).toBeVisible();
  await page.clock.runFor(SENT_MS);
  expect(await sentAnswers(page)).toEqual([]);
});

test("a second key right after an answer, or after the shown ask changed by itself, answers nothing", async ({
  page,
}) => {
  const made = await start(page);
  await goTo(page, "git push");
  const before = Number(await count(page).getAttribute("data-count"));
  await settle(page);
  // The second key would pick on the next ask: on the first answer's heels, it doesn't.
  await page.keyboard.press("1");
  await page.keyboard.press("ControlOrMeta+Enter");
  await page.keyboard.press("1");
  await expect(undoLine(page)).toContainText("Allowed 3");
  await expect(count(page)).toHaveAttribute("data-count", String(before - 1));
  await expect(currentAsk(page).locator("[data-picked]")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(count(page)).toHaveAttribute("data-count", String(before));

  // Closed somewhere else, the question gives way to the next, and a pick and a send on its heels
  // don't answer the ask they never saw.
  await goTo(page, "preview deploy");
  await settle(page);
  const landed = await page.evaluate(
    async ([workspaceId, selector]) => {
      const mock = window.gramMock!;
      const key = () => document.querySelector(selector)?.getAttribute("data-key");
      const first = key();
      mock.simulateCloseQuestion(workspaceId, "Q3", "Yes, a merged PR is enough.");
      for (let waited = 0; waited < 5_000 && key() === first; waited += 10) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const list = document.querySelector('[data-testid="inbox-list"]')!;
      list.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
      list.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
      );
      return key() !== first;
    },
    [made.workspaceId, '[data-testid="inbox-detail"]'] as const,
  );
  expect(landed).toBe(true);
  await page.waitForTimeout(SETTLED_MS);
  await expect(undoLine(page)).toHaveCount(0);
  await expect(currentAsk(page).locator("[data-picked]")).toHaveCount(0);
});

test("the orchestrator's own questions are asks: its pick is tagged, never picked for you", async ({
  page,
}) => {
  await start(page);
  await goTo(page, "429");
  const first = currentAsk(page).getByTestId("ask-option").first();
  await expect(first).toContainText("Retry with backoff");
  await expect(first.getByTestId("ask-recommended")).toHaveText("Recommended");
  await expect(first).toHaveAttribute("aria-checked", "false");
  await settle(page);
  await page.keyboard.press("1");
  await expect(first).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(undoLine(page)).toContainText("Retry with backoff");
  await page.clock.runFor(SENT_MS);
  await expect
    .poll(() => sentAnswers(page))
    .toEqual([{ questionId: "Q1", answer: "Retry with backoff" }]);
  // Answered, it leaves the Inbox for good.
  await expect(undoLine(page)).toHaveCount(0);
  await expect(inbox(page).getByTestId("inbox-item").filter({ hasText: /429/ })).toHaveCount(0);
});

test("a free-form question offers the helper's short replies, which fill the field but never send", async ({
  page,
}) => {
  const made = await start(page);
  await goTo(page, "registry page");
  const top = currentAsk(page);
  const chips = top.getByTestId("ask-reply-chip");
  await expect(chips).toHaveText([...made.replies]);
  await chips.first().click();
  await expect(top.getByTestId("ask-reply-input")).toHaveValue(made.replies[0]!);
  await expect(top.getByTestId("ask-reply-input")).toBeFocused();
  expect(await pending(page, made.freeForm.threadId)).toEqual([made.freeForm.requestId]);

  // What is typed stays with its ask through a step away and back; j and k type in the field.
  await top.getByTestId("ask-reply-input").fill("Say no packages yet, with a link");
  await top.getByTestId("ask-reply-input").press("j");
  await expect(top.getByTestId("ask-reply-input")).toHaveValue("Say no packages yet, with a linkj");
  await top.getByTestId("ask-reply-input").press("Backspace");
  await goTo(page, "git push");
  await goTo(page, "registry page");
  await expect(currentAsk(page).getByTestId("ask-reply-input")).toHaveValue(
    "Say no packages yet, with a link",
  );
  await currentAsk(page).getByTestId("ask-reply-input").press("Enter");
  await expect(undoLine(page)).toContainText("Replied");
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

test("an ask in another workspace is in the same Inbox, and Open thread goes to the worker", async ({
  page,
}) => {
  const made = await start(page);
  await goTo(page, "gh pr merge");
  await expect(currentAsk(page).getByTestId("ask-command")).toHaveText("gh pr merge 91 --squash");
  await expect(page.getByTestId("inbox-detail-where")).toContainText("billing");
  await page.getByTestId("inbox-open-thread").click();
  await expect(page).toHaveURL(new RegExp(`/t/${made.other.asking}$`));
});

test("every needs-you count is the list it opens, and a workspace's count opens its orchestrator", async ({
  page,
}) => {
  const made = await start(page);
  await page.keyboard.press("Escape");
  // With what the threads outside any workspace ask: the seed's question and plan, and t-flaky's
  // approval once its turn raises it.
  await flakyAsked(page);
  const workspace = (id: string) =>
    page.locator(`[data-testid="overview-workspace"][data-workspace-id="${id}"]`);
  const badge = async (id: string) =>
    Number((await workspace(id).getByTestId("overview-workspace-asks").textContent()) ?? "0");
  // The orchestrator's line counts the workspace's share, as its badge does.
  await expect(page.getByTestId("inbox-line")).toHaveAttribute(
    "data-count",
    String(await badge(made.workspaceId)),
  );
  const needsYou = page.getByTestId("overview-needs-you");
  const all = Number(await needsYou.getAttribute("data-count"));
  await expect(needsYou).toContainText(`${all} need you`);
  await expect(count(page)).toHaveAttribute("data-count", String(all));

  // The list the pill opens has `all` items, by kind; each workspace's rows as many as its badge,
  // and the threads outside any workspace the rest.
  await needsYou.click();
  const items = inbox(page).getByTestId("inbox-item");
  await expect(items).toHaveCount(all);
  for (const id of [made.workspaceId, made.other.workspaceId]) {
    await expect(
      inbox(page).locator(`[data-testid="inbox-item"][data-workspace="${id}"]`),
    ).toHaveCount(await badge(id));
  }
  const threads = await inbox(page)
    .locator('[data-testid="inbox-item"]:not([data-workspace])')
    .count();
  expect(threads).toBeGreaterThanOrEqual(2);
  expect((await badge(made.workspaceId)) + (await badge(made.other.workspaceId)) + threads).toBe(
    all,
  );
  // Each row of a workspace's says its name.
  const name = (await workspace(made.workspaceId)
    .getByTestId("overview-workspace-row")
    .getAttribute("aria-label"))!.split(",")[0]!;
  const own = inbox(page).locator(
    `[data-testid="inbox-item"][data-workspace="${made.workspaceId}"]`,
  );
  for (const where of await own.getByTestId("inbox-item-where").allTextContents()) {
    expect(where.startsWith(`${name} · `)).toBe(true);
  }
  await page.keyboard.press("Escape");

  // The workspace switcher's badges are the same numbers, row for row.
  await page.getByTestId("workspace-switcher-button").click();
  for (const id of [made.workspaceId, made.other.workspaceId]) {
    const label = (await workspace(id)
      .getByTestId("overview-workspace-row")
      .getAttribute("aria-label"))!.split(",")[0]!;
    await expect(
      page
        .getByTestId("workspace-switcher")
        .locator("[data-switcher-item]")
        .filter({ hasText: label })
        .getByTestId("workspace-ask-count"),
    ).toHaveText(String(await badge(id)));
  }
  await page.keyboard.press("Escape");

  // Away on a solo thread, the workspace's row brings back its orchestrator and its line.
  await threadRow(page, "t-flaky").click();
  await expect(page).toHaveURL(/\/t\/t-flaky$/);
  await expect(page.getByTestId("inbox-line")).toHaveCount(0);
  await workspace(made.workspaceId).getByRole("button").first().click();
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  await expect(page.getByTestId("inbox-line")).toBeVisible();
});

test("Send answer turns the worker's row, card and chip to answered with the count, not asks you", async ({
  page,
}) => {
  // The realistic morning: one worker in billing-api asks how long a refund webhook retries.
  await page.addInitScript(() => sessionStorage.setItem("gram.mock.orchestration", "realistic"));
  await page.goto("/");
  await page.getByTestId("app-shell").waitFor();
  const made = await page.evaluate(async () => {
    const started = await window.gramMock!.startedRealistic();
    if (started === undefined)
      throw new Error("the mock did not start with the realistic scenario");
    const workspace = (await window.gramMock!.listWorkspaces()).find(
      (state) => state.workspace.id === started.askingWorkspaceId,
    )!.workspace;
    return { asking: started.asking, orchestrator: workspace.orchestratorThreadId! };
  });
  await openOrchestrator(page, made.orchestrator);
  const row = page.locator(`[data-testid="overview-worker"][data-thread-id="${made.asking}"]`);
  const card = page
    .getByTestId("feature-card")
    .filter({ has: page.locator(`[data-thread-id="${made.asking}"]`) })
    .or(page.getByTestId("feature-card").filter({ hasText: "Idempotent refund" }));
  await expect(row.getByTestId("overview-worker-now")).toHaveText("asks you");
  await expect(card.getByTestId("feature-card-now")).toHaveText("asks you");
  const pill = page.getByTestId("overview-needs-you");
  const before = Number((await pill.textContent())?.match(/\d+/)?.[0]);

  await page.getByTestId("inbox-line-open").click();
  await goTo(page, "A refund webhook");
  await currentAsk(page).getByTestId("ask-option").filter({ hasText: "72 hours" }).click();
  await currentAsk(page).getByTestId("ask-send").click();
  await page.keyboard.press("Escape");

  // Inside Undo's window, before the answer has even gone out: every view says so with the count.
  await expect(pill).toContainText(String(before - 1));
  await expect(row.getByTestId("overview-worker-now")).toHaveText("answered · resuming");
  await expect(row).not.toHaveAttribute("data-asking");
  await expect(row.getByTestId("overview-worker-dot")).not.toHaveAttribute("data-tone", "needs");
  await expect(card.getByTestId("feature-card-now")).toHaveText("answered · resuming");
  await page.getByRole("radio", { name: /^Board\b/ }).click();
  const chip = page.locator(`[data-testid="rail-worker"][data-thread-id="${made.asking}"]`);
  await expect(chip).toBeVisible();
  await expect(chip).not.toHaveAttribute("data-tone", "needs");
  await expect(chip).not.toHaveAttribute("data-asking");
  await expect(chip.getByTestId("rail-now")).not.toHaveText("asks you");
  // Sent, the worker runs again: nothing goes back to asking.
  await expect(chip).toHaveAttribute("data-tone", "working", { timeout: 15_000 });
  await expect(page.getByTestId("overview-sidebar")).not.toContainText("asks you");
});
