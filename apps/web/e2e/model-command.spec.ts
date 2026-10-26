import { expect, test, type Page } from "@playwright/test";

test("a /model typed into a thread moves its model picker, and is offered in Settings", async ({
  page,
}) => {
  await page.goto("/t/t-deps");
  const composer = page.getByLabel("Message", { exact: true });
  const picker = page.getByRole("combobox", { name: "Model" });
  await expect(picker).not.toHaveText(/claude-preview/);

  await composer.fill("/model claude-preview[1m]");
  await composer.press("Enter");
  // A model the agent doesn't list is shown by its id.
  await expect(picker).toHaveText(/claude-preview\[1m\]/);

  // In-app navigation: a reload would start the mock's threads over.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("link", { name: "Agents", exact: true })
    .click();
  await page
    .getByTestId("model-suggestions")
    .getByRole("button", { name: "Add claude-preview[1m]" })
    .click();
  await page.getByTestId("custom-models").getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("custom-models").getByRole("status")).toHaveText(
    "Custom models saved.",
  );

  await page.goto("/new");
  await page
    .getByRole("form", { name: "New thread" })
    .getByRole("combobox", { name: "Model" })
    .click();
  await expect(page.getByRole("option", { name: "claude-preview[1m]" })).toBeVisible();
});

/** Sends `/compact` in "Bump dependencies", its script held at the gate before the marker. */
const sendCompact = async (page: Page) => {
  await page.addInitScript(() => {
    window.gramMockHoldGates = true;
  });
  await page.goto("/t/t-deps");
  const composer = page.getByLabel("Message", { exact: true });
  await composer.fill("/compact");
  // The first Enter takes the command from the menu, the second sends it.
  await composer.press("Enter");
  await expect(composer).toHaveValue("/compact ");
  await composer.press("Enter");
  return page.getByTestId("compacting");
};

test("a /compact runs live, then leaves a marker where it happened, which opens to the summary", async ({
  page,
}) => {
  const live = await sendCompact(page);
  await expect(live).toContainText(
    /^Compacting context.*Compacting context… · \d+s · from 182K tokens$/,
  );
  await expect(page.getByTestId("pane-status")).toContainText("Compacting");
  await expect(page.getByTestId("compaction")).toHaveCount(0);
  await page.evaluate(() => window.gramMock?.release("compaction"));

  await expect(live).toHaveCount(0);
  const marker = page.getByTestId("compaction");
  const toggle = marker.getByRole("button", {
    name: /^Context compacted · .+ · 182K → 24K tokens$/,
  });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveText(/^Context compacted · \d{2}:\d{2} · 182K → 24K tokens$/);
  await expect(page.getByTestId("usage-ring")).toHaveAttribute(
    "aria-label",
    "Usage: 12% of the context window",
  );
  await expect(page.getByTestId("compaction-summary")).toHaveCount(0);
  await toggle.click();
  await expect(page.getByTestId("compaction-summary")).toContainText("Primary Request and Intent");
});

test("a /compact in a narrow pane keeps its wrapped live line clear of the composer", async ({
  page,
}) => {
  // A pane narrow enough that the live line wraps: the window, with the overview's rail folded away.
  // The flush pane takes the whole width, and the line fits on one line from about 390 px.
  await page.setViewportSize({ width: 360, height: 720 });
  const live = await sendCompact(page);
  await expect(async () => {
    const line = (await live.boundingBox())!;
    const transcript = (await page.getByTestId("transcript").boundingBox())!;
    // Wrapped onto a second line, and all of it above the fade into the composer.
    expect(line.height).toBeGreaterThan(30);
    expect(line.y + line.height).toBeLessThanOrEqual(transcript.y + transcript.height - 24);
  }).toPass();
  await page.evaluate(() => window.gramMock?.release("compaction"));
  await expect(page.getByTestId("compaction")).toBeVisible();
});

test("Gram answers its own slash commands, and explains a terminal-only one", async ({ page }) => {
  await page.goto("/t/t-deps");
  const composer = page.getByLabel("Message", { exact: true });
  await composer.fill("/");
  const menu = page.getByRole("listbox", { name: "Slash commands" });
  await expect(menu.getByText("Gram", { exact: true })).toBeVisible();
  await expect(menu.getByRole("option", { name: /^\/compact/ })).toBeVisible();

  await composer.fill("/plugins");
  const note = page.getByTestId("slash-note");
  await expect(note).toHaveText(
    "/plugins isn't available in Gram threads; open Claude Code in a terminal.",
  );
  await composer.press("Enter");
  // Nothing went: the draft and its note are still there.
  await expect(composer).toHaveValue("/plugins");
  await expect(note).toBeVisible();

  await composer.fill("/rename Deps without the drama");
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  await expect(page.getByText("Renamed the thread")).toBeVisible();
  await expect(page.getByText("Deps without the drama").first()).toBeVisible();

  // Claude's `/clear` is Gram's `/new`: the menu takes it, then it starts a new thread.
  await composer.fill("/clear");
  await composer.press("Enter");
  await expect(composer).toHaveValue("/new ");
  await composer.press("Enter");
  await expect(page).toHaveURL(/\/new$/);
});

test("past eight models the picker searches, and a starred model comes first", async ({ page }) => {
  const custom = ["Opus 5.5", "Sonnet 5.5", "Fable 5.1", "Haiku 4.5", "Opus 5", "Sonnet 5"].map(
    (name) => ({ agent: "claude", id: name.toLowerCase().replaceAll(" ", "-"), name }),
  );
  await page.addInitScript((customModels) => {
    sessionStorage.setItem("gram.mock.settings", JSON.stringify({ agents: { customModels } }));
  }, custom);
  await page.goto("/t/t-deps");
  const picker = page
    .getByTestId("composer-toolbar")
    .getByRole("combobox", { name: "Model", exact: true });
  await expect(picker).toHaveText(/Claude Opus/);

  await page.getByLabel("Message", { exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+Shift+KeyM");
  const search = page.getByRole("combobox", { name: "Search models" });
  await expect(search).toBeFocused();
  await search.fill("sonnet 5.5");
  const list = page.getByTestId("model-picker");
  await expect(list.getByRole("option")).toHaveCount(1);
  // ⇧↵ accepting an IME candidate stars nothing.
  await search.dispatchEvent("keydown", {
    key: "Enter",
    shiftKey: true,
    isComposing: true,
    bubbles: true,
  });
  await expect(list.getByRole("button", { name: "Add Sonnet 5.5 to favourites" })).toBeAttached();
  await search.press("Shift+Enter");
  await expect(
    list.getByRole("button", { name: "Remove Sonnet 5.5 from favourites" }),
  ).toBeAttached();
  await search.press("Enter");
  await expect(picker).toHaveText(/Sonnet 5\.5/);

  await picker.click();
  await expect(list.getByText("Favourites")).toBeVisible();
  await expect(list.getByRole("option").first()).toHaveText(/Sonnet 5\.5/);
  await list.getByRole("option", { name: /Fable 5\.1/ }).hover();
  await list.getByRole("button", { name: "Add Fable 5.1 to favourites" }).click();
  await expect(
    list.getByRole("button", { name: "Remove Fable 5.1 from favourites" }),
  ).toBeAttached();
  await expect(search).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();
});
