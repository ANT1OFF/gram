import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

import { seedTheme } from "./seed-theme";

test.describe("message timestamp convention", () => {
  test.use({ locale: "en-US", timezoneId: "Europe/Oslo", viewport: { width: 1440, height: 900 } });

  test("user and assistant footers match notification dates and retain full timestamp hints", async ({
    page,
  }, testInfo) => {
    const at = Date.UTC(2026, 9, 11, 14, 35, 12);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await seedTheme(page, { palette: "tokyo-night", mode: "dark", motion: "off" });
    await page.addInitScript(() => {
      sessionStorage.setItem("gram.mock.agents", "claude,codex");
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
      sessionStorage.setItem("gram.mock.agentRuntimes", JSON.stringify({ agents: [] }));
    });
    await page.clock.setFixedTime(new Date(at));
    await page.goto("/t/t-deps");
    await expect(page.getByTestId("transcript")).toBeVisible();
    await page.evaluate((createdAt) => {
      for (const role of ["user", "assistant"] as const) {
        window.gramMock!.simulateMessage("t-deps" as never, {
          id: `timestamp-${role}`,
          role,
          metadata: { createdAt },
          parts: [{ type: "text", text: `Invented ${role} timestamp example.` }],
        });
      }
      window.gramMock!.simulateNotification({
        type: "notify",
        kind: "info",
        title: "Invented timestamp notification",
      });
    }, at);
    await page.getByTestId("notifications-bell").click();
    const notice = page.getByTestId("notification-entry").filter({
      hasText: "Invented timestamp notification",
    });
    const notificationTime = notice.locator("time");
    await expect(notificationTime).toHaveText("Oct 11, 16:35");
    const evidence = [];
    for (const role of ["user", "assistant"]) {
      const message = page.getByTestId(`message-${role}`).filter({
        hasText: `Invented ${role} timestamp example.`,
      });
      await message.hover();
      const time = message.getByTestId("message-sent-at");
      await expect(time).toBeVisible();
      evidence.push({
        role,
        text: await time.textContent(),
        datetime: await time.getAttribute("datetime"),
        title: await time.getAttribute("title"),
      });
      await page.screenshot({ path: testInfo.outputPath(`timestamp-${role}.png`) });
    }
    const evidencePath = testInfo.outputPath("timestamp-render-evidence.json");
    await writeFile(
      evidencePath,
      JSON.stringify({ notification: await notificationTime.textContent(), evidence, errors }),
    );
    await testInfo.attach("timestamp-render-evidence", {
      path: evidencePath,
      contentType: "application/json",
    });
    expect(errors).toEqual([]);
    for (const entry of evidence) {
      expect(entry.text).toBe("Oct 11, 16:35");
      expect(entry.datetime).toBe("2026-10-11T14:35:12.000Z");
      expect(entry.title).toBe("2026-10-11 16:35:12 UTC+02:00");
    }
  });
});

for (const width of [1440, 480]) {
  test(`message icons explain themselves and preserve confirmations at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/t/t-deps");
    const transcript = page.getByTestId("transcript");
    const reply = transcript.getByTestId("message-assistant").first();
    const actions = reply.getByTestId("message-actions");
    await reply.hover();
    await expect(actions.getByRole("button")).toHaveCount(5);
    await expect(actions.getByTestId("message-sent-at")).toBeVisible();
    await expect(actions).not.toContainText("Rewind to here");
    await expect(actions).not.toContainText("Fork from here");
    await expect(actions.getByTestId("turn-copy")).toHaveCount(0);
    const bounds = await actions.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await actions.screenshot({ path: testInfo.outputPath(`actions-${width}.png`) });

    const copy = actions.getByRole("button", { name: "Copy message", exact: true });
    await copy.hover();
    await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toContainText(
      "This message as Markdown",
    );
    await page.mouse.move(0, 0);
    await page.keyboard.press("Tab");
    await copy.focus();
    for (const label of [
      "Copy message",
      "Add to Waiting on you",
      "Rewind to here",
      "Fork from here",
      "More message actions",
    ]) {
      await expect(actions.getByRole("button", { name: label, exact: true })).toBeFocused();
      await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toContainText(label);
      if (label !== "More message actions") await page.keyboard.press("Tab");
    }
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitem", { name: "Copy turn", exact: true })).toBeFocused();
    await expect(page.getByRole("menu")).toContainText("Prompt and replies as Markdown");
    await page.getByRole("menu").screenshot({ path: testInfo.outputPath(`menu-${width}.png`) });
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("message-fork-worktree")).toBeFocused();
    await page.keyboard.press("Enter");
    const dialog = page.getByTestId("fork-dialog");
    await expect(dialog).toContainText("conversation up to this reply, in a new worktree");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(actions.getByTestId("message-more")).toBeFocused();

    await actions.getByTestId("message-rewind").click();
    const confirmation = page.getByTestId("rewind-confirm");
    await expect(confirmation).toContainText("Everything after this reply is removed");
    await confirmation.getByRole("button", { name: "Cancel" }).click();
    await expect(actions.getByTestId("message-rewind")).toBeFocused();
    const prompt = transcript.getByTestId("message-user").first();
    await page.keyboard.press("Tab");
    await prompt.getByTestId("message-edit").focus();
    await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toContainText(
      "Edit from here",
    );
    await page.keyboard.press("Enter");
    await expect(confirmation).toContainText("The composer is filled with it");
    await confirmation.getByRole("button", { name: "Cancel" }).click();
    await expect(prompt.getByTestId("message-edit")).toBeFocused();
    const wait = actions.getByTestId("message-wait");
    await wait.click();
    await expect(wait).toBeDisabled();
    await expect(wait).toHaveAccessibleName("Waiting on you");
    // Added, its line above the actions moves the button from under the clicking pointer, whose
    // hover leave would close the tooltip focus opens; as above, the pointer goes first.
    await page.mouse.move(0, 0);
    await page.keyboard.press("Tab");
    await wait.focus();
    await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toContainText(
      "Already added",
    );
  });
}

test("busy message actions explain why on hover and focus and refuse activation", async ({
  page,
}) => {
  await page.goto("/t/t-deps");
  const reply = page.getByTestId("transcript").getByTestId("message-assistant").first();
  await expect(reply).toBeVisible();
  await page.evaluate(() => {
    window.gramMock!.simulateRequest("t-deps" as never, {
      kind: "approval",
      id: "message-action-approval" as never,
      toolName: "Bash",
      displayName: "Bash",
      input: { command: "pwd" },
      suggestions: [],
    });
  });
  for (const testId of ["message-rewind", "message-fork"]) {
    const action = reply.getByTestId(testId);
    await expect(action).toBeDisabled();
    await action.hover();
    await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toContainText(
      "Wait for the turn to finish",
    );
    await page.mouse.move(0, 0);
    await page.keyboard.press("Tab");
    await action.focus();
    await expect(action).toBeFocused();
    await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toContainText(
      "Wait for the turn to finish",
    );
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    await expect(page.getByTestId("rewind-confirm")).toHaveCount(0);
    await expect(page).toHaveURL(/\/t\/t-deps$/);
  }
  await reply.getByTestId("message-more").click();
  await expect(reply.getByTestId("message-copy")).toBeEnabled();
  // Whole-turn copy remains reserved for a finished turn.
  await expect(page.getByTestId("turn-copy")).toHaveCount(0);
  const worktree = page.getByTestId("message-fork-worktree");
  await expect(worktree).toBeDisabled();
  await expect(worktree).toContainText("Wait for the turn to finish");
  await page.keyboard.press("Escape");
  await expect(reply.getByTestId("message-more")).toBeFocused();
});

test.describe("touch message actions", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test("actions are visible with larger targets and secondary actions open by tap", async ({
    page,
  }, testInfo) => {
    await page.goto("/t/t-deps");
    const actions = page
      .getByTestId("transcript")
      .getByTestId("message-assistant")
      .first()
      .getByTestId("message-actions");
    await expect(actions).toHaveCSS("opacity", "1");
    for (const action of await actions.getByRole("button").all()) {
      const bounds = await action.boundingBox();
      expect(bounds!.width).toBeGreaterThanOrEqual(36);
      expect(bounds!.height).toBeGreaterThanOrEqual(36);
    }
    await actions.getByTestId("message-more").tap();
    await expect(page.getByRole("menuitem", { name: "Copy turn", exact: true })).toBeVisible();
    await expect(page.getByTestId("message-fork-worktree")).toBeVisible();
    const bounds = await page.getByRole("menu").boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: testInfo.outputPath("message-actions-touch.png") });
  });
});
