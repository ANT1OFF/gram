import { expect, test } from "@playwright/test";
import type { ThreadSummary } from "@gram/contracts";

import { seedTheme } from "./seed-theme";

declare global {
  interface Window {
    gramFeedSnapshot?: Pick<ThreadSummary, "status" | "activity">;
    gramFeedSnapshots?: number;
  }
}

test("reconnect snapshots replace old activity while subsequent live events still win", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await seedTheme(page, { palette: "neutral-dark", mode: "dark", motion: "off" });
  await page.addInitScript(() => {
    sessionStorage.setItem("gram.mock.agents", "");
    sessionStorage.setItem("gram.mock.agentRuntimes", JSON.stringify({ agents: [] }));
    sessionStorage.setItem(
      "gram.mock.launchChecks",
      JSON.stringify({
        tools: [],
        claudeSignIn: "notSignedIn",
        codexSignIn: "notSignedIn",
        ghSignedIn: false,
        agentsInUse: [],
      }),
    );
    // The mock's status helper does not retain activity in its summaries. Supply the same
    // current activity that ThreadRuntimes.summary puts in the reconnect snapshot, while
    // preserving the real resubscribing transport and useServerEvents/store/UI consumers.
    Object.defineProperty(window, "gramMock", {
      configurable: true,
      set(mock: NonNullable<typeof window.gramMock>) {
        const events = mock.events.bind(mock);
        mock.events = async function* (...args) {
          for await (const event of events(...args)) {
            if (event.type === "threads.snapshot") {
              window.gramFeedSnapshots = (window.gramFeedSnapshots ?? 0) + 1;
              const current = window.gramFeedSnapshot;
              yield {
                ...event,
                threads: event.threads.map((summary) => {
                  if (summary.thread.id !== "t-deps" || current === undefined) return summary;
                  const { activity: _previous, ...rest } = summary;
                  return { ...rest, ...current };
                }),
              };
            } else yield event;
          }
        };
        Object.defineProperty(window, "gramMock", { configurable: true, value: mock });
      },
    });
  });
  await page.goto("/t/t-deps");
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  const status = page.getByTestId("pane-status");
  const icon = page.getByTestId("pane-header").getByTestId("status-icon");
  const hint = page.locator('[data-slot="tooltip-content"]').last();
  const reconnect = async (current: Pick<ThreadSummary, "status" | "activity">) => {
    const previous = await page.evaluate((snapshot) => {
      window.gramFeedSnapshot = snapshot;
      const count = window.gramFeedSnapshots ?? 0;
      window.gramMock!.simulateDisconnect();
      return count;
    }, current);
    await expect
      .poll(() => page.evaluate(() => window.gramFeedSnapshots ?? 0))
      .toBeGreaterThan(previous);
  };
  const showHint = async () => {
    await page.mouse.move(0, 0);
    await status.hover();
    await expect(hint).toBeVisible();
  };

  await page.evaluate(() =>
    window.gramMock!.simulateStatus("t-deps" as never, "running", "Reading a.ts"),
  );
  await showHint();
  await expect(hint).toHaveText("Working: Reading a.ts");

  await reconnect({ status: "running", activity: "Running tests after reconnect" });
  await showHint();
  const phase = process.env["GRAM_FEED_PHASE"] ?? "after";
  const capture = info.outputPath(`activity-reconnect.${phase}.png`);
  await page.screenshot({ path: capture });
  await info.attach(`Activity reconnect — ${phase}`, { path: capture, contentType: "image/png" });
  await info.attach("Reconnect interaction receipt", {
    body: JSON.stringify({
      action: "simulateDisconnect, receive a fresh snapshot, hover the header status",
      snapshots: await page.evaluate(() => window.gramFeedSnapshots),
      expected: "Working: Running tests after reconnect",
      actual: await hint.textContent(),
    }),
    contentType: "application/json",
  });
  // Identical oracle before and after: the fresh snapshot must replace the old live line.
  await expect(hint).toHaveText("Working: Running tests after reconnect");

  await page.evaluate(() =>
    window.gramMock!.simulateStatus("t-deps" as never, "idle", "Subagent: checking output"),
  );
  await expect(icon).toHaveAttribute("data-working", "true");
  await reconnect({ status: "idle" });
  await expect(icon).toHaveAttribute("data-working", "false");
  await showHint();
  await expect(hint).toHaveText("Idle");

  // An explicit empty live line overrides a snapshot only until the next snapshot arrives.
  await page.evaluate(() => window.gramMock!.simulateStatus("t-deps" as never, "idle"));
  await reconnect({ status: "idle", activity: "Subagent: resumed checks" });
  await expect(icon).toHaveAttribute("data-working", "true");
  await showHint();
  await expect(hint).toHaveText("Working: Subagent: resumed checks");
  await page.evaluate(() => window.gramMock!.simulateStatus("t-deps" as never, "idle"));
  await expect(icon).toHaveAttribute("data-working", "false");
  await showHint();
  await expect(hint).toHaveText("Idle");
  expect(errors).toEqual([]);
});
