import { expect, test, type Page } from "@playwright/test";

import { installFlickerObserver } from "./flicker-observer";
import { frames } from "./settled";

// The Inbox held open while a lot goes on: workers asking and being answered, their trees moving.
// Watched by the flicker observer Bombadil runs (e2e/flicker-observer.ts), and by what each frame
// of the Inbox shows: a row that is there for a few frames only, or a summary that goes back to
// "Reading its changes…" each time its worker edits, is the flicker a person sees.

const flickers = (page: Page) => page.evaluate(() => window.gramFlicker!);

/** What the flicker observer flagged inside the Inbox; the app behind it is other specs'. */
const inInbox = async (page: Page) =>
  (await flickers(page)).last.filter((offender) => offender.selector.includes("inbox"));

interface Seen {
  /** Every row the list has shown, as `kind thread title`. */
  rows: Set<string>;
  /** Whether a publish summary has said it is reading its changes, on each change. */
  reading: boolean[];
}

/** Records, every frame, each row the Inbox lists; and on each change, whether a summary reads. */
const watchInbox = (page: Page) =>
  page.evaluate(() => {
    const seen: Seen = { rows: new Set(), reading: [] };
    (window as unknown as { inboxSeen: Seen }).inboxSeen = seen;
    const look = () => {
      for (const row of document.querySelectorAll('[data-testid="inbox-item"]'))
        seen.rows.add(
          [
            row.getAttribute("data-kind"),
            row.getAttribute("data-thread-id"),
            row.querySelector('[data-testid="inbox-item-title"]')?.textContent,
          ].join(" "),
        );
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
    new MutationObserver(() => {
      const summaries = [...document.querySelectorAll('[data-testid="inbox-publish-summary"]')];
      seen.reading.push(summaries.some((p) => (p.textContent ?? "").includes("Reading")));
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });

const seenIn = (page: Page) =>
  page.evaluate(() => {
    const seen = (window as unknown as { inboxSeen: Seen }).inboxSeen;
    return { rows: [...seen.rows], reading: seen.reading };
  });

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(installFlickerObserver, {});
  await page.goto("/t/t-flaky");
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  await page.evaluate(async () => {
    await window.gramMock!.simulateFailures();
  });
  await page.keyboard.press("ControlOrMeta+Shift+KeyI");
  await expect(page.getByTestId("inbox")).toBeVisible();
  await frames(page, 10);
});

test("workers asking and answered as they carry on add no row for a frame", async ({ page }) => {
  // Workers at work, none asking.
  const workers = await page.evaluate(() =>
    window
      .gramMock!.world.threads()
      .filter((s) => s.status === "running" || s.status === "idle")
      .filter((s) => s.pendingRequests.length === 0)
      .map((s) => s.thread.id)
      .slice(0, 6),
  );
  expect(workers.length).toBeGreaterThan(2);
  await watchInbox(page);
  // Each asks, and is answered, as the server tells it: the request, then the status it sets; the
  // request resolved, then the status the turn goes on in, which may come a frame or more later.
  await page.evaluate(async (ids) => {
    const { world } = window.gramMock!;
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    for (let round = 0; round < 4; round++) {
      const requestId = (id: string) => `r-busy-${round}-${id}`;
      for (const threadId of ids) {
        world.emit({
          type: "thread.request",
          threadId,
          request: {
            kind: "approval",
            id: requestId(threadId),
            toolName: "Bash",
            displayName: "Bash",
            input: { command: `npm test -- --shard ${round}` },
            suggestions: [],
          },
        } as never);
        world.emit({ type: "thread.status", threadId, status: "needsApproval" } as never);
      }
      for (let i = 0; i < 3; i++) await frame();
      for (const threadId of ids)
        world.emit({
          type: "thread.requestResolved",
          threadId,
          requestId: requestId(threadId),
        } as never);
      for (let i = 0; i < 3; i++) await frame();
      for (const threadId of ids)
        world.emit({ type: "thread.status", threadId, status: "running" } as never);
      for (let i = 0; i < 3; i++) await frame();
    }
  }, workers);
  await frames(page, 10);
  const { rows } = await seenIn(page);
  // Their approvals were listed while they asked; nothing else of theirs ever was.
  const theirs = rows.filter((row) => workers.some((id) => row.includes(` ${id} `)));
  expect(theirs.filter((row) => !row.startsWith("approval "))).toEqual([]);
  expect(theirs.length).toBeGreaterThan(0);
  expect(await inInbox(page)).toEqual([]);
});

test("an approval's publish summary stays on screen while its worker edits", async ({ page }) => {
  await page.getByTestId("inbox-item").filter({ hasText: "Allow git push -u origin" }).click();
  const summaries = page.getByTestId("inbox-publish-summary");
  await expect(summaries.first()).toBeVisible();
  for (const summary of await summaries.all()) await expect(summary).toContainText("changed");
  await frames(page, 5);
  await watchInbox(page);
  // The workers edit: each tree's stamp moves, and each branch's diff is read again.
  for (const token of ["edit-1", "edit-2", "edit-3"]) {
    await page.evaluate((changesToken) => {
      const { world } = window.gramMock!;
      for (const summary of world.threads()) {
        const asks = summary.pendingRequests.some((request) => request.id.startsWith("r-push"));
        if (asks && summary.git !== undefined)
          world.publishGit(summary.thread.id, { ...summary.git, changesToken });
      }
    }, token);
    await frames(page, 10);
  }
  for (const summary of await summaries.all()) await expect(summary).toContainText("changed");
  const { reading } = await seenIn(page);
  expect(reading.length).toBeGreaterThan(0);
  expect(reading.filter(Boolean)).toEqual([]);
  expect(await inInbox(page)).toEqual([]);
});
