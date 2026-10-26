import { expect, test, type Page } from "@playwright/test";
import { openReviewsTab, reviewsInPanel } from "./reviews-panel";
import { seedTheme } from "./seed-theme";

// The review requests and open PRs lists with everything they say about each PR: the right panel's
// Reviews tab is where they are listed in full, so each test places both there.

/** VITE_API=mock uses explicit invented poll snapshots; no backend, GitHub or provider CLI. */
async function populate(page: Page) {
  await openReviewsTab(page);
  await expect(page.getByTestId("open-prs-count")).toHaveText("3");
  await page.evaluate(() => {
    const base = {
      repo: "example/api",
      author: "ada",
      isBot: false,
      isDraft: false,
      createdAt: "2026-08-01T10:30:00Z",
      updatedAt: "2026-10-11T10:30:00Z",
      informationAt: "2026-10-11T10:30:00Z",
    };
    const prs = [
      {
        ...base,
        number: 412,
        title: "Make the offline retry deterministic across slow workers",
        url: "https://github.com/example/api/pull/412",
        checks: "failing" as const,
        reviewDecision: "CHANGES_REQUESTED",
        headRef: "fix/offline-retry",
        labels: ["bug", "offline-cache", "a-very-long-label-without-spaces-for-layout"],
        additions: 2034,
        deletions: 13,
      },
      {
        ...base,
        repo: "example/tools",
        number: 501,
        title:
          "Update the worker protocol with a very long descriptive title that remains readable",
        url: "https://github.com/example/tools/pull/501",
        author: "helper[bot]",
        isBot: true,
        checks: "passing" as const,
        mergeState: "DIRTY",
        reviewDecision: "APPROVED",
        bot: { verdict: "approved" as const, onHead: true },
        labels: ["dependencies"],
        additions: 0,
        deletions: 0,
      },
      {
        ...base,
        repo: "example/tools",
        number: 502,
        title: "Explore a smaller cache",
        url: "https://github.com/example/tools/pull/502",
        isDraft: true,
        checks: "pending" as const,
        labels: ["discussion"],
        additions: 12,
        deletions: 4,
      },
      {
        ...base,
        repo: "example/tools",
        number: 503,
        title: "Document the protocol",
        url: "https://github.com/example/tools/pull/503",
        checks: "none" as const,
        updatedAt: "2026-10-10T10:30:00Z",
      },
      {
        ...base,
        repo: "example/tools",
        number: 504,
        title: "Investigate queued work",
        url: "https://github.com/example/tools/pull/504",
        author: "",
        updatedAt: "2026-10-09T10:30:00Z",
      },
      {
        ...base,
        repo: "example/tools",
        number: 505,
        title: "Cached result awaiting fresh details",
        url: "https://github.com/example/tools/pull/505",
        checks: "passing" as const,
        detailsStale: true,
        informationStale: true,
        additions: 100,
        deletions: 0,
      },
    ];
    window.gramMock?.replacePrLists({
      prs,
      requests: prs.slice(1).map((pr) => ({ ...pr, author: pr.author ?? "" })),
    });
  });
  await expect(page.getByTestId("open-prs-count")).toHaveText("6");
  await expect(page.getByTestId("reviews-tab-count")).toHaveText("5");
}

for (const mode of ["light", "dark"] as const) {
  // The right panel's narrowest, its default and a wide one.
  for (const width of [240, 352, 480]) {
    test(`PR information at ${width}px in ${mode}`, async ({ page }, info) => {
      await page.setViewportSize({ width: 1280, height: 1100 });
      await seedTheme(page, { palette: "graphite", mode, motion: "off" });
      await reviewsInPanel(page, { requests: true, own: true, panelWidth: width });
      await page.goto("/t/t-question");
      await populate(page);
      const panel = page.getByTestId("right-panel");
      expect(Math.round((await panel.boundingBox())!.width)).toBe(width);
      for (const id of ["review-requests", "open-prs"]) {
        const section = panel.getByTestId(id);
        await section.scrollIntoViewIfNeeded();
        await section.screenshot({ path: info.outputPath(`${id}-${width}-${mode}.png`) });
        const overflow = await section.evaluate((element) =>
          [...element.querySelectorAll("li")].some((row) => row.scrollWidth > row.clientWidth),
        );
        expect(overflow).toBe(false);
      }
      const open = page.getByTestId("open-prs");
      // A row's state glyph names its state; its button already names the PR.
      await expect(open.getByRole("img", { name: "Draft", exact: true })).toBeVisible();
      // Checks are spelled out in each row's hover card, not as glyphs in the list.
      const card = page.getByTestId("open-pr-card");
      // Preview cards open on keyboard-visible focus; the preceding Reviews click used the pointer.
      await page.keyboard.press("Tab");
      const unknown = open.getByRole("button", { name: /Open example\/tools#504/ });
      await unknown.focus();
      await expect(unknown).toBeFocused();
      expect(await unknown.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
      // Checks nothing has looked up go unsaid, as in every other PR card.
      await expect(card).toContainText("example/tools#504");
      await expect(card).not.toContainText("Checks");
      await open.getByRole("button", { name: /Open example\/tools#503/ }).focus();
      await expect(card).toContainText("No checks");
      await open.getByRole("button", { name: /Open example\/tools#505/ }).focus();
      await expect(card).toContainText("Cached: Checks passing");
      const row = open.getByTestId("open-pr").filter({ hasText: "#501" });
      await expect(row.getByLabel("0 lines added")).toHaveText("+0");
      await expect(row.getByLabel("0 lines deleted")).toHaveText("−0");
      await row.getByRole("button", { name: /Open example\/tools#501/ }).focus();
      await expect(card).toContainText("helper[bot] · Bot");
      await expect(card).toContainText("Opened");
      await expect(card).toContainText("Activity");
      await expect(card).toContainText("Conflicts with its base");
      await card.screenshot({ path: info.outputPath(`card-${width}-${mode}.png`) });
    });
  }
}

test("local search, filters, sort, reset and keyboard context actions in both lists", async ({
  page,
}) => {
  await reviewsInPanel(page);
  await page.goto("/t/t-question");
  await populate(page);
  for (const label of ["Open PRs", "Review requests"]) {
    const section = page.getByRole("region", { name: label, exact: true });
    const rowId = label === "Open PRs" ? "open-pr" : "review-request";
    await section
      .getByRole("textbox", { name: `Search ${label}` })
      .fill("helper dependencies #501");
    await expect(section.getByTestId(rowId)).toHaveCount(1);
    await expect(section.getByRole("status")).toContainText("1 of");
    await section.getByRole("textbox", { name: `Search ${label}` }).fill("does not exist");
    await expect(section).toContainText("No PRs match this view.");
    await section.getByRole("button", { name: `Reset ${label} view` }).click();
    await section.getByRole("combobox", { name: `Filter ${label}` }).selectOption("unknown");
    await expect(section.getByTestId(rowId)).toHaveCount(2);
    await section.getByRole("button", { name: `Reset ${label} view` }).click();
    await section.getByRole("combobox", { name: `Sort ${label}` }).selectOption("oldest");
    await expect(section.getByTestId(rowId).first()).toContainText("#504");
    await section.getByRole("combobox", { name: `Sort ${label}` }).selectOption("size");
    await expect(section.getByTestId(rowId).first()).toContainText(
      label === "Open PRs" ? "#412" : "#502",
    );
    await section.getByTestId(rowId).first().getByRole("button").first().focus();
    await page.keyboard.press("Shift+F10");
    await expect(page.getByRole("menuitem", { name: "Open on GitHub" })).toBeVisible();
    await page.keyboard.press("Escape");
    // The pointer leaves the Reset button it clicked last, whose hint opens over Refresh above it.
    await page.mouse.move(0, 0);
    await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toHaveCount(0);
    const refresh = section.getByRole("button", { name: `Refresh ${label}` });
    await refresh.click();
    await expect(refresh).toBeEnabled();
    await expect(section.getByRole("combobox", { name: `Sort ${label}` })).toHaveValue("size");
  }
  // Local filtering never changes the server's notification/list settings.
  await page.goto("/settings/notifications");
  await expect(page.getByRole("switch", { name: /Direct requests only/ })).toBeChecked();
  await expect(page.getByRole("switch", { name: /Hide bot pull requests/ })).toBeChecked();
});

test("successful empty review snapshot is distinct from no match", async ({ page }) => {
  await reviewsInPanel(page);
  await page.goto("/t/t-question");
  const panel = await openReviewsTab(page);
  const count = panel.getByTestId("reviews-tab-count");
  await expect(count).toHaveText("2");
  await page.evaluate(() => window.gramMock?.replacePrLists({ requests: [], prs: [] }));
  const section = panel.getByTestId("review-requests");
  // The tab shows a count only while there is one.
  await expect(count).toHaveCount(0);
  await expect(section).toContainText("None right now.");
  await expect(section).not.toContainText("No PRs match");
});

test("populated right panel retains full labels, thread navigation and keyboard explanations", async ({
  page,
}, info) => {
  await reviewsInPanel(page);
  await page.goto("/t/t-question");
  await populate(page);
  const panel = page.getByTestId("right-panel");
  await expect(panel.getByTestId("open-pr")).toHaveCount(6);
  await expect(panel.getByTestId("review-request")).toHaveCount(5);
  const owned = panel.getByTestId("open-pr").filter({ hasText: "#412" });
  // A card opens on keyboard focus, so the focus comes from the keyboard first.
  await page.keyboard.press("Tab");
  await owned.getByRole("button", { name: /Open example\/api#412/ }).focus();
  const card = page.getByTestId("open-pr-card");
  await expect(card).toContainText("a-very-long-label-without-spaces-for-layout");
  await expect(card).toContainText("In the thread “Fix flaky retry test”");
  await card.screenshot({ path: info.outputPath("panel-full-labels-card.png") });
  await page.keyboard.press("Tab");
  await expect(
    owned.getByRole("button", { name: "Go to thread: Fix flaky retry test" }),
  ).toBeFocused();
  const threadHint = page.locator('[data-slot="tooltip-content"][data-open]');
  await expect(threadHint).toBeVisible();
  await expect(threadHint).toHaveText("Go to thread: Fix flaky retry test");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/t\/t-flaky$/);
  await expect(
    panel
      .getByTestId("review-request")
      .filter({ hasText: "#504" })
      .getByLabel(/lines added/),
  ).toHaveCount(0);
});

test("no-match and empty snapshots explain the local view clearly", async ({ page }, info) => {
  await reviewsInPanel(page);
  await page.goto("/t/t-question");
  await populate(page);
  const section = page.getByTestId("review-requests");
  await section.getByRole("textbox", { name: "Search Review requests" }).fill("missing label");
  await expect(section).toContainText("No PRs match this view.");
  await section.screenshot({ path: info.outputPath("no-match.png") });
  await page.evaluate(() => window.gramMock?.replacePrLists({ requests: [], prs: [] }));
  await expect(page.getByTestId("reviews-tab-count")).toHaveCount(0);
  await expect(section).toContainText("None right now.");
  await section.screenshot({ path: info.outputPath("empty.png") });
});
