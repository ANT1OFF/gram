import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { slowdown } from "./slowdown";
import { parkSeedAsks } from "./seed-asks";
import { threadRow } from "./thread-row";

// Needs you's popover and panel (docs/design/mocks/needs-you-home, C Hybrid): every workspace's
// asks, failures and waits in one list, each a click from its thread at the turn that asked, with
// quick answers, the ⌘⇧U / ⌘⇧Y stepper, See all, Later and Dismiss. Mock state lives in memory, so
// every step after the seed navigates inside the app; nothing reloads.

/** The stack's undo window (`UNDO_MS`) and then some, for an answer to have gone out. */
const SENT_MS = 8_000 * slowdown;

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
const start = async (page: Page): Promise<Seeded> => {
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
const popover = (page: Page) => page.getByTestId("needs-you-popover");
const panel = (page: Page) => page.getByTestId("needs-you-panel");
const row = (scope: ReturnType<Page["getByTestId"]>, text: string | RegExp) =>
  scope.getByTestId("needs-you-item").filter({ hasText: text });

const openPopover = async (page: Page) => {
  await pill(page).click();
  await expect(popover(page)).toBeVisible();
};

const seeAll = async (page: Page) => {
  await openPopover(page);
  await popover(page).getByTestId("needs-you-see-all").click();
  await expect(popover(page)).toBeHidden();
  await expect(panel(page)).toBeVisible();
};

test("the pill opens every workspace's items, and a row opens its thread at the card that asks", async ({
  page,
}) => {
  const made = await start(page);
  // The scenario's eight (six asks, the stopped worker and the red build) and the three the threads
  // outside any workspace ask (t-flaky's push, t-question's question, t-plan's plan). Those three
  // are up first, so the count is read once the scenario's have arrived too.
  const count = 11;
  await expect(pill(page)).toHaveAttribute("data-count", String(count));
  await openPopover(page);
  // Grouped by workspace: the board's and billing's.
  await expect(popover(page).getByRole("region", { name: "billing" })).toBeVisible();
  await expect(popover(page).getByTestId("needs-you-see-all")).toHaveText(`See all ${count}`);
  // Each row says its kind, behind a hint, and its thread.
  const merge = row(popover(page), "gh pr merge 91 --squash");
  await expect(merge).toContainText("Export invoices as CSV");
  await expect(merge.getByRole("img", { name: "Approval" })).toBeVisible();

  await merge.getByTestId("needs-you-open").click();
  await expect(popover(page)).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/t/${made.other.asking}$`));
  const card = page.locator(`[data-request-id="r-merge-${made.other.asking}"]`);
  await expect(card).toBeInViewport();
  await expect(card).toHaveAttribute("data-needs-you-flash", "true");
  await expect(card).toBeFocused();
});

test("quick answers: an option, Allow and Deny go out through the stack's path, with Undo", async ({
  page,
}) => {
  const made = await start(page);
  await seeAll(page);
  const question = row(panel(page), "Keep both, or uv only?");
  await question
    .getByTestId("needs-you-answer")
    .and(page.locator('[data-option="uv only"]'))
    .click();
  await expect(question).toHaveCount(0);
  await expect(page.getByTestId("needs-you-undo-line")).toContainText("uv only");

  // Undo brings it back before it is sent.
  await page.getByTestId("needs-you-undo").click();
  await expect(question).toHaveCount(1);

  const merge = row(panel(page), "gh pr merge 91 --squash");
  await merge.getByTestId("needs-you-answer").and(page.locator('[data-option="Allow"]')).click();
  await expect(merge).toHaveCount(0);
  const push = row(panel(page), "git push -u origin feat/mail-trigger");
  await push.getByTestId("needs-you-answer").and(page.locator('[data-option="Deny"]')).click();
  await expect(push).toHaveCount(0);

  await expect
    .poll(() => sent(page), { timeout: SENT_MS })
    .toEqual(
      expect.arrayContaining([
        `r-merge-${made.other.asking} allow`,
        expect.stringMatching(/^r-push-again-.* deny$/),
      ]),
    );
  expect((await sent(page)).some((line) => line.startsWith(`r-question-${made.choosing}`))).toBe(
    false,
  );
});

test("a wait's Done resolves it, and a jump lands on the message that added it", async ({
  page,
}) => {
  await start(page);
  await page.evaluate(() =>
    window.gramMock!.simulateWaitOnUser("t-deps" as never, {
      kind: "review",
      title: "Review the mock: needs-you-home v1",
    }),
  );
  await openPopover(page);
  const review = row(popover(page), "Review the mock: needs-you-home v1");
  await expect(review.getByRole("img", { name: "Review" })).toBeVisible();
  await review.getByTestId("needs-you-open").click();
  await expect(page).toHaveURL(/\/t\/t-deps$/);
  await expect(page.getByTestId("wait-chip")).toBeInViewport();

  const before = Number(await pill(page).getAttribute("data-count"));
  await openPopover(page);
  await row(popover(page), "Review the mock").getByTestId("needs-you-done").click();
  await expect(pill(page)).toHaveAttribute("data-count", String(before - 1));
  await expect(row(popover(page), "Review the mock")).toHaveCount(0);
});

test("⌘⇧U and ⌘⇧Y step through what needs you, each at its thread", async ({ page }) => {
  await start(page);
  await seeAll(page);
  const threads = await panel(page)
    .getByTestId("needs-you-item")
    .evaluateAll((rows) => rows.map((each) => each.getAttribute("data-thread-id")));
  expect(threads.length).toBeGreaterThan(2);
  const at = (index: number) => new RegExp(`/t/${threads[index]}$`);

  await page.keyboard.press("ControlOrMeta+Shift+U");
  await expect(page).toHaveURL(at(0));
  const current = panel(page).locator('[data-testid="needs-you-item"][data-current="true"]');
  await expect(current).toHaveAttribute("data-thread-id", threads[0]!);
  await page.keyboard.press("ControlOrMeta+Shift+U");
  await expect(page).toHaveURL(at(1));
  await page.keyboard.press("ControlOrMeta+Shift+Y");
  await expect(page).toHaveURL(at(0));
  // From the first, back wraps to the last.
  await page.keyboard.press("ControlOrMeta+Shift+Y");
  await expect(page).toHaveURL(at(threads.length - 1));
  // The panel stays open through every step.
  await expect(panel(page)).toBeVisible();
});

test("See all: the panel filters by kind, puts an item away for Later, and dismisses a failure", async ({
  page,
}) => {
  const made = await start(page);
  await seeAll(page);
  const items = panel(page).getByTestId("needs-you-item");
  const all = await items.count();

  // Failing only: the stopped worker and the red build.
  await panel(page).locator('[data-testid="needs-you-filter"][data-filter="failing"]').click();
  await expect(items).toHaveCount(2);
  await expect(items.and(page.locator(`[data-thread-id="${made.failing}"]`))).toHaveCount(1);
  await panel(page).locator('[data-testid="needs-you-filter"][data-filter="all"]').click();
  await expect(items).toHaveCount(all);

  // Later: away from the list and the count, in the Later list until it wakes or is brought back.
  const before = Number(await pill(page).getAttribute("data-count"));
  const merge = row(panel(page), "gh pr merge 91 --squash");
  await merge.hover();
  await merge.getByTestId("needs-you-later").click();
  await expect(merge).toHaveCount(0);
  await expect(pill(page)).toHaveAttribute("data-count", String(before - 1));
  await panel(page).getByTestId("needs-you-show-later").click();
  const later = panel(page).getByTestId("needs-you-later-item");
  await expect(later).toHaveCount(1);
  // A wake on another day than today carries its weekday ("back at Sun 00:24").
  await expect(later).toContainText(/back at (?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) )?\d{2}:\d{2}/);
  await later.getByTestId("needs-you-wake").click();
  await expect(later).toHaveCount(0);
  await panel(page).getByTestId("needs-you-show-later").click();
  await expect(merge).toHaveCount(1);
  await expect(pill(page)).toHaveAttribute("data-count", String(before));

  // Dismiss holds a failure until it fails again, behind Undo; the Board's strip loses it too.
  const red = items.and(page.locator(`[data-thread-id="${made.failing}"][data-kind="failure"]`));
  await red.hover();
  await red.getByTestId("needs-you-dismiss").click();
  await expect(red).toHaveCount(0);
  await expect(page.getByTestId("needs-you-undo-line")).toContainText("Dismissed");
  await expect(pill(page)).toHaveAttribute("data-count", String(before - 1));
  // An approval offers no Dismiss: it is answered, or put away.
  await merge.hover();
  await expect(merge.getByTestId("needs-you-dismiss")).toHaveCount(0);
});

test("with nothing waiting, the popover and the panel say so", async ({ page }) => {
  await page.goto("/t/t-deps");
  await expect(threadRow(page, "t-deps")).toBeVisible();
  // The seed's threads outside any workspace that ask, a question and a plan, count until parked.
  await expect(pill(page)).toHaveAttribute("data-count", "2");
  await parkSeedAsks(page);
  await expect(pill(page)).toHaveText("Nothing needs you");
  await openPopover(page);
  await expect(popover(page).getByTestId("needs-you-empty")).toHaveText("Nothing needs you");
  await expect(popover(page).getByTestId("needs-you-see-all")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.evaluate(() =>
    window.gramMock!.simulateWaitOnUser("t-deps" as never, {
      kind: "action",
      title: "Rotate the deploy key",
    }),
  );
  await openPopover(page);
  await row(popover(page), "Rotate the deploy key").getByTestId("needs-you-done").click();
  await expect(popover(page).getByTestId("needs-you-empty")).toBeVisible();
});

test("a worker's question opens at its card in the worker's thread", async ({ page }) => {
  await page.goto("/t/t-flaky");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  const made = await page.evaluate(() => window.gramMock!.simulateWorkerQuestions());
  await openPopover(page);
  const asked = popover(page)
    .getByTestId("needs-you-item")
    .filter({ has: page.getByRole("img", { name: "Worker question" }) })
    .first();
  await expect(asked).toBeVisible();
  const threadId = await asked.getAttribute("data-thread-id");
  await asked.getByTestId("needs-you-open").click();
  await expect(page).toHaveURL(new RegExp(`/t/${threadId}$`));
  const card = page
    .getByTestId("worker-question-card")
    .and(page.locator('[data-stage="forwarded"]'));
  await expect(card.first()).toBeInViewport();
  expect(made.workspaceId).toBeTruthy();
});

test("narrow: the rail's pill opens a popover that fits, and with no pill ⌘⌥3 opens the panel", async ({
  page,
}) => {
  // Below the open overview's width, the compact rail carries the pill.
  await page.setViewportSize({ width: 1000, height: 800 });
  await start(page);
  const railPill = page.getByTestId("overview-rail-needs-you");
  await railPill.click();
  await expect(popover(page)).toBeVisible();
  const box = (await popover(page).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1000);
  await expect(popover(page).getByTestId("needs-you-item")).toHaveCount(6);
  await page.keyboard.press("Escape");
  await expect(popover(page)).toBeHidden();

  // Narrower, no pill is on screen: ⌘⌥3 opens the whole list as the panel, rows within it.
  await page.setViewportSize({ width: 520, height: 800 });
  await expect(railPill).toBeHidden();
  await page.keyboard.press("ControlOrMeta+Alt+3");
  await expect(panel(page)).toBeVisible();
  const edge = (await panel(page).boundingBox())!;
  for (const each of await panel(page).getByTestId("needs-you-item").all()) {
    const rowBox = (await each.boundingBox())!;
    expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(edge.x + edge.width);
  }
});

test("a question whose options carry screenshots shows them on its row, numbered as its answers", async ({
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
  await seeAll(page);
  const question = row(panel(page), "Which needs-you direction should we build?");
  const thumbs = question.getByTestId("needs-you-thumb");
  await expect(thumbs).toHaveCount(3);
  // The orchestrator's pick first, numbered as the stack numbers it, a picture each.
  await expect(thumbs.first()).toHaveAttribute("data-option", "C Hybrid");
  await expect(thumbs.first()).toContainText("1");
  await expect(
    question.locator('[data-testid="needs-you-answer"][data-option="C Hybrid"]'),
  ).toHaveText("1");
  await expect(thumbs.first().locator("img")).toBeVisible();
  // A click enlarges it, as the stack's gallery does.
  await thumbs.first().locator("button").first().click();
  await expect(page.getByRole("dialog", { name: /C Hybrid/ })).toBeVisible();
});
