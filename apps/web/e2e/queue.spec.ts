import { expect, test, type Page } from "@playwright/test";

import type { ThreadId, UserInput } from "@gram/contracts";
import { setLayout } from "./layout";

const STEER = "Steer now: deliver before the turn ends";
const SEND_NOW = "Send now: no turn is running";

const fromOrchestrator = (text: string): UserInput => ({
  text,
  origin: {
    threadId: "t-docs" as ThreadId,
    title: "Orchestrator · api",
    depth: 1,
    role: "orchestrator",
    mode: "queue",
  },
});

/** Opens the scripted thread and holds its turn running, so what is sent now is queued. */
async function openRunning(page: Page) {
  await page.addInitScript(() => {
    window.gramMockHoldGates = true;
  });
  await page.goto("/t/t-flaky");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
}

const queueFromAnotherThread = (page: Page, input: UserInput) =>
  page.evaluate((queued) => window.gramMock!.send("t-flaky" as ThreadId, queued), input);

test("steers one queued message into the running turn and keeps the rest queued", async ({
  page,
}) => {
  await openRunning(page);
  const composer = page.getByLabel("Message", { exact: true });
  for (const text of ["first, for later", "second, needed now"]) {
    await composer.fill(text);
    await composer.press("ControlOrMeta+Enter");
  }
  await queueFromAnotherThread(page, fromOrchestrator("Background: the API is v2."));

  const items = page.getByTestId("queue-item");
  await expect(items).toHaveCount(3);
  // The user's own say nothing of where they came from; another thread's names it and why.
  await expect(items.nth(0).getByTestId("queue-origin")).toHaveCount(0);
  const origin = items.nth(2).getByTestId("queue-origin");
  await expect(origin).toHaveText(/^From\s*Orchestrator · api\s*· queued as context$/);
  await expect(origin.getByRole("link", { name: "Orchestrator · api" })).toHaveAttribute(
    "href",
    "/t/t-docs",
  );

  const steer = items.nth(1).getByRole("button", { name: STEER });
  await steer.hover();
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(STEER);
  await steer.click();

  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("first, for later");
  await expect(items.nth(1)).toContainText("Background: the API is v2.");

  // The held turn takes the steer as soon as it moves on. Nothing holds the turns after it, so the
  // queue's being kept shows in the order they all arrive in, not in a count caught on the way.
  await page.evaluate(() => window.gramMock?.release("flaky-read"));
  const sent = page
    .getByTestId("message-user")
    .filter({ hasText: /^(second, needed now|first, for later|Background: the API is v2\.)/ });
  await expect(sent).toHaveText([
    /^second, needed now/,
    /^first, for later/,
    /^Background: the API is v2\./,
  ]);
  await expect(items).toHaveCount(0);
});

test("a long queued message scrolls inside its card and leaves the composer on screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await openRunning(page);
  const long = `${Array.from({ length: 2000 }, (_, i) => `word${i}`).join(" ")} THE-END`;
  await queueFromAnotherThread(page, fromOrchestrator(long));

  const text = page.getByTestId("queue-text");
  await expect(text).toHaveAttribute("data-more-below", "true");
  await expect(page.getByLabel("Message", { exact: true })).toBeInViewport();
  await expect(page.getByRole("button", { name: STEER })).toBeInViewport();

  await text.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(text).not.toHaveAttribute("data-more-below");
  await expect(text).toHaveAttribute("data-more-above", "true");
  await expect(text.getByText("THE-END")).toBeInViewport();
});

test("in a short grid pane the queue stays a share of the pane, and the composer inside it", async ({
  page,
}) => {
  // Tall enough for the composer and the strips over it in a quarter of the window, and short
  // enough that a queue capped by the window alone (32vh) would push the composer out of the pane.
  await page.setViewportSize({ width: 1200, height: 900 });
  await openRunning(page);
  await setLayout(page, "2×2");
  const pane = page.getByTestId("pane").first();
  await expect(pane).toHaveAttribute("data-thread-id", "t-flaky");
  for (const n of [1, 2, 3]) {
    const text = `${Array.from({ length: 400 }, (_, i) => `m${n}w${i}`).join(" ")}`;
    await queueFromAnotherThread(page, fromOrchestrator(text));
  }
  await expect(pane.getByTestId("queue-item")).toHaveCount(3);

  const box = async (selector: string) => (await pane.getByTestId(selector).boundingBox())!;
  const paneBox = (await pane.boundingBox())!;
  const scroll = await box("queue-scroll");
  expect(scroll.height).toBeLessThanOrEqual(paneBox.height * 0.25 + 1);
  const composer = (await pane.getByLabel("Message", { exact: true }).boundingBox())!;
  expect(composer.y + composer.height).toBeLessThanOrEqual(paneBox.y + paneBox.height);
});

test("a message queued on an idle thread sends from its card", async ({ page }) => {
  await page.goto("/t/t-deps");
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  // What a restart leaves: the queue survived, the turn it waited on didn't.
  await page.evaluate(() =>
    window.gramMock!.simulateQueued("t-deps" as ThreadId, [{ text: "CI passed on #12" }]),
  );
  const items = page.getByTestId("queue-item");
  await expect(items).toHaveCount(1);

  const send = items.first().getByRole("button", { name: SEND_NOW });
  await send.hover();
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(SEND_NOW);
  await send.click();

  await expect(items).toHaveCount(0);
  await expect(
    page.getByTestId("message-user").filter({ hasText: /^CI passed on #12/ }),
  ).toHaveCount(1);
});

test("a message sent to an idle thread goes straight to the feed, never through the queue", async ({
  page,
}) => {
  await page.goto("/t/t-deps");
  const composer = page.getByLabel("Message", { exact: true });
  await expect(composer).toBeVisible();
  // Records any queue card at all, however briefly it shows.
  await page.evaluate(() => {
    const seen = window as unknown as { queueSeen?: boolean };
    seen.queueSeen = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="queue"]') !== null) seen.queueSeen = true;
    }).observe(document.body, { childList: true, subtree: true });
  });
  await composer.fill("Bump the lockfile");
  await composer.press("ControlOrMeta+Enter");

  await expect(
    page.getByTestId("message-user").filter({ hasText: /^Bump the lockfile/ }),
  ).toHaveCount(1);
  await expect(page.getByText("On it: “Bump the lockfile”. (Mock reply.)")).toBeVisible();
  expect(await page.evaluate(() => (window as { queueSeen?: boolean }).queueSeen)).toBe(false);
});
