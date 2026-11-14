import { expect, test, type Page } from "@playwright/test";

import { openPanelTab } from "./panel-tab";

// The Preview tab of a browser tab on a server that runs a browser for its agents, over the mock's
// staged page (`simulateServerPage`). The real browser host is `e2e-real/server-browser.spec.ts`.

const THREAD = "t-deps";

const open = async (page: Page, scene: object) => {
  await page.addInitScript(() => sessionStorage.setItem("gram.mock.serverBrowser", "1"));
  await page.goto(`/t/${THREAD}`);
  await page.waitForFunction(() => window.gramMock !== undefined);
  await page.evaluate(
    ([threadId, staged]) => window.gramMock!.simulateServerPage(threadId as never, staged as never),
    [THREAD, scene] as const,
  );
  await openPanelTab(page.getByTestId("right-panel"), "Preview");
  return page.getByTestId("server-preview");
};

test("the agent's page says who drives, and a click in it makes it yours until Hand back", async ({
  page,
}) => {
  const preview = await open(page, {
    page: { driver: "agent", action: { summary: "Opens the Filters menu", at: Date.now() } },
  });
  await expect(preview).toHaveAttribute("data-state", "agent");
  await expect(preview.getByTestId("preview-address")).toHaveValue("localhost:5173/invoices");
  const status = preview.getByTestId("server-preview-status");
  await expect(status).toContainText("Agent driving");
  await expect(status).toContainText("Opens the Filters menu");
  await expect(status).toContainText("Click or type in the page to take over");
  await expect(preview.getByRole("button", { name: "Hand back" })).toHaveCount(0);

  await preview.getByTestId("server-preview-frame").click();
  await expect(preview).toHaveAttribute("data-state", "yours");
  await expect(status).toContainText("You're driving");
  await expect(status).toContainText("Agent resumes after 20 s idle");
  // The whole address is there to read and copy once the field has the focus.
  await preview.getByTestId("preview-address").focus();
  await expect(preview.getByTestId("preview-address")).toHaveValue(
    "http://localhost:5173/invoices",
  );

  await preview.getByRole("button", { name: "Hand back" }).click();
  await expect(preview).toHaveAttribute("data-state", "agent");
  expect(await page.evaluate(() => window.gramMock!.serverPageControls.at(-1)?.op)).toBe(
    "handBack",
  );
});

test("with no page the tab says why: none yet, starting, or the browser's own error", async ({
  page,
}) => {
  const preview = await open(page, { page: null });
  await expect(preview.getByTestId("server-preview-empty")).toContainText("No page yet");
  await expect(preview.getByTestId("server-preview-empty")).toContainText("on the server only");

  const stage = (scene: object) =>
    page.evaluate(
      ([threadId, staged]) =>
        window.gramMock!.simulateServerPage(threadId as never, staged as never),
      [THREAD, scene] as const,
    );
  await stage({ page: null, status: { kind: "starting" } });
  await expect(preview.getByTestId("server-preview-starting")).toContainText(
    "Starting the browser on the server",
  );
  await stage({ page: null, status: { kind: "failed", message: "Chromium exited (code 1)." } });
  const failed = preview.getByTestId("server-preview-failed");
  await expect(failed).toHaveAttribute("role", "alert");
  await expect(failed).toContainText("Chromium exited (code 1).");
  await expect(failed).toContainText("next browser command tries again");
});

test("a lost connection keeps the page and says it is reconnecting", async ({ page }) => {
  const preview = await open(page, { page: { driver: "agent" }, dropped: true });
  await expect(preview).toHaveAttribute("data-state", "reconnecting");
  await expect(preview.getByTestId("server-preview-reconnecting")).toBeVisible();
  await expect(preview.getByTestId("server-preview-frame")).toBeVisible();
});
