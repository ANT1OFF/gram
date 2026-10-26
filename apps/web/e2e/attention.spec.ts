import { expect, test, type Page } from "@playwright/test";

import { seedTheme } from "./seed-theme";
import { setLayout } from "./layout";
import { threadRow } from "./thread-row";

/** Records brief passes before Playwright's next assertion, including their actual browser keyframes. */
async function watchSheen(page: Page) {
  await page.locator('[data-surface="composer"]').evaluate((surface: HTMLElement) => {
    surface.dataset["sheenPasses"] = "0";
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement) || node.dataset["testid"] !== "turn-complete-sheen")
            continue;
          surface.dataset["sheenPasses"] = String(Number(surface.dataset["sheenPasses"]) + 1);
          const animation = node.getAnimations({ subtree: true })[0];
          const effect = animation?.effect as KeyframeEffect | undefined;
          surface.dataset["sheenFrames"] = JSON.stringify(effect?.getKeyframes());
          surface.dataset["sheenIterations"] = String(effect?.getTiming().iterations);
        }
    }).observe(surface, { childList: true });
  });
}

for (const motion of ["system", "reduced", "off"] as const) {
  test(`a completed turn plays one border sheen with motion ${motion}`, async ({ page }) => {
    await seedTheme(page, { palette: "tokyo-night", mode: "dark", motion });
    await page.goto("/t/t-deps");
    const composer = page.getByLabel("Message", { exact: true });
    await expect(composer).toBeVisible();
    await watchSheen(page);
    const surface = page.locator('[data-surface="composer"]');
    await expect(surface).toHaveAttribute("data-sheen-passes", "0");
    await composer.fill("A completed turn for the border");
    await composer.press("ControlOrMeta+Enter");
    await expect(page.getByTestId("message-assistant").last()).toContainText(
      "A completed turn for the border",
    );
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeHidden();
    await expect(surface).toHaveAttribute("data-sheen-passes", motion === "off" ? "0" : "1");
    if (motion !== "off") {
      await expect(surface).toHaveAttribute("data-sheen-iterations", "1");
      const frames = await surface.getAttribute("data-sheen-frames");
      if (motion === "system") expect(frames).toContain("translateX");
      else expect(frames).not.toContain("transform");
    }
    await expect(page.getByTestId("turn-complete-sheen")).toHaveCount(0);
    await composer.fill("Another draft");
    await expect(surface).toHaveAttribute("data-sheen-passes", motion === "off" ? "0" : "1");
  });
}

test("answering an idle thread's independent approval returns it to idle without a sheen", async ({
  page,
}) => {
  await seedTheme(page, { palette: "tokyo-night", mode: "dark", motion: "system" });
  await page.goto("/t/t-deps");
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  await watchSheen(page);
  await page.evaluate(() => {
    window.gramMock?.simulateRequest("t-deps" as never, {
      kind: "approval",
      id: "idle-approval" as never,
      toolName: "Bash",
      displayName: "Bash",
      input: { command: "pwd" },
      suggestions: [],
    });
  });
  await page.getByTestId("approval-allow").click();
  await expect(page.getByTestId("approval-card")).toHaveCount(0);
  await expect(page.getByTestId("pane-status")).toHaveText("Idle");
  await expect(page.locator('[data-surface="composer"]')).toHaveAttribute("data-sheen-passes", "0");
});

test("a turn completed in a maximized-away pane skips its sheen when restored", async ({
  page,
}) => {
  await seedTheme(page, { palette: "tokyo-night", mode: "dark", motion: "system" });
  await page.goto("/t/t-deps");
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  await watchSheen(page);
  await setLayout(page, "2×2");
  const panes = page.getByTestId("pane");
  await threadRow(page, "t-release").dragTo(panes.nth(1));
  await page.keyboard.press("ControlOrMeta+Shift+Enter");
  await expect(panes.nth(0)).toBeHidden();
  await page.evaluate(() =>
    window.gramMock?.send("t-deps" as never, { text: "Finished while hidden" }),
  );
  await page.evaluate(async () => {
    const api = window.gramMock;
    if (!api) throw new Error("Mock API is not ready");
    const controller = new AbortController();
    try {
      for await (const event of api.events(controller.signal)) {
        if (
          event.type === "threads.snapshot" &&
          event.threads.some((thread) => thread.thread.id === "t-deps" && thread.status === "idle")
        )
          return;
        if (
          event.type === "thread.status" &&
          event.threadId === "t-deps" &&
          event.status === "idle"
        )
          return;
      }
    } finally {
      controller.abort();
    }
  });
  // The mock's idle reaches the app a little later; restored before it has, the pane would see
  // its turn complete in view.
  await expect(panes.nth(0).getByTestId("pane-status")).toHaveText("Idle");
  await expect(panes.nth(0).locator('[data-surface="composer"]')).toHaveAttribute(
    "data-sheen-passes",
    "0",
  );
  await page.keyboard.press("ControlOrMeta+Shift+Enter");
  await expect(panes.nth(0)).toBeVisible();
  await expect(panes.nth(0).getByTestId("message-assistant").last()).toContainText(
    "Finished while hidden",
  );
  await expect(panes.nth(0).locator('[data-surface="composer"]')).toHaveAttribute(
    "data-sheen-passes",
    "0",
  );
  await expect(panes.nth(0).getByTestId("turn-complete-sheen")).toHaveCount(0);
});

test("a red build lifts an idle thread into Needs you and toasts", async ({ page }) => {
  await page.goto("/t/t-question");
  const row = threadRow(page, "t-flaky");
  await expect(row).toBeVisible();
  // What the user has seen of each thread's PR attention, as settings keep it.
  const seen = async () =>
    (await page.evaluate(
      async () => (await window.gramMock!.getSettings()).attention?.acknowledged,
    )) ?? [];

  // Green first, so the flip to red is a transition.
  await page.evaluate(() => window.gramMock?.simulateChecks("t-flaky" as never, "passing"));
  await expect(page.getByTestId("toast").filter({ hasText: "CI passed on #412" })).toBeVisible();

  await page.evaluate(() => window.gramMock?.simulateChecks("t-flaky" as never, "failing"));
  await expect(page.getByTestId("toast").filter({ hasText: "CI failed on #412" })).toBeVisible();
  expect(await seen()).not.toContainEqual(expect.stringMatching(/^t-flaky /));

  // Opening the thread counts its red build as seen, kept so a reload doesn't raise it again.
  await row.click();
  await expect.poll(seen).toContainEqual(expect.stringMatching(/^t-flaky ci:412:/));
});
