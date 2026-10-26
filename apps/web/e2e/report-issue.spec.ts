import { expect, test, type Page } from "@playwright/test";
import { threadRow } from "./thread-row";

/** Opens the form from the palette on a thread, so the diagnostics name its agent. */
const openForm = async (page: Page) => {
  await page.goto("/t/t-flaky");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByTestId("command-palette");
  await palette.getByRole("combobox").fill(">report");
  await palette.getByText("Report an issue…", { exact: true }).click();
  const dialog = page.getByTestId("report-issue-dialog");
  await expect(dialog).toBeVisible();
  return dialog;
};

test("files a feature request with diagnostics and links the new issue", async ({ page }) => {
  const dialog = await openForm(page);
  await dialog.getByRole("radio", { name: "Feature" }).click();
  await dialog.getByRole("textbox", { name: "Title" }).fill("Pin threads");
  await dialog.getByRole("textbox", { name: "Description" }).fill("Keep a thread at the top.");
  await dialog.getByRole("combobox", { name: "Area" }).click();
  await page.getByRole("option", { name: "Interface" }).click();

  await dialog.getByTestId("report-issue-diagnostics").click();
  const footer = dialog.getByTestId("report-issue-diagnostics-body");
  await expect(footer).toContainText("- Agent: claude");
  await expect(footer).toContainText("- Filed from Gram by the user");

  await dialog.getByRole("button", { name: "Submit" }).click();
  await expect(dialog.getByTestId("report-issue-filed")).toContainText("#161");
  const filed = await page.evaluate(() => window.gramMock!.filedIssues.at(-1));
  expect(filed).toMatchObject({ labels: ["enhancement", "web"], title: "Pin threads" });
  expect(filed?.body).toMatch(/^Keep a thread at the top\.\n\n---\n\n\*\*Diagnostics\*\*/);

  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
});

test("shows gh's error and offers the prefilled GitHub page instead", async ({ page }) => {
  const dialog = await openForm(page);
  await page.evaluate(() => {
    window.gramMock!.issueFailure.message = "HTTP 403: Resource protected by IP allow list";
  });
  await dialog.getByRole("textbox", { name: "Title" }).fill("Crash on launch");
  await dialog.getByRole("checkbox", { name: "Include diagnostics" }).uncheck();
  await expect(dialog.getByTestId("report-issue-diagnostics")).toBeHidden();
  await dialog.getByRole("button", { name: "Submit" }).click();
  await expect(dialog.getByRole("alert")).toContainText("IP allow list");

  await dialog.getByTestId("report-issue-open-github").click();
  await expect
    .poll(() => page.evaluate(() => window.gramMock!.opened.at(-1)))
    .toBe("https://github.com/ANT1OFF/gram/issues/new?title=Crash+on+launch&body=&labels=bug");
});

test("an agent's report shows the issue as posted on its card, every time", async ({ page }) => {
  await page.goto("/t/t-release");
  const composer = page.getByLabel("Message", { exact: true });
  await composer.fill("Please report an issue about the terminal freezing");
  await composer.press("Enter");
  const card = page.getByTestId("approval-card");
  await expect(card.getByTestId("approval-summary")).toHaveText(
    "File “Terminal output freezes after resizing the split” on ANT1OFF/gram (bug, web)",
  );
  await expect(card.getByTestId("approval-issue-body")).toContainText(
    "- Filed from Gram by an agent in a thread",
  );
  await expect(card.getByTestId("approval-always")).toBeHidden();
  await card.getByTestId("approval-allow").click();
  await expect(page.getByText("Filed https://github.com/ANT1OFF/gram/issues/162.")).toBeVisible();
});
