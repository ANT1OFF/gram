import { expect, test, type Page } from "@playwright/test";
import { pressFirstWorkspaceKey } from "./thread-row";

// The workspace Files view: what the orchestrator and its
// workers produced, as thumbnails by day or feature, reached from the orchestrator's "/" verbs and
// ⌘K. The mock lists synthetic outputs for each thread and draws their pictures; every read goes
// through the thread that made the file, as on the server.

const MOCK_SETTINGS_KEY = "gram.mock.settings";

const seed = (page: Page, mode: "light" | "dark") =>
  page.addInitScript(
    ([key, theme]) => {
      const palette = theme === "dark" ? "neutral-dark" : "neutral";
      if (localStorage.getItem("gram.theme") === null) {
        localStorage.setItem(
          "gram.theme",
          JSON.stringify({
            state: {
              look: "glass",
              palette,
              mode: theme,
              density: "comfortable",
              contrast: "system",
              motion: "off",
              customPalettes: [],
            },
            version: 1,
          }),
        );
      }
      if (sessionStorage.getItem(key) === null) {
        sessionStorage.setItem(
          key,
          JSON.stringify({
            appearance: {
              look: "glass",
              paletteId: palette,
              mode: theme,
              density: "compact",
              contrast: "standard",
              motion: "off",
            },
          }),
        );
      }
    },
    [MOCK_SETTINGS_KEY, mode] as const,
  );

// The mock dates each file minutes to hours before its thread's last activity, so just after
// midnight even the newest falls on yesterday. The clock starts at midday in a pinned zone, so
// the newest group is always "Today".
const MIDDAY = new Date("2026-10-18T12:00:00Z");
test.use({ timezoneId: "UTC" });

const composer = (page: Page) => page.locator('[data-pane-root] textarea[aria-label="Message"]');

/** The One thread scenario, on the orchestrator's home. */
const home = async (page: Page, mode: "light" | "dark" = "dark") => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.install({ time: MIDDAY });
  await seed(page, mode);
  await page.goto("/t/t-flaky");
  await page.getByLabel("Message", { exact: true }).waitFor();
  const made = await page.evaluate(() => window.gramMock!.simulateOneThread());
  await pressFirstWorkspaceKey(page);
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  await expect(page.locator(`[data-thread-view="${made.orchestratorThreadId}"]`)).toBeVisible();
  return made;
};

/** Opens Files with the orchestrator's "/files" verb. */
const openFiles = async (page: Page) => {
  await composer(page).click();
  await composer(page).pressSequentially("/files");
  await expect(page.getByRole("listbox", { name: "Orchestrator commands" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/w\/[^/]+\/files$/);
  const view = page.getByTestId("outputs-view");
  await expect(view).toBeVisible();
  return view;
};

const tiles = (page: Page) => page.getByTestId("output-tile");

test("/files on the orchestrator opens the workspace's files by day, each opening through its thread", async ({
  page,
}) => {
  const made = await home(page);
  const view = await openFiles(page);
  await expect(view.getByRole("heading", { level: 1 })).toHaveText(/^Files · /);
  await expect(tiles(page).first()).toBeVisible();
  expect(await tiles(page).count()).toBeGreaterThan(8);
  await expect(page.getByTestId("output-group").first()).toHaveAttribute("aria-label", "Today");
  // Pictures arrive as their tiles come into view.
  await expect(
    page.locator(`[data-testid="output-tile"][data-kind="screenshot"] img`).first(),
  ).toBeVisible();

  // Filtering and grouping are outputs-view.test.tsx's; here each kind opens where it lives.
  // A screenshot opens at full size; its thread is one click away.
  const shot = page.locator('[data-testid="output-tile"][data-kind="screenshot"]').first();
  const threadId = await shot.getAttribute("data-thread-id");
  await shot.getByRole("button").first().click();
  const viewer = page.getByTestId("output-viewer");
  await expect(viewer.getByRole("img")).toBeVisible();
  await viewer.getByTestId("output-viewer-thread").click();
  await expect(viewer).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/t/${threadId}$`));

  // A document opens in its thread's Files panel.
  await page.keyboard.press("ControlOrMeta+1");
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  await openFiles(page);
  await page.getByRole("radio", { name: "Documents" }).click();
  const doc = page.locator('[data-testid="output-tile"][data-openable="true"]').first();
  await expect(doc).toHaveAttribute("data-kind", "document");
  const docThread = await doc.getAttribute("data-thread-id");
  await doc.getByRole("button").first().click();
  await expect(page).toHaveURL(new RegExp(`/t/${docThread}$`));
  await expect(page.getByTestId("files-panel").first()).toBeVisible();
});

test("⌘K Workspace files goes there from the orchestrator", async ({ page }) => {
  await home(page);
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByTestId("command-palette");
  await expect(palette).toBeVisible();
  await page.keyboard.type(">Workspace files");
  await palette
    .getByRole("option", { name: /Workspace files/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/w\/[^/]+\/files$/);
  await expect(page.getByTestId("outputs-view")).toBeVisible();
});
