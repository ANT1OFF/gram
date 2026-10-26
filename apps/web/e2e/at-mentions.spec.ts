import { expect, test } from "@playwright/test";

test("@ offers the thread's files, opens folders and inserts a mention", async ({ page }) => {
  await page.goto("/t/t-flaky");
  const composer = page.getByRole("combobox", { name: "Message" });
  await expect(composer).toBeVisible();
  const files = page.getByRole("listbox", { name: "Files" });

  await composer.click();
  await composer.pressSequentially("Why is @sr");
  await expect(files.getByRole("option").first()).toHaveAccessibleName("src/");
  await composer.press("Tab");
  await expect(composer).toHaveValue("Why is @src/");
  await expect(files.getByRole("option", { name: "src/retry.ts", exact: true })).toBeVisible();
  // The git-ignored build output is never offered.
  await expect(files.getByRole("option", { name: /^dist/ })).toHaveCount(0);

  await composer.pressSequentially("ret");
  await expect(files.getByRole("option").first()).toHaveAccessibleName("src/retry.ts");
  await composer.press("Enter");
  await expect(composer).toHaveValue("Why is @src/retry.ts ");
  await expect(files).toBeHidden();

  // Escape closes the list and leaves the text as typed; an email address never opens it.
  await composer.pressSequentially("vs @");
  await expect(files).toBeVisible();
  await composer.press("Escape");
  await expect(files).toBeHidden();
  await composer.pressSequentially("docs, ask me@organization.example.invalid");
  await expect(files).toBeHidden();
  await expect(composer).toHaveValue(
    "Why is @src/retry.ts vs @docs, ask me@organization.example.invalid",
  );
});

test("the new-thread draft offers the chosen folder's files", async ({ page }) => {
  await page.goto("/new");
  const form = page.getByRole("form", { name: "New thread" });
  await page.getByRole("combobox", { name: "Project path" }).fill("/Users/dev/code/web");
  await expect(form.getByRole("button", { name: /Resume a past session/ })).toBeVisible();
  const prompt = form.getByRole("combobox", { name: "First prompt" });
  const files = page.getByRole("listbox", { name: "Files" });

  await prompt.pressSequentially("Start with @sr");
  await expect(files.getByRole("option").first()).toHaveAccessibleName("src/");
  await prompt.press("Tab");
  await prompt.pressSequentially("ret");
  await expect(files.getByRole("option").first()).toHaveAccessibleName("src/retry.ts");
  await prompt.press("Enter");
  await expect(prompt).toHaveValue("Start with @src/retry.ts ");
  await expect(files).toBeHidden();
});
