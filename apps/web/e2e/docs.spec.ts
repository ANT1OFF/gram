import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { openOrchestrator } from "./thread-row";

// A worker publishes a doc (`publish_doc`, simulated as the server would land it): its card in the
// worker's transcript and its orchestrator's chat, the chip above the worker's composer, and the
// Docs tab that reads and edits it. The mock API keeps the docs in memory; nothing leaves the page.

/** Where screenshots go when asked for (`DOCS_SHOTS=<dir>`); none otherwise. */
const SHOTS = process.env["DOCS_SHOTS"];

const TITLE = "Harness features for gram: gap analysis";
const CONTENT = `# Harness features for gram

Where Gram stands against the harness features the team uses every day, and what to build next.

## Summary

| Feature | Gram | Next |
| --- | --- | --- |
| Docs | Local Markdown, editable | Comments |
| Cards | Transcript and orchestrator | Thumbnails from content |

## Notes

- Docs stay in Gram's state, outside the repo.
- Every save moves the revision on, so edits never cross.

\`\`\`ts
await publishDoc({ title, content });
\`\`\`
`;

const shoot = async (page: Page, name: string) => {
  if (SHOTS === undefined) return;
  // Off every control, so no hover hint is in the picture.
  await page.mouse.move(700, 120);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

/** The report scenario's worker, opened from its orchestrator's feature card as a user would. */
const start = async (page: Page) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/t/t-flaky");
  await page.waitForFunction(() => window.gramMock !== undefined);
  const made = await page.evaluate(() => window.gramMock!.simulateOrchestration("report"));
  await openOrchestrator(page, made.orchestratorThreadId);
  // The worker's name on its feature card opens its own view with the modifier.
  await page
    .getByRole("link", { name: "Return rate-limit headers" })
    .first()
    .click({ modifiers: ["ControlOrMeta"] });
  await page.waitForURL(new RegExp(`/t/${made.workerThreadId}$`));
  return made;
};

const publish = (
  page: Page,
  threadId: string,
  input: { title?: string; content: string; id?: string },
) =>
  page.evaluate(
    ({ thread, doc }) => window.gramMock!.simulatePublishDoc(thread as never, doc as never),
    { thread: threadId, doc: input },
  );

test("a published doc shows as a card and a chip, and reads and saves in the Docs tab", async ({
  page,
}) => {
  const made = await start(page);
  await expect(page.getByTestId("pinned-doc")).toHaveCount(0);
  await shoot(page, "before-worker");

  const doc = await publish(page, made.workerThreadId, { title: TITLE, content: CONTENT });
  const card = page.getByTestId("doc-card");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText(TITLE);
  await expect(card).toContainText("Published by");
  await expect(card).toContainText("Where Gram stands against the harness features");
  const chip = page.getByTestId("pinned-doc");
  await expect(chip).toContainText(TITLE);
  await expect(chip).toContainText("· updated just now");
  await shoot(page, "after-worker-card");

  // Tab from the open button to the hover/focus control and dismiss with the keyboard.
  const dismiss = page.getByRole("button", { name: "Dismiss document chip" });
  await page.mouse.move(700, 120);
  await expect(dismiss).toHaveCSS("opacity", "0");
  await chip.hover();
  await expect(dismiss).toHaveCSS("opacity", "1");
  if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, "after-chip-hover.png") });
  await page.mouse.move(700, 120);
  await chip.focus();
  await page.keyboard.press("Tab");
  await expect(dismiss).toBeFocused();
  await expect(dismiss).toHaveCSS("opacity", "1");
  await page.keyboard.press("Enter");
  await expect(chip).toHaveCount(0);
  await expect(page.getByTestId("doc-view")).toHaveCount(0);
  await shoot(page, "after-chip-dismissed");

  // Dismissing the shortcut leaves the transcript's way into the document intact.
  await card.getByRole("button", { name: `Open ${TITLE}` }).click();
  await expect(page.getByRole("tab", { name: "Docs", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const view = page.getByTestId("doc-view");
  await expect(view.getByTestId("doc-title")).toHaveText(TITLE);
  await expect(view.getByTestId("doc-meta")).toHaveText(/^By .+ · \d{2}:\d{2}$/);
  const body = view.getByTestId("doc-body");
  await expect(body.getByRole("heading", { name: "Summary" })).toBeVisible();
  await expect(body.getByRole("table")).toBeVisible();
  await expect(body).toContainText("await publishDoc");
  await shoot(page, "after-doc-pane");

  await view.getByTestId("doc-edit").click();
  const editor = view.getByTestId("doc-editor");
  await expect(editor).toHaveValue(CONTENT);
  await editor.fill(`${CONTENT}\n## Decision\n\nShip docs first.\n`);
  await shoot(page, "after-doc-editing");
  await view.getByTestId("doc-save").click();
  await expect(view.getByTestId("doc-editor")).toHaveCount(0);
  await expect(view).toHaveAttribute("data-revision", "2");
  await expect(view.getByTestId("doc-meta")).toHaveText(/updated \d{2}:\d{2} by you$/);
  await expect(body.getByRole("heading", { name: "Decision" })).toBeVisible();
  await expect(chip).toBeVisible();
  await dismiss.click();
  await expect(chip).toHaveCount(0);

  // An agent update over the revision it last saw would be refused; over the current one it lands.
  await publish(page, made.workerThreadId, { id: doc.id, content: `${CONTENT}\nRevised.\n` });
  await expect(view).toHaveAttribute("data-revision", "3");
  await expect(chip).toBeVisible();
  await expect(page.getByTestId("doc-card")).toHaveCount(2);
  await expect(page.getByTestId("doc-card").last()).toContainText("Updated by");

  // All docs is the workspace's list.
  await view.getByTestId("doc-back").click();
  await expect(page.getByTestId("docs-list").getByTestId("doc-row")).toHaveCount(1);

  // The orchestrator's chat has the worker's cards too.
  await openOrchestrator(page, made.orchestratorThreadId);
  await expect(page.getByTestId("doc-card").first()).toContainText(TITLE);
  await shoot(page, "after-orchestrator-card");
});
