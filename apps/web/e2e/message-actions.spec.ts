import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

import { openNotifications } from "./open-notifications";
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
    await openNotifications(page);
    const notice = page.getByTestId("notification-entry").filter({
      hasText: "Invented timestamp notification",
    });
    const notificationTime = notice.locator("time");
    // The clock is pinned to the message's own day, so both read as today's time alone, 24-hour
    // even in an AM/PM locale.
    await expect(notificationTime).toHaveText("16:35");
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
      expect(entry.text).toBe("16:35");
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
    // Round 15: Copy and "…" alone; inbox, history and fork glyphs were a strip of bare marks.
    await expect(actions.getByRole("button")).toHaveCount(2);
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
    for (const label of ["Copy message", "More message actions"]) {
      await expect(actions.getByRole("button", { name: label, exact: true })).toBeFocused();
      await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toContainText(label);
      if (label !== "More message actions") await page.keyboard.press("Tab");
    }
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu");
    // Every other action, in words, each with a line on what it does.
    await expect(menu.getByRole("menuitem")).toHaveText([
      /^Copy turnPrompt and replies as Markdown$/,
      /^Add to Waiting on you/,
      /^Rewind to hereRemove the conversation after this reply$/,
      /^Fork from hereStart a new thread with the conversation up to this reply$/,
      /^Fork into worktree…Continue from this reply in a new worktree$/,
    ]);
    await expect(page.getByRole("menuitem", { name: "Copy turn", exact: true })).toBeFocused();
    await menu.screenshot({ path: testInfo.outputPath(`menu-${width}.png`) });
    await page.keyboard.press("End");
    await expect(page.getByTestId("message-fork-worktree")).toBeFocused();
    await page.keyboard.press("Enter");
    const dialog = page.getByTestId("fork-dialog");
    await expect(dialog).toContainText("conversation up to this reply, in a new worktree");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    const more = actions.getByTestId("message-more");
    await expect(more).toBeFocused();

    // Rewind's confirmation opens under the "…" it was chosen from, and hands focus back to it.
    await page.keyboard.press("Enter");
    await page.getByTestId("message-rewind").click();
    const confirmation = page.getByTestId("rewind-confirm");
    await expect(confirmation).toContainText("Everything after this reply is removed");
    const below = (await more.boundingBox())!;
    expect((await confirmation.boundingBox())!.y).toBeGreaterThanOrEqual(below.y + below.height);
    await confirmation.getByRole("button", { name: "Cancel" }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(more).toBeFocused();
    const prompt = transcript.getByTestId("message-user").first();
    const promptMore = prompt.getByTestId("message-more");
    await promptMore.focus();
    await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toContainText(
      "More message actions",
    );
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText([
      /^Add to Waiting on you/,
      /^Edit from hereEdit this message and replace the conversation after it$/,
    ]);
    await page.getByTestId("message-edit").click();
    await expect(confirmation).toContainText("The composer is filled with it");
    await confirmation.getByRole("button", { name: "Cancel" }).click();
    await expect(promptMore).toBeFocused();
    await reply.hover();
    await more.click();
    await page.getByTestId("message-wait").click();
    await reply.hover();
    await more.click();
    const wait = page.getByTestId("message-wait");
    await expect(wait).toBeDisabled();
    await expect(wait).toHaveAccessibleName("Waiting on you");
    await expect(wait).toContainText("Already added");
    await page.keyboard.press("Escape");
    await expect(more).toBeFocused();
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
    await reply.hover();
    await reply.getByTestId("message-more").click();
    const action = page.getByTestId(testId);
    await expect(action).toBeDisabled();
    // The reason in words under the action's name, to sight and to a screen reader.
    await expect(action).toContainText("Wait for the turn to finish");
    await expect(action).toHaveAttribute("aria-description", "Wait for the turn to finish");
    await action.click({ force: true });
    await action.press("Enter");
    await expect(page.getByTestId("rewind-confirm")).toHaveCount(0);
    await expect(page).toHaveURL(/\/t\/t-deps$/);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
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

  test("in the orchestrator's chat they keep their row under the message, shown, not floating", async ({
    page,
  }) => {
    await page.addInitScript(() => sessionStorage.setItem("gram.mock.orchestration", "realistic"));
    await page.goto("/");
    await page.getByTestId("app-shell").waitFor();
    const made = await page.evaluate(async () => {
      const started = await window.gramMock!.startedRealistic();
      if (started === undefined) throw new Error("the mock did not start the realistic scenario");
      return started;
    });
    // In the app's router, as a link goes: no reload, so the mock's world stays.
    await page.evaluate((to) => {
      history.pushState(history.state, "", to);
      dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    }, `/t/${made.orchestratorThreadId}`);
    const transcript = page.locator(`[data-thread-view="${made.orchestratorThreadId}"]`);
    for (const message of [
      transcript.getByTestId("message-assistant").last(),
      transcript.getByTestId("message-user").last(),
    ]) {
      await message.scrollIntoViewIfNeeded();
      const actions = message.getByTestId("message-actions");
      await expect(actions).toHaveAttribute("data-floating", "true");
      await expect(actions).toHaveCSS("opacity", "1");
      await expect(actions).toHaveCSS("position", "static");
      // Under what it acts on, never over it.
      const content = (await message
        .locator('[data-slot="message-content"]')
        .first()
        .boundingBox())!;
      const strip = (await actions.boundingBox())!;
      expect(strip.y).toBeGreaterThanOrEqual(content.y + content.height - 1);
    }
  });
});
