import { expect, test } from "@playwright/test";

test("Enter sends by default, and Settings can keep it for new lines", async ({ page }) => {
  await page.goto("/t/t-deps");
  const composer = page.getByLabel("Message", { exact: true });
  await composer.fill("first line");
  await composer.press("Shift+Enter");
  await composer.pressSequentially("second line");
  await composer.press("Enter");
  await expect(page.getByTestId("message-user").last()).toContainText("first line");
  await expect(page.getByTestId("message-user").last()).toContainText("second line");
  await expect(composer).toHaveValue("");

  // Inside an open code fence Enter is a new line: nobody sends half a code block on purpose.
  await composer.fill("```ts");
  await composer.press("Enter");
  await composer.pressSequentially("const a = 1;");
  await expect(composer).toHaveValue("```ts\nconst a = 1;");
  await composer.fill("");

  await page.goto("/settings/general");
  await page
    .getByTestId("general-settings")
    .getByRole("radiogroup", { name: "Send with" })
    .getByRole("radio", { name: "Shortcut only" })
    .click();

  await page.goto("/t/t-deps");
  await composer.fill("kept");
  await composer.press("Enter");
  await composer.pressSequentially("typing");
  await expect(composer).toHaveValue("kept\ntyping");
  await composer.press("ControlOrMeta+Enter");
  await expect(page.getByTestId("message-user").last()).toContainText("typing");
});

test("a Send shortcut rebound without ⌘ still sends from the text area", async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem(
      "gram.mock.keybindings",
      JSON.stringify({ "composer.send": "alt+enter" }),
    );
  });
  await page.goto("/t/t-deps");
  const composer = page.getByLabel("Message", { exact: true });
  await composer.fill("rebound");
  // Let the overrides load before pressing keys.
  await page.waitForTimeout(500);
  // It is this text area's chord, and no other field's: from the pane's find bar it does nothing.
  const sent = page.getByTestId("message-user");
  const before = await sent.count();
  await page.keyboard.press("ControlOrMeta+f");
  await page.getByLabel("Find in thread").press("Alt+Enter");
  await expect(sent).toHaveCount(before);
  await expect(composer).toHaveValue("rebound");

  await composer.press("Alt+Enter");
  await expect(sent.last()).toContainText("rebound");
});
