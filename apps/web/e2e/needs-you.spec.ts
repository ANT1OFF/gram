import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { parkSeedAsks } from "./seed-asks";
import { threadRow } from "./thread-row";

// The Inbox: every workspace's asks, failures and waits in one list by kind, the picked one in a
// pane beside it with its answers, Open thread, Later and Dismiss; the ⌘⇧U / ⌘⇧Y stepper. The
// title bar's button, the sidebar's pill, ⌘⇧I and ⌘⌥3 open it. Mock state lives in memory, so
// every step after the seed navigates inside the app; nothing reloads.

/** The setup guide's question, as its list row calls it: the full question is the detail's. */
const UV = "The setup guide covers both pip and uv";

/** The stack's undo window (`UNDO_MS`) and then some, for an answer to have gone out. */
const SENT_MS = 8_000;

interface Seeded {
  readonly workspaceId: string;
  readonly orchestratorThreadId: string;
  readonly choosing: string;
  readonly stopped: string;
  readonly failing: string;
  readonly other: { readonly workspaceId: string; readonly asking: string };
}

/**
 * The failures scenario (asks in two workspaces, a stopped worker, red CI), answers recorded, with
 * t-flaky's approval up: a thread outside any workspace counts its asks too, so a count read before
 * it arrives would be one short.
 */
/** A window wide enough to dock the Inbox beside a chat at its reading width (`inboxDockFit`). */
const WIDE = { width: 1728, height: 1000 };

const start = async (page: Page): Promise<Seeded> => {
  await page.setViewportSize(WIDE);
  await page.goto("/t/t-flaky");
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  await expect(page.getByTestId("approval-card")).toBeVisible();
  return page.evaluate(async () => {
    const mock = window.gramMock!;
    const sent: string[] = [];
    (window as unknown as { sent: string[] }).sent = sent;
    const respond = mock.respond.bind(mock);
    mock.respond = (threadId, requestId, answer) => {
      sent.push(`${requestId} ${answer.kind === "approval" ? answer.decision : "answer"}`);
      return respond(threadId, requestId, answer);
    };
    const made = await mock.simulateFailures();
    sent.length = 0;
    return made as unknown as Seeded;
  });
};

const sent = (page: Page) =>
  page.evaluate(() => [...(window as unknown as { sent: string[] }).sent]);

const pill = (page: Page) => page.getByTestId("overview-needs-you");
const inbox = (page: Page) => page.getByTestId("inbox");
const detail = (page: Page) => page.getByTestId("inbox-detail");
const row = (page: Page, text: string | RegExp) =>
  inbox(page).getByTestId("inbox-item").filter({ hasText: text });

const openInbox = async (page: Page) => {
  await pill(page).click();
  await expect(inbox(page)).toBeVisible();
};

/** Picks the row holding `text`, and waits for the detail pane to show it. */
const show = async (page: Page, text: string | RegExp) => {
  const picked = row(page, text);
  await picked.click();
  await expect(detail(page)).toHaveAttribute("data-key", (await picked.getAttribute("data-key"))!);
  return picked;
};

test("the pill opens every workspace's items by kind, and Open thread lands on the card that asked", async ({
  page,
}) => {
  const made = await start(page);
  // The scenario's eight (six asks, the stopped worker and the red build) and the three the threads
  // outside any workspace ask (t-flaky's push, t-question's question, t-plan's plan). Those three
  // are up first, so the count is read once the scenario's have arrived too.
  const count = 11;
  await expect(pill(page)).toHaveAttribute("data-count", String(count));
  // The pill is the one way in beside the sidebar: the title bar has no second Inbox entry.
  await expect(page.getByTestId("inbox-button")).toHaveCount(0);
  await openInbox(page);
  await expect(inbox(page).getByTestId("inbox-count")).toHaveText(`${count} need you`);
  await expect(inbox(page).getByTestId("inbox-item")).toHaveCount(count);
  // Grouped by kind, what stops work first: errors, then approvals.
  const sections = inbox(page).getByTestId("inbox-section");
  await expect(sections.first()).toHaveAttribute("data-section", "errors");
  await expect(sections.nth(1)).toHaveAttribute("data-section", "approvals");
  // The list has focus; from the pill, the newest ask is shown beside it, not the error listed
  // first.
  await expect(inbox(page).getByTestId("inbox-list")).toBeFocused();
  await expect(detail(page)).toHaveAttribute("data-kind", /^(approval|question|plan)$/);
  // A strip heads it with every category and its count, in the list's order.
  const categories = inbox(page).getByTestId("needs-you-strip").getByTestId("needs-you-category");
  await expect(categories.nth(0)).toHaveAttribute("data-category", "errors");
  await expect(categories.nth(0)).toHaveAccessibleName("Errors, 2");
  await expect(categories.nth(1)).toHaveAttribute("data-category", "approvals");
  // All only once one is picked, as the way back.
  await expect(categories.and(page.locator('[data-category="all"]'))).toHaveCount(0);
  // A pick lists that category alone.
  await categories.and(page.locator('[data-category="approvals"]')).click();
  await expect(sections).toHaveCount(1);
  await expect(inbox(page).getByRole("region", { name: "Approvals" })).toBeVisible();
  await expect(categories.first()).toHaveAttribute("data-category", "all");
  // Each row says its kind, its workspace and its thread.
  const merge = await show(page, "gh pr merge 91 --squash");
  await expect(merge.getByTestId("inbox-item-where")).toHaveText(
    "billing · Export invoices as CSV",
  );
  await expect(merge.getByRole("img", { name: "Approval" })).toBeVisible();
  await expect(detail(page).getByTestId("inbox-detail-where")).toContainText(
    "billing · Export invoices as CSV",
  );

  // Docked beside the thread, in the panel's column: the chat stays in sight.
  await expect(inbox(page)).toHaveAttribute("data-docked", "");
  await expect(page.getByRole("dialog", { name: "Inbox" })).toHaveCount(0);
  await expect(page.getByLabel("Message", { exact: true })).toBeInViewport();
  await expect(page.getByTestId("right-panel")).toHaveCount(0);

  // Show thread: the worker that asked, beside the Inbox, its card ringed and in view; the Inbox
  // stays.
  await expect(detail(page).getByTestId("inbox-open-thread")).toHaveText("Show thread");
  await detail(page).getByTestId("inbox-open-thread").click();
  await expect(page).toHaveURL(new RegExp(`/t/${made.other.asking}$`));
  const card = page.locator(`[data-request-id="r-merge-${made.other.asking}"]`);
  await expect(card).toBeInViewport();
  await expect(card).toHaveAttribute("data-needs-you-flash", "true");
  await expect(inbox(page)).toBeVisible();
  await expect(detail(page)).toHaveAttribute("data-key", (await merge.getAttribute("data-key"))!);
  // Esc closes it, and the thread it showed has focus: its composer.
  await page.keyboard.press("Escape");
  await expect(inbox(page)).toBeHidden();
  await expect(page.getByLabel("Message", { exact: true })).toBeFocused();
  // Reopened, it is where it was left, with focus on its list.
  await page.keyboard.press("ControlOrMeta+Shift+I");
  await expect(inbox(page)).toBeVisible();
  await expect(inbox(page).getByTestId("inbox-list")).toBeFocused();
  await expect(detail(page)).toHaveAttribute("data-key", (await merge.getAttribute("data-key"))!);
  // From the composer beside it, ⌘⇧I takes focus back to the list; from the list, it closes it.
  await page.getByLabel("Message", { exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+Shift+I");
  await expect(inbox(page).getByTestId("inbox-list")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+Shift+I");
  await expect(inbox(page)).toBeHidden();
  // The right panel had the column before, and has it back.
  await expect(page.getByTestId("right-panel")).toBeVisible();
});

test("list rows are two lines: what it is about, then workspace, kind, thread and age; the detail has the question", async ({
  page,
}) => {
  await start(page);
  await openInbox(page);
  const question = await show(page, UV);
  await expect(question.getByTestId("inbox-item-title")).toHaveText(UV);
  await expect(question.getByTestId("inbox-item-title")).not.toContainText("uv only");
  // Its kind (its glyph, under Questions, which says it in words), workspace and thread.
  await expect(question.getByRole("img", { name: "Question" })).toBeVisible();
  await expect(question.getByTestId("inbox-item-where")).toHaveText(
    "agent-platform · Refresh the setup guide",
  );
  // A kind its heading doesn't say is said in words: a plan, under Approvals.
  const plan = inbox(page).locator('[data-testid="inbox-item"][data-kind="plan"]');
  await expect(plan.getByTestId("inbox-item-title")).toHaveText("Plan to review");
  await expect(plan.getByTestId("inbox-item-where")).not.toContainText("Plan to review");
  // Its title wraps to a second line before it is cut, never a third; its hover says all of it.
  const lines = await question
    .getByTestId("inbox-item-title")
    .evaluate((el) =>
      Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)),
    );
  expect(lines).toBeGreaterThanOrEqual(1);
  expect(lines).toBeLessThanOrEqual(2);
  expect(await question.getAttribute("title")).toContain(
    "The setup guide covers both pip and uv. Keep both, or uv only?",
  );
  // The whole question and its choices are the detail's alone.
  await expect(detail(page)).toContainText(
    "The setup guide covers both pip and uv. Keep both, or uv only?",
  );
  await expect(detail(page).getByTestId("ask-option")).toHaveCount(2);
});

test("docked, Esc, Enter and the approval keys stay with the Inbox: the thread's approval beside it isn't answered", async ({
  page,
}) => {
  await start(page);
  await expect(page.getByTestId("approval-card")).toBeVisible();
  await openInbox(page);
  // A question with two choices shown: 3 is no key of its, nor of the thread's card beside it.
  await show(page, UV);
  await inbox(page).focus();
  await page.keyboard.press("3");
  await page.keyboard.press("1");
  await expect(page.getByTestId("approval-card")).toBeVisible();
  await expect(page.getByTestId("needs-you-undo-line")).toHaveCount(0);
  // On the dock itself, where nothing of the Inbox takes Enter either.
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("approval-card")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(inbox(page)).toBeHidden();
  await expect(page.getByTestId("approval-card")).toBeVisible();
  expect(await sent(page)).toEqual([]);
});

test("a window too narrow to dock it, and Quiet, open the Inbox as a dialog", async ({ page }) => {
  await start(page);
  await page.setViewportSize({ width: 1000, height: 720 });
  await page.keyboard.press("ControlOrMeta+Shift+I");
  await expect(page.getByRole("dialog", { name: "Inbox" })).toBeVisible();
  await expect(inbox(page)).not.toHaveAttribute("data-docked");
  await expect(inbox(page).getByTestId("inbox-list")).toBeFocused();
  // A laptop's 1440 still opens it over the work, where docking would squeeze the chat.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole("dialog", { name: "Inbox" })).toBeVisible();
  await expect(inbox(page)).not.toHaveAttribute("data-docked");
  // Widened, the same Inbox docks, where it was.
  const shown = await detail(page).getAttribute("data-key");
  await page.setViewportSize(WIDE);
  await expect(page.getByRole("dialog", { name: "Inbox" })).toHaveCount(0);
  await expect(inbox(page)).toHaveAttribute("data-docked", "");
  await expect(detail(page)).toHaveAttribute("data-key", shown!);
  await expect(inbox(page).getByTestId("inbox-list")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(inbox(page)).toBeHidden();

  // Quiet covers the window: the Inbox opens over it, and Quiet stays.
  await page.keyboard.press("ControlOrMeta+Alt+4");
  await expect(page.getByTestId("quiet-layer")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Shift+I");
  await expect(page.getByRole("dialog", { name: "Inbox" })).toBeVisible();
  await expect(inbox(page)).not.toHaveAttribute("data-docked");
  await page.keyboard.press("Escape");
  await expect(inbox(page)).toBeHidden();
  await expect(page.getByTestId("quiet-layer")).toBeVisible();
});

test("docked, its list starts full beside a readable chat, and its divider and toggle size it", async ({
  page,
}) => {
  await start(page);
  await page.setViewportSize({ width: 1728, height: 1000 });
  await page.keyboard.press("ControlOrMeta+Shift+I");
  await expect(inbox(page)).toHaveAttribute("data-docked", "");
  const list = inbox(page).getByTestId("inbox-list");
  // Full: two lines a request, its title, then where it is from and its age, so it is known
  // before it is opened; its hover says the whole of it.
  await expect(list).not.toHaveAttribute("data-compact");
  const full = (await list.boundingBox())!.width;
  expect(full).toBeGreaterThanOrEqual(260);
  const first = inbox(page).getByTestId("inbox-item").first();
  await expect(first.getByTestId("inbox-item-where")).toBeVisible();
  expect(await first.getAttribute("title")).toContain(
    (await first.getByTestId("inbox-item-where").textContent())!,
  );
  // The chat beside it keeps a readable width.
  const chat = (await page.getByLabel("Message", { exact: true }).boundingBox())!.width;
  expect(chat).toBeGreaterThan(480);
  // The keys stay in the footer.
  await expect(inbox(page).getByTestId("inbox-keys")).toContainText("j k move");

  // Compact list toggles one line a request, its where in its tooltip and the detail's.
  const toggle = inbox(page).getByTestId("inbox-compact");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(list).toHaveAttribute("data-compact", "");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const compact = (await list.boundingBox())!.width;
  expect(compact).toBeLessThan(260);
  await toggle.click();
  await expect(list).not.toHaveAttribute("data-compact");
  expect((await list.boundingBox())!.width).toBeGreaterThan(compact + 60);

  // The divider drags it; double-click puts it back.
  const divider = inbox(page).getByTestId("inbox-list-resize");
  await expect(divider).toHaveAttribute("aria-label", "Resize request list");
  const box = (await divider.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 140, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(list).toHaveAttribute("data-compact", "");
  await divider.focus();
  await page.keyboard.press("ArrowRight");
  await expect(divider).toHaveAttribute("aria-valuenow", /\d+/);
  await divider.dblclick();
  await expect(list).not.toHaveAttribute("data-compact");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
});

test("answers in the detail go out through the one path, with Undo, and nothing twice", async ({
  page,
}) => {
  // The undo window runs on the installed clock, so waiting past it takes no real time.
  await page.clock.install();
  const made = await start(page);
  await openInbox(page);
  const question = await show(page, UV);
  // Pick, then Send answer: a pick alone sends nothing.
  await detail(page).getByTestId("ask-option").filter({ hasText: "uv only" }).click();
  await expect(page.getByTestId("needs-you-undo-line")).toHaveCount(0);
  await detail(page).getByTestId("ask-send").click();
  await expect(question).toHaveCount(0);
  await expect(page.getByTestId("needs-you-undo-line")).toContainText("uv only");

  // Undo brings it back before it is sent.
  await page.getByTestId("needs-you-undo").click();
  await expect(question).toHaveCount(1);

  // An approval's verbs act on a click.
  await show(page, "gh pr merge 91 --squash");
  await detail(page)
    .getByTestId("ask-option")
    .filter({ hasText: /^Allow/ })
    .click();
  await expect(row(page, "gh pr merge 91 --squash")).toHaveCount(0);
  await show(page, "git push -u origin feat/mail-trigger");
  await detail(page).getByTestId("ask-option").filter({ hasText: /^Deny/ }).click();
  await expect(row(page, "git push -u origin feat/mail-trigger")).toHaveCount(0);

  await page.clock.runFor(SENT_MS);
  await expect
    .poll(() => sent(page))
    .toEqual(
      expect.arrayContaining([
        `r-merge-${made.other.asking} allow`,
        expect.stringMatching(/^r-push-again-.* deny$/),
      ]),
    );
  // Each once, and the question taken back never.
  const lines = await sent(page);
  expect(lines.filter((line) => line.startsWith(`r-merge-${made.other.asking}`))).toHaveLength(1);
  expect(lines.some((line) => line.startsWith(`r-question-${made.choosing}`))).toBe(false);
});

test("keys: j and k move, 2 picks, ⌘⏎ sends, ⌘Z takes it back, ⏎ opens the thread", async ({
  page,
}) => {
  await page.clock.install();
  const made = await start(page);
  await openInbox(page);
  const items = inbox(page).getByTestId("inbox-item");
  const key = (index: number) => items.nth(index).getAttribute("data-key");
  // From the top of the list.
  await items.first().click();
  await expect(detail(page)).toHaveAttribute("data-key", (await key(0))!);
  await page.keyboard.press("j");
  await expect(detail(page)).toHaveAttribute("data-key", (await key(1))!);
  await page.keyboard.press("ArrowDown");
  await expect(detail(page)).toHaveAttribute("data-key", (await key(2))!);
  await page.keyboard.press("k");
  await expect(detail(page)).toHaveAttribute("data-key", (await key(1))!);

  // A question's options carry their words and the number that picks them.
  await show(page, UV);
  await inbox(page).getByTestId("inbox-list").focus();
  const options = detail(page).getByTestId("ask-option");
  await expect(options).toHaveText([/uv only/, /Keep both/]);
  await page.clock.runFor(1_000);
  await page.keyboard.press("2");
  await expect(options.nth(1)).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("needs-you-undo-line")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page.getByTestId("needs-you-undo-line")).toContainText("Keep both");
  await expect(row(page, UV)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(row(page, UV)).toHaveCount(1);
  await expect(page.getByTestId("needs-you-undo-line")).toHaveCount(0);
  // The ask taken back is shown again.
  await expect(detail(page)).toContainText("Keep both, or uv only?");

  // ⏎ shows its thread at the turn that asked, beside the Inbox, and focus stays on the list.
  await inbox(page).getByTestId("inbox-list").focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/t/${made.choosing}$`));
  await expect(inbox(page).getByTestId("inbox-list")).toBeFocused();
  await page.keyboard.press("j");
  await expect(detail(page)).not.toContainText("Keep both, or uv only?");
  // Tab goes on from the list to the detail; ⌘L to the composer beside it.
  await page.keyboard.press("Tab");
  await expect(detail(page).locator(":focus")).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+l");
  await expect(page.getByLabel("Message", { exact: true })).toBeFocused();
  await expect(inbox(page)).toBeVisible();
});

test("an approval's keys are the thread card's: 3 denies it at once, held for Undo", async ({
  page,
}) => {
  await page.clock.install();
  await start(page);
  await openInbox(page);
  const merge = await show(page, "gh pr merge 91 --squash");
  await expect(merge).toHaveAttribute("data-kind", "approval");
  // Each verb shows its key: 1 Allow once, 3 Deny, as on the card in the thread.
  const options = detail(page).getByTestId("ask-option");
  await expect(options.filter({ hasText: "Allow" }).first().getByTestId("ask-kbd")).toHaveText("1");
  await expect(options.filter({ hasText: "Deny" }).getByTestId("ask-kbd")).toHaveText("3");
  await inbox(page).getByTestId("inbox-list").focus();
  await page.clock.runFor(1_000);
  // One press answers it: no pick and send, as on the thread's card.
  await page.keyboard.press("3");
  await expect(page.getByTestId("needs-you-undo-line")).toContainText("Denied");
  await expect(merge).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(merge).toHaveCount(1);
  expect(await sent(page)).toEqual([]);
});

test("a wait's Done resolves it, and Open thread lands on the message that added it", async ({
  page,
}) => {
  await start(page);
  await page.evaluate(() =>
    window.gramMock!.simulateWaitOnUser("t-deps" as never, {
      kind: "review",
      title: "Review the mock: needs-you-home v1",
    }),
  );
  await openInbox(page);
  const review = await show(page, "Review the mock: needs-you-home v1");
  await expect(review.getByRole("img", { name: "Review" })).toBeVisible();
  await expect(detail(page)).toHaveAttribute("data-kind", "wait");
  await expect(detail(page).getByTestId("waiting-done")).toBeVisible();
  await detail(page).getByTestId("inbox-open-thread").click();
  await expect(page).toHaveURL(/\/t\/t-deps$/);
  await expect(page.getByTestId("wait-chip")).toBeInViewport();

  const before = Number(await pill(page).getAttribute("data-count"));
  await openInbox(page);
  await show(page, "Review the mock");
  await detail(page).getByTestId("waiting-done").click();
  await expect(pill(page)).toHaveAttribute("data-count", String(before - 1));
  await expect(row(page, "Review the mock")).toHaveCount(0);
});

test("⌘⇧U and ⌘⇧Y step through what needs you, each at its thread", async ({ page }) => {
  await start(page);
  await openInbox(page);
  const items = inbox(page).getByTestId("inbox-item");
  const threads = await items.evaluateAll((all) =>
    all.map((each) => each.getAttribute("data-thread-id")),
  );
  const keys = await items.evaluateAll((all) => all.map((each) => each.getAttribute("data-key")));
  expect(threads.length).toBeGreaterThan(2);
  // The pill opened on the newest ask: the steps go on from there.
  const first = keys.indexOf(await detail(page).getAttribute("data-key"));
  expect(first).toBeGreaterThanOrEqual(0);
  await page.keyboard.press("Escape");
  await expect(inbox(page)).toBeHidden();
  const nth = (step: number) => (first + step) % threads.length;
  const at = (step: number) => new RegExp(`/t/${threads[nth(step)]}$`);

  // From the one shown, the next.
  await page.keyboard.press("ControlOrMeta+Shift+U");
  await expect(page).toHaveURL(at(1));
  await page.keyboard.press("ControlOrMeta+Shift+U");
  await expect(page).toHaveURL(at(2));
  await page.keyboard.press("ControlOrMeta+Shift+Y");
  await expect(page).toHaveURL(at(1));
  // Opened plainly (⌘⇧I), the Inbox opens on the item the steps landed on.
  await page.keyboard.press("ControlOrMeta+Shift+I");
  await expect(detail(page)).toHaveAttribute("data-key", keys[nth(1)]!);
});

test("Later puts an item away, Back now brings it, and Dismiss holds a failure behind Undo", async ({
  page,
}) => {
  const made = await start(page);
  await openInbox(page);
  // Errors picked: the stopped worker and the red build.
  await inbox(page).locator('[data-testid="needs-you-category"][data-category="errors"]').click();
  const items = inbox(page).getByTestId("inbox-item");
  await expect(items).toHaveCount(2);
  await expect(items.and(page.locator(`[data-thread-id="${made.failing}"]`))).toHaveCount(1);
  await inbox(page).locator('[data-testid="needs-you-category"][data-category="all"]').click();
  await expect(items).toHaveCount(11);

  // Later: away from the list and the count, in the Later list until it wakes or is brought back.
  const before = Number(await pill(page).getAttribute("data-count"));
  const merge = await show(page, "gh pr merge 91 --squash");
  await detail(page).getByTestId("inbox-later").click();
  await expect(merge).toHaveCount(0);
  await expect(pill(page)).toHaveAttribute("data-count", String(before - 1));
  await inbox(page).getByTestId("inbox-show-later").click();
  const later = inbox(page).getByTestId("inbox-later-item");
  await expect(later).toHaveCount(1);
  // A wake on another day than today carries its weekday ("back at Sun 00:24").
  await expect(later).toContainText(/back at (?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) )?\d{2}:\d{2}/);
  await later.getByTestId("inbox-wake").click();
  await expect(later).toHaveCount(0);
  await inbox(page).getByTestId("inbox-show-later").click();
  await expect(merge).toHaveCount(1);
  await expect(pill(page)).toHaveAttribute("data-count", String(before));

  // An approval offers no Dismiss: it is answered, or put away.
  await show(page, "gh pr merge 91 --squash");
  await expect(detail(page).getByTestId("inbox-dismiss")).toHaveCount(0);
  // Dismiss holds a failure until it fails again, behind Undo; the Board's strip loses it too.
  const red = items.and(page.locator(`[data-thread-id="${made.failing}"][data-kind="failure"]`));
  await red.click();
  await detail(page).getByTestId("inbox-dismiss").click();
  await expect(red).toHaveCount(0);
  await expect(page.getByTestId("needs-you-undo-line")).toContainText("Dismissed");
  await expect(pill(page)).toHaveAttribute("data-count", String(before - 1));
});

test("the detail shows what the asking thread said last and what it changed", async ({ page }) => {
  await start(page);
  await openInbox(page);
  await show(page, "git push origin fix/flaky-retry");
  const context = detail(page).getByTestId("inbox-context");
  await expect(context).toBeVisible();
  // Its latest turns, oldest first, the newest the one that led to the ask.
  const turns = context.getByTestId("inbox-context-turn");
  await expect(turns.last()).toContainText(
    "The test passes 20/20 now. I'd like to push the branch.",
  );
  await expect(turns.last()).toHaveAttribute("data-role", "assistant");
  expect(await turns.count()).toBeGreaterThan(1);
  expect(await turns.count()).toBeLessThanOrEqual(4);
  // And what its edits changed, as a line.
  await expect(context.getByTestId("inbox-context-changes")).toContainText("1 file changed");
});

test("with nothing waiting, the Inbox says so", async ({ page }) => {
  await page.goto("/t/t-deps");
  await expect(threadRow(page, "t-deps")).toBeVisible();
  // The seed's threads outside any workspace that need the user count until parked or seen: a
  // question, a plan, and t-flaky's red PR. The window title says the same.
  await expect(pill(page)).toHaveAttribute("data-count", "3");
  await expect(page).toHaveTitle("(3) Gram");
  await parkSeedAsks(page);
  await expect(pill(page)).toHaveText("Nothing needs you");
  await pill(page).click();
  await expect(inbox(page).getByTestId("inbox-empty")).toContainText("Nothing needs you");
  await page.keyboard.press("Escape");
  await page.evaluate(() =>
    window.gramMock!.simulateWaitOnUser("t-deps" as never, {
      kind: "action",
      title: "Rotate the deploy key",
    }),
  );
  await openInbox(page);
  await show(page, "Rotate the deploy key");
  await detail(page).getByTestId("waiting-done").click();
  await expect(inbox(page).getByTestId("inbox-empty")).toBeVisible();
});

test("a worker's question is answered in the Inbox: pick, then Send answer", async ({ page }) => {
  await page.goto("/t/t-flaky");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  await page.evaluate(() => window.gramMock!.simulateWorkerQuestions());
  await openInbox(page);
  const asked = await show(page, "Should the retry queue drop a job");
  await expect(asked).toHaveAttribute("data-kind", "question");
  // Its choice, the orchestrator's pick first, then Send answer: straight to the worker.
  await detail(page).getByTestId("ask-option").filter({ hasText: "Keep for replay" }).click();
  await expect(page.getByTestId("needs-you-undo-line")).toHaveCount(0);
  await detail(page).getByTestId("ask-send").click();
  await expect(page.getByTestId("needs-you-undo-line")).toContainText("Keep for replay");
  await expect(asked).toHaveCount(0);
});

test("narrow: the rail's pill opens an Inbox that fits, and with no pill ⌘⌥3 opens it", async ({
  page,
}) => {
  // Below the open overview's width, the compact rail carries the pill, the one way in: the title
  // bar has no Inbox button beside it.
  await page.setViewportSize({ width: 1000, height: 800 });
  await start(page);
  await expect(page.getByTestId("inbox-button")).toHaveCount(0);
  await page.getByTestId("overview-rail-needs-you").click();
  await expect(inbox(page)).toBeVisible();
  const fits = async (width: number) => {
    const box = (await inbox(page).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
  };
  await fits(1000);
  await expect(inbox(page).getByTestId("inbox-item")).toHaveCount(11);
  await page.keyboard.press("Escape");
  await expect(inbox(page)).toBeHidden();

  // Narrower, no pill is on screen: ⌘⌥3 opens it, within the window.
  await page.setViewportSize({ width: 520, height: 800 });
  await expect(page.getByTestId("overview-rail-needs-you")).toBeHidden();
  // With no pill on screen, the title bar's entry is the way in, in the pill's own words.
  await expect(page.getByTestId("inbox-button")).toHaveAccessibleName(/^\d+ needs? you: \d+ /);
  await page.keyboard.press("ControlOrMeta+Alt+3");
  await expect(inbox(page)).toBeVisible();
  await fits(520);
});

test("a question whose options carry screenshots shows them in the detail, beside its answers", async ({
  page,
}) => {
  const fixture = fileURLToPath(
    new URL("../../../docs/design/mocks/needs-you-home/", import.meta.url),
  );
  const files = Object.fromEntries(
    ["a-inbox-dark.png", "b-popover-dark.png", "c-popover-dark.png"].map((name) => [
      `shots/${name}`,
      { mediaType: "image/png", base64: readFileSync(join(fixture, "shots", name), "base64") },
    ]),
  );
  await page.goto("/t/t-flaky");
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  await page.evaluate(async (shots) => {
    const mock = window.gramMock!;
    const seeded = await mock.simulateAsks();
    const base = mock.simulateCheckoutFiles(seeded.orchestratorThreadId, "mocks/needs-you", shots);
    mock.simulateAskUser(seeded.workspaceId, {
      question: "Which needs-you direction should we build?",
      recommended: "C Hybrid",
      options: [
        { label: "A Inbox", description: "", image: `${base}/shots/a-inbox-dark.png` },
        { label: "B Jump", description: "", image: `${base}/shots/b-popover-dark.png` },
        { label: "C Hybrid", description: "", image: `${base}/shots/c-popover-dark.png` },
      ],
    });
  }, files);
  await openInbox(page);
  await show(page, "Which needs-you direction should we build?");
  const visuals = detail(page).getByTestId("option-visual");
  await expect(visuals).toHaveCount(3);
  // A picture each, in the asker's order, the orchestrator's pick starred; its answer is first.
  const hybrid = visuals.and(page.locator('[data-option="C Hybrid"]'));
  await expect(hybrid.getByText("(recommended)")).toHaveCount(1);
  await expect(detail(page).getByTestId("ask-option").first()).toContainText("C Hybrid");
  await expect(hybrid.locator("img")).toBeVisible();
  // A click enlarges it.
  await hybrid.locator("button").first().click();
  await expect(page.getByRole("dialog", { name: /C Hybrid/ })).toBeVisible();
});
