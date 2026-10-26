import { expect, test, type Page } from "@playwright/test";

import { slowdown } from "./slowdown";
import { flakyAsked, flakyAsks } from "./seed-asks";
import { openOrchestrator, threadRow } from "./thread-row";

// The ask stack above the orchestrator's composer. Mock state lives
// in memory, so every step after the seed navigates inside the app; nothing reloads.

const MOCK_SETTINGS_KEY = "gram.mock.settings";
/** The stack's undo window (`UNDO_MS`) and then some, for an answer to have gone out. */
const SENT_MS = 8_000 * slowdown;
/** Past the stack's settle time (`SETTLE_MS`), so a key isn't taken for a slip. */
const SETTLED_MS = 400;

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const start = async (page: Page, settings: Record<string, unknown> = {}) => {
  await page.addInitScript(([key, more]) => sessionStorage.setItem(key, JSON.stringify(more)), [
    MOCK_SETTINGS_KEY,
    settings,
  ] as const);
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

const count = (page: Page) => page.getByTestId("ask-stack").getByTestId("ask-stack-count");

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

test("each ask shows once with what its Allow covers, and Enter allows all three after the undo window", async ({
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
  const before = Number(await count(page).textContent());
  await page.keyboard.press("Enter");
  await expect(stack.getByTestId("ask-undo-line")).toContainText("Allowed 3");
  await expect(stack.getByTestId("drawn-check")).toBeVisible();
  await expect(count(page)).toHaveText(String(before - 1));
  // Held for the undo window, then sent to all three at once, as Allow, once.
  expect(await pending(page, made.pushers[0])).toHaveLength(1);
  for (const worker of made.pushers) {
    await expect.poll(() => pending(page, worker), { timeout: SENT_MS }).toEqual([]);
  }
  expect(await sentAnswers(page)).toEqual(
    made.pushers.map((worker) => ({
      requestId: `${worker === made.waitingApart ? "r-push-again" : "r-push"}-${worker}`,
      answer: { kind: "approval", decision: "allow", scope: "once" },
    })),
  );
  // Sent, the undo line goes: there is nothing left to take back.
  await expect(stack.getByTestId("ask-undo-line")).toHaveCount(0);
  await expect(count(page)).toHaveText(String(before - 1));
});

test("typing in the composer is never taken: plain keys type, modifiers answer", async ({
  page,
}) => {
  await start(page);
  const stack = page.getByTestId("ask-stack");
  const composer = page.getByLabel("Message", { exact: true });
  const before = await count(page).textContent();
  await composer.focus();
  await page.waitForTimeout(SETTLED_MS);
  // The hints say what answers from here.
  await expect(currentAsk(page).getByTestId("ask-kbd").first()).toHaveText(/^(⌘|Ctrl)/);
  await page.keyboard.type("2 tests fail");
  await expect(composer).toHaveValue("2 tests fail");
  await composer.fill("");
  await page.keyboard.type("1. fix");
  await expect(composer).toHaveValue("1. fix");
  await composer.fill("");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowRight");
  await expect(stack.getByTestId("ask-undo-line")).toHaveCount(0);
  await expect(count(page)).toHaveText(before!);

  // ⌥2 picks the second option, and ⌘⏎ the first, from the empty composer.
  await goTo(page, "pip and uv");
  await composer.focus();
  await page.waitForTimeout(SETTLED_MS);
  await page.keyboard.press("Alt+Digit2");
  await expect(stack.getByTestId("ask-undo-line")).toContainText("Keep both");
  await expect(composer).toHaveValue("");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(stack.getByTestId("ask-undo-line")).toHaveCount(0);
  await page.waitForTimeout(SETTLED_MS);
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(stack.getByTestId("ask-undo-line")).toContainText("uv only");
});

test("Enter with only an attachment in the composer sends the draft, not an answer", async ({
  page,
}) => {
  await start(page);
  const stack = page.getByTestId("ask-stack");
  const composer = page.getByLabel("Message", { exact: true });
  const before = await count(page).textContent();
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
  await expect(count(page)).toHaveText(before!);
  expect(await sentAnswers(page)).toEqual([]);
});

test("→ and the arrows step; 1 and 2 pick an option and send exactly it", async ({ page }) => {
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
  await expect(stack.getByTestId("ask-undo-line")).toContainText("Keep both");
  await expect.poll(() => pending(page, made.choosing), { timeout: SENT_MS }).toEqual([]);
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
  const shown = Number(await count(page).textContent());
  await stack.getByTestId("ask-expand").click();
  await expect(stack.getByTestId("ask-item")).toHaveCount(shown);
  await stack.getByTestId("ask-expand").click();
  await expect(stack.getByTestId("ask-item")).toHaveCount(1);
});

test("an answer can be taken back with ⌘Z or Undo, and nothing is sent", async ({ page }) => {
  const made = await start(page);
  const stack = page.getByTestId("ask-stack");
  await goTo(page, "git push");
  const before = await count(page).textContent();
  await blur(page);
  await page.keyboard.press("Enter");
  await expect(stack.getByTestId("ask-undo-line")).toContainText("Allowed 3");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(count(page)).toHaveText(before!);
  await expect(stack.getByTestId("ask-undo-line")).toHaveCount(0);
  // The ask taken back is the one the keys reach again.
  await expect(currentAsk(page).getByTestId("ask-command")).toHaveText(
    "git push -u origin feat/mail-trigger",
  );

  await page.waitForTimeout(SETTLED_MS);
  await page.keyboard.press("2");
  await expect(stack.getByTestId("ask-undo-line")).toContainText("Denied 3");
  await stack.getByTestId("ask-undo").click();
  await expect(count(page)).toHaveText(before!);

  // Past the window, the pushes still wait on the user, and nothing went out.
  await page.waitForTimeout(SENT_MS);
  for (const worker of made.pushers) expect(await pending(page, worker)).toHaveLength(1);
  expect(await sentAnswers(page)).toEqual([]);
});

test("a second key right after an answer, or after the top ask changed by itself, answers nothing", async ({
  page,
}) => {
  const made = await start(page);
  const stack = page.getByTestId("ask-stack");
  await goTo(page, "git push");
  const before = Number(await count(page).textContent());
  await blur(page);
  // The second Enter would open the next ask's reply field: on the first one's heels, it doesn't.
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(stack.getByTestId("ask-undo-line")).toContainText("Allowed 3");
  await expect(count(page)).toHaveText(String(before - 1));
  await expect(currentAsk(page).getByTestId("ask-reply-input")).not.toBeFocused();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(count(page)).toHaveText(String(before));

  // Closed somewhere else, the question gives way to the push, and an Enter on its heels doesn't
  // allow the push it never saw.
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
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return title();
  }, made.workspaceId);
  expect(landed).toContain("git push");
  await page.waitForTimeout(SETTLED_MS);
  await expect(stack.getByTestId("ask-undo-line")).toHaveCount(0);
  expect(await pending(page, made.pushers[0])).toHaveLength(1);
});

test("the orchestrator's own questions are asks, and Enter takes its pick", async ({ page }) => {
  await start(page);
  const stack = page.getByTestId("ask-stack");
  await goTo(page, "429");
  await expect(currentAsk(page).getByTestId("ask-option").first()).toContainText(
    "Retry with backoff",
  );
  await blur(page);
  await page.keyboard.press("Enter");
  await expect(stack.getByTestId("ask-undo-line")).toContainText("Retry with backoff");
  await expect
    .poll(() => sentAnswers(page), { timeout: SENT_MS })
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
  await expect.poll(() => pending(page, made.freeForm.threadId), { timeout: SENT_MS }).toEqual([]);
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

test("Needs you counts the asks the stacks show, and a workspace's count opens its orchestrator", async ({
  page,
}) => {
  const made = await start(page);
  const here = Number(await count(page).textContent());
  const elsewhere = await page.getByTestId("ask-stack").getByTestId("ask-elsewhere").textContent();
  const there = Number(/\d+/.exec(elsewhere ?? "")?.[0]);
  // Each workspace's row counts its own asks, and Needs you counts them all.
  const workspace = (id: string) =>
    page.locator(`[data-testid="overview-workspace"][data-workspace-id="${id}"]`);
  await expect(workspace(made.workspaceId).getByTestId("overview-workspace-asks")).toHaveText(
    String(here),
  );
  await expect(workspace(made.other.workspaceId).getByTestId("overview-workspace-asks")).toHaveText(
    String(there),
  );
  // With what the threads outside any workspace ask: the seed's question and plan, and t-flaky's
  // approval once its turn raises it.
  await flakyAsked(page);
  const all = here + there + 2 + (await flakyAsks(page));
  const needsYou = page.getByTestId("overview-needs-you");
  await expect(needsYou).toHaveAttribute("data-count", String(all));
  await expect(needsYou).toContainText(`${all} need you`);
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
