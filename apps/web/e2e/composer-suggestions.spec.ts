import { expect, test, type Page } from "@playwright/test";

const FIRST = "Run the e2e suite against Vite 8.3";
const SECOND = "Commit this and open a PR";
const THIRD = "Check the bundle size before and after";

/** `t-deps` with a turn just ended in front of you, and the design's three suggestions for it. */
const suggestedTurn = async (page: Page) => {
  await page.goto("/t/t-deps");
  const composer = page.getByLabel("Message", { exact: true });
  await expect(composer).toBeVisible();
  await page.evaluate(() => window.gramMock?.simulateSuggestions("t-deps" as never));
  await composer.fill("Bump the rest too");
  await composer.press("ControlOrMeta+Enter");
  await expect(page.getByTestId("composer-ghost")).toHaveText(FIRST);
  return composer;
};

const helperEvents = (page: Page) =>
  page.evaluate(() =>
    window.gramMock
      ?.helperEvents()
      .filter((e) => e.kind === "suggest")
      .map((e) => e.event),
  );

test("→ takes a suggestion, ⌥→ a word, ⌥↓ ⌥↑ cycle, and nothing is sent", async ({ page }) => {
  const composer = await suggestedTurn(page);
  const ghost = page.getByTestId("composer-ghost");
  const hint = page.getByTestId("suggestion-hint");
  await expect(hint).toContainText("1/3");
  await expect(composer).toHaveAttribute("placeholder", "");

  await composer.press("Alt+ArrowDown");
  await expect(ghost).toHaveText(SECOND);
  await expect(hint).toContainText("2/3");
  await composer.press("Alt+ArrowDown");
  await expect(ghost).toHaveText(THIRD);
  await composer.press("Alt+ArrowUp");
  await expect(ghost).toHaveText(SECOND);

  // A typed prefix picks the first suggestion it fits, whatever the case.
  await page.keyboard.type("run the e");
  await expect(ghost).toHaveText(`run the e${FIRST.slice("run the e".length)}`);
  await composer.press("Alt+ArrowRight");
  await expect(composer).toHaveValue("run the e2e");
  await composer.press("ArrowRight");
  await expect(composer).toHaveValue(`run the e${FIRST.slice("run the e".length)}`);
  await expect(ghost).toHaveCount(0);
  // Accepting only types: the thread's only user messages are the one sent above and before.
  await expect(page.getByTestId("pane-status")).toHaveText("Idle");
  await expect(page.getByTestId("message-user").filter({ hasText: "run the e2e" })).toHaveCount(0);

  // One ⌘Z takes the whole acceptance back.
  await composer.press("ControlOrMeta+z");
  await expect(composer).toHaveValue("run the e2e");
  await expect
    .poll(() => helperEvents(page))
    .toEqual(["shown", "taken", "wordAccepted", "accepted"]);
});

test("Esc puts the suggestion away, Tab moves on, and menus hide it", async ({ page }) => {
  const composer = await suggestedTurn(page);
  const ghost = page.getByTestId("composer-ghost");

  await composer.press("Tab");
  await expect(composer).not.toBeFocused();
  await expect(composer).toHaveValue("");
  await expect(ghost).toHaveCount(0);

  await composer.focus();
  await expect(ghost).toHaveText(FIRST);
  await page.keyboard.type("/");
  await expect(page.getByRole("listbox")).toBeVisible();
  await expect(ghost).toHaveCount(0);
  await composer.press("Backspace");
  await expect(ghost).toHaveText(FIRST);

  await composer.press("Escape");
  await expect(ghost).toHaveCount(0);
  await expect.poll(() => helperEvents(page)).toEqual(["shown", "dismissed"]);
});

test("an accepted suggestion edited before sending is counted, and the next turn clears it", async ({
  page,
}) => {
  const composer = await suggestedTurn(page);
  await composer.press("ArrowRight");
  await expect(composer).toHaveValue(FIRST);
  await page.keyboard.type(" first");
  await composer.press("ControlOrMeta+Enter");
  await expect(composer).toHaveValue("");
  // The turn just sent can end, and show its own, before this reads: the first four are this one's.
  const accepted = ["shown", "taken", "accepted", "editedAfter"];
  await expect.poll(async () => (await helperEvents(page))?.slice(0, 4)).toEqual(accepted);
  // That turn ends with suggestions of its own: the same three, shown afresh.
  await expect(page.getByTestId("composer-ghost")).toHaveText(FIRST);
  await expect.poll(() => helperEvents(page)).toEqual([...accepted, "shown"]);
});
