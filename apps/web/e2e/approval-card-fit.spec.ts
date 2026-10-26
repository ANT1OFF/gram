import { expect, test, type Page } from "@playwright/test";

// A tall approval card above the composer: its body scrolls inside the card, and its buttons stay
// on screen and take a click, on a full-height window and a short one. Synthetic mock state;
// nothing reaches a provider.

const THREAD = "t-deps";

const LONG = "bun run check:scaffold && bun run typecheck && bun run lint && bun run test --run";

/** A `workspace_create` as reported: four projects and a dozen settings. */
const WORKSPACE_CREATE = {
  action: "create",
  workspace: { name: "[Workspace name]" },
  reason: "The handoff README lists this workspace with these repositories and settings.",
  projects: ["api", "web", "docs", "infra"].map((name, i) => ({
    root: `/Users/dev/code/${name}`,
    name,
    change: "added",
    ...(i === 0 ? { home: true } : { unregistered: true }),
  })),
  rows: Array.from({ length: 12 }, (_, i) => ({
    key: `workspace.setting${i}`,
    label: `Setting number ${i + 1}`,
    before: null,
    after: `A long value for setting ${i + 1}, so that its row wraps: ${LONG}`,
  })),
};

/** A `settings_propose` with a project's local check command, setup and timeout together. */
const SETTINGS_PROPOSE = {
  scope: "workspace",
  workspace: { id: "w-api", name: "[Workspace name]" },
  reason: "You asked for a local check before merges.",
  rows: [
    { key: "project.localCheck.command", label: "Local check command", before: null, after: LONG },
    { key: "project.localCheck.setup", label: "Local check setup", before: null, after: LONG },
    {
      key: "project.localCheck.timeoutMs",
      label: "Local check timeout",
      before: "600000",
      after: "1800000",
    },
    { key: "project.localCheck.env", label: "Local check environment", before: null, after: LONG },
  ],
};

const raise = async (page: Page, toolName: string, input: Record<string, unknown>) => {
  await page.goto(`/t/${THREAD}`);
  await page.getByLabel("Message", { exact: true }).waitFor();
  await page.evaluate(
    ([threadId, tool, request]) =>
      window.gramMock!.simulateRequest(threadId as never, {
        kind: "approval",
        id: `r-fit-${tool}` as never,
        toolUseId: `fit-${tool}`,
        toolName: tool,
        displayName: "Change",
        input: request,
        description: "A tall change.",
        suggestions: [],
        scopes: ["once"],
      }),
    [THREAD, toolName, input] as const,
  );
  await page.getByTestId("approval-card").last().waitFor();
};

/** The button is on screen whole, and a click at its middle lands on it, not on what covers it. */
const reachable = async (page: Page, testId: string) => {
  const button = page.getByTestId("approval-card").last().getByTestId(testId);
  await expect(button).toBeInViewport({ ratio: 1 });
  expect(
    await button.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return hit !== null && element.contains(hit);
    }),
  ).toBe(true);
  // And the composer is still there below it.
  await expect(page.getByLabel("Message", { exact: true })).toBeInViewport();
};

for (const [width, height] of [
  [1728, 1117],
  [1000, 520],
] as const) {
  test.describe(`at ${width}×${height}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height });
    });

    for (const [toolName, input] of [
      ["mcp__gram__workspace_create", WORKSPACE_CREATE],
      ["mcp__gram__settings_propose", SETTINGS_PROPOSE],
    ] as const) {
      test(`a tall ${toolName} card keeps its buttons on screen`, async ({ page }) => {
        await raise(page, toolName, input);
        await reachable(page, "approval-allow");
        await reachable(page, "approval-deny");
        // What doesn't fit scrolls inside the card, down to its last row.
        const last = page.getByTestId("approval-card").last().locator("tbody tr").last();
        await last.scrollIntoViewIfNeeded();
        await expect(last).toBeInViewport();
        await reachable(page, "approval-allow");
      });
    }

    test("a reported issue's card keeps its buttons on screen", async ({ page }) => {
      await page.goto(`/t/${THREAD}`);
      const composer = page.getByLabel("Message", { exact: true });
      await composer.fill("Please report an issue");
      await composer.press("ControlOrMeta+Enter");
      await page.getByTestId("approval-card").last().waitFor();
      await reachable(page, "approval-allow");
      await reachable(page, "approval-deny");
    });
  });
}
