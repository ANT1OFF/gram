import { expect, test, type Locator } from "@playwright/test";
import { openMoreOptions } from "./new-thread-options";
import { openOrchestrator } from "./thread-row";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Pastes an image into `target` the way a clipboard screenshot arrives. */
const pasteImage = (target: Locator, name: string) =>
  target.evaluate(
    (element, [base64, fileName]) => {
      const bytes = Uint8Array.from(atob(base64!), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], fileName!, { type: "image/png" }));
      // Chromium ignores `clipboardData` in the ClipboardEvent constructor for synthetic events.
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: data });
      element.dispatchEvent(event);
    },
    [PNG_BASE64, name],
  );

test("a pasted screenshot uploads into a chip with a thumbnail and can be removed", async ({
  page,
}) => {
  await page.goto("/t/t-flaky");
  await pasteImage(page.getByLabel("Message", { exact: true }), "image.png");

  const chip = page.getByTestId("attachment-chip");
  await expect(chip).toHaveAttribute("data-status", "ready");
  await expect(chip).toHaveAttribute("title", /attachments\/t-flaky\/image\.png$/);
  await expect(chip.locator("img")).toBeVisible();

  await chip.getByRole("button", { name: "Remove image.png" }).click();
  await expect(chip).toBeHidden();
});

test("a dropped text file uploads into a chip without a thumbnail", async ({ page }) => {
  await page.goto("/t/t-flaky");
  const dataTransfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(["# notes"], "notes.md", { type: "text/markdown" }));
    return data;
  });
  await page.getByLabel("Message", { exact: true }).dispatchEvent("drop", { dataTransfer });

  const chip = page.getByTestId("attachment-chip");
  await expect(chip).toHaveAttribute("data-status", "ready");
  await expect(chip).toContainText("notes.md");
  await expect(chip.locator("img")).toHaveCount(0);
});

test("a screenshot pasted into /new moves into the thread and its first message shows it", async ({
  page,
}) => {
  await page.goto("/new");
  await openMoreOptions(page);
  const path = page.getByRole("combobox", { name: "Project path" });
  await path.fill("~/Documents/code/gram");
  await expect(page.getByTestId("folder-status")).toContainText("git");

  const prompt = page.getByLabel("First prompt");
  await prompt.fill("what's in this screenshot?");
  await pasteImage(prompt, "Screenshot.png");
  const chip = page.getByTestId("attachment-chip");
  await expect(chip).toHaveAttribute("data-status", "ready");
  await expect(chip).toHaveAttribute("title", /attachments\/_drafts\/[0-9a-f-]+\/Screenshot\.png$/);

  await page.getByRole("button", { name: /Start chat/ }).click();
  await expect(page).toHaveURL(/\/t\/t-mock-/);
  const first = page.getByTestId("message-user").first();
  await expect(first).toContainText("what's in this screenshot?");
  await expect(first.getByTestId("message-attachment")).toHaveAttribute(
    "title",
    /attachments\/t-mock-\d+\/Screenshot\.png$/,
  );

  const thumbnail = first.getByTestId("attachment-thumbnail");
  await expect(thumbnail.locator("img")).toBeVisible();
  await thumbnail.click();
  const lightbox = page.getByTestId("attachment-lightbox");
  await expect(lightbox).toBeVisible();
  await expect(lightbox.locator("img")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(lightbox).toBeHidden();
});

test("a file attached to a task stays through the switch to a one-off and back, then moves with the task", async ({
  page,
}) => {
  // A task goes to a workspace that exists: one on api, opened from its orchestrator.
  await page.goto("/");
  await page.getByTestId("overview-sidebar").waitFor();
  const orchestrator = await page.evaluate(async () => {
    const mock = window.gramMock!;
    const api = mock.world.projects().find((project) => project.name === "api")!;
    const state = await mock.saveWorkspace({
      name: api.name,
      projectIds: [api.id],
      homeProjectId: api.id,
    });
    return (await mock.openOrchestrator({ workspaceId: state.workspace.id })).id;
  });
  await openOrchestrator(page, orchestrator);
  await page
    .getByTestId("overview-sidebar")
    .getByRole("button", { name: "New task", exact: true })
    .click();
  await page.getByTestId("new-entry-menu").getByRole("menuitem", { name: /^Team/ }).click();
  await expect(page).toHaveURL(/\/new-task$/);
  const task = page.getByLabel("What needs doing");
  await task.fill("what's in this screenshot?");
  await pasteImage(task, "Screenshot.png");
  const chip = page.getByTestId("attachment-chip");
  await expect(chip).toHaveAttribute("data-status", "ready");
  const staged = await chip.getAttribute("title");

  const who = () => page.getByRole("radiogroup", { name: "Who does it" });
  await who().getByRole("radio", { name: "Chat", exact: true }).click();
  await expect(page.getByLabel("First prompt")).toHaveValue("what's in this screenshot?");
  await expect(chip).toHaveAttribute("title", staged!);

  await who().getByRole("radio", { name: "Team", exact: true }).click();
  await expect(page.getByTestId("task-target")).toHaveText("api");
  await expect(chip).toHaveAttribute("title", staged!);
  // New workspace has no place for a file, so while one is attached its ways in wait, saying why.
  await page.getByTestId("task-target").click();
  const menu = page.getByTestId("task-target-menu");
  for (const item of [
    menu.getByRole("menuitem", { name: /^web/ }),
    menu.getByTestId("task-target-new-workspace"),
  ]) {
    await expect(item).toBeDisabled();
    await expect(item).toHaveAttribute("title", /can't take attachments/);
  }
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Send to team/ }).click();

  await expect(page.getByTestId("pane-header").getByRole("heading")).toHaveAccessibleName(
    "Orchestrator: api",
  );
  const first = page.getByTestId("message-user").first();
  await expect(first.getByTestId("message-attachment")).toHaveAttribute(
    "title",
    /attachments\/t-mock-\d+\/Screenshot\.png$/,
  );
  await expect(first.getByTestId("attachment-thumbnail").locator("img")).toBeVisible();
});
