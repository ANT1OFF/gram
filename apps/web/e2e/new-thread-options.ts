import type { Locator, Page } from "@playwright/test";

// The new-thread form's rarely used half (the folder's path field, past sessions) is folded under
// "More options" while the folder is good. A spec that types a path or resumes a session opens it
// first, as a user would.

/** Opens the form's More options, if they are folded. */
export async function openMoreOptions(page: Page): Promise<void> {
  const toggle = page.getByTestId("new-more-options");
  await toggle.waitFor();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}

/** The form's Project path field, its More options opened. */
export async function projectPath(page: Page): Promise<Locator> {
  await openMoreOptions(page);
  return page.getByRole("combobox", { name: "Project path" });
}
