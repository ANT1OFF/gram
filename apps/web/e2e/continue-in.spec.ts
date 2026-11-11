import { expect, test, type Page } from "@playwright/test";

import { openThreadMenu } from "./more-menu";

// "Continue in Codex…" on a plain thread: the other agent's models as a group in the choices chip,
// greyed with the server's words when the thread can't move; the thread menu's item; the confirm
// sheet in normal and limit mode; and the divider after the switch with what Codex was given.
// Synthetic mock state only: both CLIs found and signed in, explicitly.

const bothAgents = (page: Page, launchChecks: Record<string, unknown> = {}) =>
  page.addInitScript((checks) => {
    sessionStorage.setItem("gram.mock.agents", "claude,codex");
    sessionStorage.setItem(
      "gram.mock.launchChecks",
      JSON.stringify({
        claudeSignIn: "signedIn",
        codexSignIn: "signedIn",
        ghSignedIn: false,
        ...checks,
      }),
    );
    sessionStorage.setItem(
      "gram.mock.settings",
      JSON.stringify({ onboarding: { welcomeSeen: true } }),
    );
  }, launchChecks);

const openChoices = async (page: Page) => {
  await page.getByTestId("composer-choices").click();
  const popup = page.getByTestId("composer-choices-popup");
  await expect(popup).toBeVisible();
  return popup;
};

test("the chip's Codex group opens the sheet and changes nothing on the pick", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await bothAgents(page);
  await page.goto("/t/t-deps");
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();

  const popup = await openChoices(page);
  // Two groups, each headed by its mark alone; the other agent's models end in "…".
  await expect(popup.getByTestId("model-group-mark")).toHaveCount(2);
  await expect(popup.getByTestId("model-group-mark").last()).toHaveAttribute(
    "aria-label",
    "Continue in Codex: new session with a handoff",
  );
  const sol = popup.getByRole("option", { name: "GPT-6.1-Sol…" });
  await expect(sol).toBeVisible();
  await sol.click();

  const sheet = page.getByTestId("continue-in-dialog");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("heading", { name: "Continue in Codex" })).toBeVisible();
  // Nothing changed by the pick: the chip still names Claude's model.
  await expect(page.getByTestId("composer-choices")).not.toHaveAccessibleName(/GPT/);
  await expect(sheet.getByTestId("continue-in-model")).toContainText("GPT-6.1-Sol");
  // Effort stops at High.
  await sheet.getByTestId("continue-in-effort").click();
  await expect(page.getByRole("option", { name: "High", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "Extra high" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(sheet.getByTestId("continue-in-carries")).toContainText(
    "A note from Claude, the plan, open asks, the last turns, and the branch and PR.",
  );
  await expect(sheet.getByTestId("continue-in-leaves")).toContainText(
    "Claude's tool output, reasoning and cache: the first reply is slower.",
  );
  await expect(sheet.getByTestId("continue-in-note")).toBeChecked();
  await expect(sheet.getByTestId("continue-in-limit")).toHaveCount(0);
  await sheet.getByRole("button", { name: "Cancel" }).click();
  await expect(sheet).toBeHidden();
  expect(errors).toEqual([]);
});

test("greys the group and the menu item with the server's words", async ({ page }) => {
  await bothAgents(page, { codexSignIn: "notSignedIn" });
  await page.goto("/t/t-deps");
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  // Signed out, Codex lists no models: one greyed row under its mark, which says why.
  const popup = await openChoices(page);
  await expect(popup.getByTestId("model-group-mark").last()).toHaveAttribute(
    "aria-label",
    "Sign in to Codex in Settings → Agents.",
  );
  await expect(popup.getByRole("option", { name: "Codex…" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
  const menu = await openThreadMenu(page);
  const item = menu.getByTestId("menu-continue-in");
  await expect(item).toHaveText("Continue in Codex…");
  await expect(item).toHaveAttribute("aria-disabled", "true");
  await expect(item).toHaveAttribute("aria-description", "Sign in to Codex in Settings → Agents.");
});

test("the menu opens the sheet, and Continue leaves a divider that shows what Codex was given", async ({
  page,
}) => {
  await bothAgents(page);
  await page.goto("/t/t-deps");
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  const menu = await openThreadMenu(page);
  await menu.getByTestId("menu-continue-in").click();
  const sheet = page.getByTestId("continue-in-dialog");
  await expect(sheet).toBeVisible();
  // The default target: Opus's tier on Codex.
  await expect(sheet.getByTestId("continue-in-model")).toContainText("GPT-6.1-Sol");
  await sheet.getByTestId("continue-in-confirm").click();
  await expect(sheet).toBeHidden();

  const divider = page.getByTestId("handoff").last();
  await expect(divider).toContainText(/Continued in Codex · GPT-6\.1-Sol · \d\d:\d\d/);
  await expect(divider.getByTestId("handoff-trigger")).toHaveAttribute(
    "aria-description",
    /^Before: Claude Code · .+ · session /,
  );
  await divider.getByTestId("handoff-trigger").click();
  const given = divider.getByTestId("handoff-given");
  await expect(given).toContainText("What Codex was given");
  await expect(given).toContainText("Note · by Claude");
  await expect(given.getByTestId("handoff-facts")).toContainText("Worktree");
  // The chip follows the new agent.
  await expect(page.getByTestId("composer-choices")).toHaveAccessibleName(/GPT-6\.1-Sol/);
});

test("limit mode: the sheet says why, has no checkbox, and Codex writes the note", async ({
  page,
}) => {
  await bothAgents(page);
  await page.goto("/t/t-deps");
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const at = new Date();
    at.setHours(15, 0, 0, 0);
    window.gramMock!.simulateLimitWait(
      "t-deps" as never,
      { kind: "limit", resetsAt: at.getTime(), resumeAt: at.getTime(), attempt: 0 },
      "Carry on with the lockfile.",
    );
  });
  const menu = await openThreadMenu(page);
  await menu.getByTestId("menu-continue-in").click();
  const sheet = page.getByTestId("continue-in-dialog");
  await expect(sheet.getByTestId("continue-in-limit")).toHaveText(
    "Claude is out of usage until 15:00, so Codex's first turn writes the note from the transcript and does no other work.",
  );
  await expect(sheet.getByTestId("continue-in-carries")).toContainText("about 24k tokens");
  await expect(sheet.getByTestId("continue-in-note")).toHaveCount(0);
  await sheet.getByTestId("continue-in-confirm").click();
  await expect(sheet).toBeHidden();
  const divider = page.getByTestId("handoff").last();
  await expect(divider.getByTestId("handoff-limit")).toHaveText(
    "Claude was out of usage · this turn writes the note, no work",
  );
  await divider.getByTestId("handoff-trigger").click();
  await expect(divider.getByTestId("handoff-given")).toContainText("Note · by Codex");
});

test("with only Claude installed, nothing new shows", async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem(
      "gram.mock.launchChecks",
      JSON.stringify({
        tools: [{ tool: "claude", found: true, path: "/mock/bin/claude", version: "2.1.273" }],
      }),
    );
  });
  await page.goto("/t/t-deps");
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  const popup = await openChoices(page);
  await expect(popup.getByRole("option", { name: "Claude Opus" })).toBeVisible();
  await expect(popup.getByTestId("model-group-mark")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
  const menu = await openThreadMenu(page);
  await expect(menu.getByTestId("menu-continue-in")).toHaveCount(0);
});
