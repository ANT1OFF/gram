import { expect, test, type Page } from "@playwright/test";
import { openReviewsTab, reviewsInPanel } from "./reviews-panel";
import { seedTheme } from "./seed-theme";

/**
 * Same explicit offline provider state and adversarial fixtures as the independent review, with
 * both PR lists in the right panel's Reviews tab, where they are listed in full, at `width`.
 */
async function openFixture(page: Page, width: number, mode: "light" | "dark") {
  await page.setViewportSize({ width: 1280, height: 720 });
  await seedTheme(page, { palette: "graphite", mode, motion: "off" });
  await reviewsInPanel(page, { requests: true, own: true, panelWidth: width });
  await page.addInitScript(() => {
    sessionStorage.setItem("gram.mock.agents", "");
    sessionStorage.setItem(
      "gram.mock.launchChecks",
      JSON.stringify({
        tools: [
          { tool: "git", found: true, path: "/fixture/git", version: "2.47.1" },
          { tool: "gh", found: true, path: "/fixture/gh", version: "2.63.0" },
          { tool: "claude", found: false },
          { tool: "codex", found: false },
        ],
        ghSignedIn: true,
        claudeSignIn: "signedOut",
        codexSignIn: "signedOut",
        agentsInUse: [],
      }),
    );
  });
  await page.goto("/t/t-question");
  await openReviewsTab(page);
  await expect(page.getByTestId("open-prs-count")).toHaveText("3");
}

async function replace(page: Page, labels = false) {
  await page.evaluate((longLabels) => {
    const pr = {
      repo: "example/api",
      number: 412,
      title: "Generated library changes",
      url: "https://github.com/example/api/pull/412",
      isDraft: false,
      author: "fixture-author",
      updatedAt: "2026-10-11T10:00:00Z",
      informationAt: "2026-10-11T10:00:00Z",
      createdAt: "2026-08-01T00:15:00Z",
      additions: longLabels ? 12 : 123456,
      deletions: longLabels ? 0 : 987654,
      checks: "failing" as const,
      reviewDecision: "CHANGES_REQUESTED",
      ...(longLabels
        ? {
            labels: Array.from(
              { length: 100 },
              (_, i) =>
                `label-${String(i).padStart(3, "0")}-offline-compatibility-regression-fixture`,
            ),
            labelsCount: 103,
          }
        : {}),
    };
    window.gramMock?.replacePrLists({ prs: [pr], requests: [pr] });
  }, labels);
  await expect(page.getByTestId("open-prs-count")).toHaveText("1");
  await expect(page.getByTestId("reviews-tab-count")).toHaveText("1");
}

for (const mode of ["light", "dark"] as const) {
  // The right panel's narrowest and its default.
  for (const width of [240, 352]) {
    test(`large counts at ${width}px in ${mode}`, async ({ page }, info) => {
      await openFixture(page, width, mode);
      await replace(page);
      for (const id of ["open-pr", "review-request"]) {
        const row = page.getByTestId(id);
        await row.scrollIntoViewIfNeeded();
        await row.screenshot({ path: info.outputPath(`${id}.png`) });
        await expect(row.getByLabel("123456 lines added")).toHaveText("+123,456");
        await expect(row.getByLabel("987654 lines deleted")).toHaveText("−987,654");
        const bounds = await row.evaluate((element) => {
          const rectangles = [
            element,
            element.querySelector('[aria-label$="lines added"]')!,
            element.querySelector('[aria-label$="lines deleted"]')!,
            element.querySelector('[aria-label^="Last activity"]')!,
          ].map((node) => {
            const box = node.getBoundingClientRect();
            return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
          });
          return {
            row: rectangles[0]!,
            added: rectangles[1]!,
            deleted: rectangles[2]!,
            age: rectangles[3]!,
          };
        });
        console.log(JSON.stringify({ id, width, mode, bounds }));
        for (const count of [bounds.added, bounds.deleted]) {
          expect(count.left).toBeGreaterThanOrEqual(bounds.row.left);
          expect(count.right).toBeLessThanOrEqual(bounds.row.right);
          expect(count.bottom - count.top).toBeLessThanOrEqual(bounds.age.bottom - bounds.age.top);
          const separated =
            count.right <= bounds.age.left ||
            count.left >= bounds.age.right ||
            count.bottom <= bounds.age.top ||
            count.top >= bounds.age.bottom;
          expect(
            separated,
            `signed count must not overlap activity: ${JSON.stringify(bounds)}`,
          ).toBe(true);
        }
      }
    });

    for (const [label, rowId, cardId] of [
      ["Open PRs", "open-pr", "open-pr-card"],
      ["Review requests", "review-request", "review-request-card"],
    ] as const) {
      test(`labels card ${label} at ${width}px in ${mode}`, async ({ page }, info) => {
        await openFixture(page, width, mode);
        await replace(page, true);
        const row = page.getByTestId(rowId);
        const trigger = row.getByRole("button").first();
        await page.keyboard.press("Tab");
        await trigger.focus();
        const card = page.getByTestId(cardId);
        await expect(card).toBeVisible();
        await expect(card).toContainText("label-099");
        await expect(card).toContainText("3 more labels not loaded");
        await page.screenshot({ path: info.outputPath("viewport.png") });
        const bounds = await card.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return {
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
            viewportHeight: innerHeight,
            viewportWidth: innerWidth,
            documentHeight: document.documentElement.scrollHeight,
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
          };
        });
        console.log(JSON.stringify({ label, width, mode, bounds }));
        expect(bounds.top).toBeGreaterThanOrEqual(0);
        expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight);
        expect(bounds.left).toBeGreaterThanOrEqual(0);
        expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth);
        expect(bounds.documentHeight).toBe(bounds.viewportHeight);
        expect(bounds.scrollHeight).toBeGreaterThan(bounds.clientHeight);
        await trigger.press("ArrowDown");
        await expect(card).toBeFocused();
        await card.press("PageDown");
        await expect.poll(() => card.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        await card.press("End");
        await expect.poll(() => card.evaluate((element) => element.scrollTop)).toBeGreaterThan(900);
        await expect
          .poll(() =>
            card.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeLessThanOrEqual(1);
        for (const text of ["Opened", "Activity", "Checks failing", "Changes requested"]) {
          const detail = card.getByText(text, {
            exact: text === "Checks failing" || text === "Changes requested",
          });
          await expect(detail).toBeVisible();
          const box = await detail.boundingBox();
          expect(box!.y).toBeGreaterThanOrEqual(bounds.top);
          expect(box!.y + box!.height).toBeLessThanOrEqual(bounds.bottom);
        }
        if (rowId === "open-pr") {
          const owner = card.getByText("In the thread “Fix flaky retry test”");
          await expect(owner).toBeVisible();
          const box = await owner.boundingBox();
          expect(box!.y).toBeGreaterThanOrEqual(bounds.top);
          expect(box!.y + box!.height).toBeLessThanOrEqual(bounds.bottom);
        }
        expect(await page.evaluate(() => scrollY)).toBe(0);
        await page.screenshot({ path: info.outputPath("scrolled-metadata.png") });
        await card.press("Escape");
        await expect(trigger).toBeFocused();
        await expect(card).not.toBeVisible();
        await trigger.press("Shift+F10");
        await expect(page.getByRole("menuitem", { name: "Open on GitHub" })).toBeVisible();
        await page.keyboard.press("Escape");
      });
    }
  }
}
