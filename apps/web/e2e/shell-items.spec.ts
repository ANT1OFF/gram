import { expect, test } from "@playwright/test";
import { threadRow } from "./thread-row";

const MOCK_SESSION_EXPIRED_KEY = "gram.mock.sessionExpired";

test("watches reviews and babysits with a round budget from the PR panel", async ({ page }) => {
  // Wide enough that the one bar keeps the PR badge among its chips; narrower, it folds away.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/t/t-flaky");
  // The PR strip's number opens the PR panel.
  await page.getByTestId("pr-row").getByTestId("pr-row-number").click();
  const panel = page.getByTestId("right-panel");

  const watch = panel.getByRole("switch", { name: "Watch reviews" });
  await expect(watch).toHaveAttribute("aria-checked", "false");
  await watch.click();
  await expect(watch).toHaveAttribute("aria-checked", "true");
  await watch.click();
  await expect(watch).toHaveAttribute("aria-checked", "false");

  await panel.getByRole("spinbutton", { name: "Max babysit rounds" }).fill("3");
  await panel.getByRole("switch", { name: "Babysit this PR" }).click();
  await expect(panel.getByTestId("babysit-status")).toHaveText(/^Watching · round \d of 3$/);
  await expect(watch).toHaveAttribute("aria-checked", "true");
  await expect(watch).toBeDisabled();
});

test("a rejected session shows the session-expired screen", async ({ page }) => {
  await page.addInitScript((key) => sessionStorage.setItem(key, "1"), MOCK_SESSION_EXPIRED_KEY);
  await page.goto("/");
  const screen = page.getByTestId("session-expired");
  await expect(screen).toContainText("Session expired");
  await expect(screen).toContainText("Reopen Gram");
});

test("the palette opens claude.ai/code as a plain page", async ({ page }) => {
  await page.goto("/t/t-flaky");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByTestId("command-palette");
  await palette.getByRole("combobox").fill(">claude.ai");
  await palette.getByText("Open claude.ai/code", { exact: true }).click();
  await expect(palette).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => window.gramMock?.opened))
    .toEqual(["https://claude.ai/code"]);
});

test("Agents saves the idle timeout", async ({ page }) => {
  await page.goto("/settings/agents");
  const agents = page.getByTestId("agent-settings");
  const idle = agents.getByLabel("Close idle sessions after", { exact: true });
  await idle.fill("45");
  await idle.press("Enter");
  await page.reload();
  await expect(
    page.getByTestId("agent-settings").getByLabel("Close idle sessions after", { exact: true }),
  ).toHaveValue("45");
});
