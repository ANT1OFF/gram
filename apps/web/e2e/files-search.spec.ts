import { expect, test } from "@playwright/test";

import { clipboardText } from "./clipboard";

test("searches file contents and previews a result at its line", async ({ page }) => {
  await page.goto("/t/t-flaky");
  // t-flaky's autoplay stops at an approval, whose Enter shortcut must not take Enter from a result.
  const approval = page.getByTestId("approval-card");
  await expect(approval).toBeVisible();
  const panel = page.getByTestId("right-panel");
  await panel.getByRole("tab", { name: "Files", exact: true }).click();
  const files = page.getByTestId("files-panel");

  // A leading `?` turns the filter into a contents search.
  await files.getByRole("textbox", { name: "Filter files" }).fill("?sleep");
  const input = files.getByRole("textbox", { name: "Search in files" });
  await expect(files.getByRole("status")).toHaveText(/^\d+ results? in \d+ files?$/);
  const list = files.getByRole("list", { name: "Search results" });
  await expect(list.getByRole("button", { name: /src\/clock\.ts, line 1:/ })).toBeVisible();

  await input.press("ArrowDown");
  await expect(list.getByRole("button", { name: /src\/clock\.ts, line 1:/ })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(list.getByRole("button", { name: /src\/retry\.ts, line 1:/ })).toBeFocused();
  await page.keyboard.press("Enter");

  const preview = page.getByTestId("file-preview");
  await expect(preview).toBeVisible();
  await expect(preview.locator("[data-highlighted]")).toContainText("sleep");
  await expect(approval).toBeVisible();

  await files.getByRole("button", { name: "Regular expression" }).click();
  await input.fill("?sle+p(");
  await expect(files.getByRole("alert")).toContainText("Invalid regular expression");
});

test("opens a file the agent mentions at its lines, and in the editor with ⌘ or Ctrl", async ({
  page,
}) => {
  // Short enough that the preview has to scroll to reach line 15.
  await page.setViewportSize({ width: 1280, height: 560 });
  await page.goto("/t/t-deps");
  await page
    .getByLabel("Message", { exact: true })
    .fill("Look at `src/retry.ts:15-16`, [the clock](src/clock.ts#L1), src/nope.ts and /etc/hosts");
  await page.keyboard.press("Enter");
  const reply = page.getByTestId("message-assistant").filter({ hasText: "Mock reply" });
  const links = reply.getByTestId("file-ref");
  await expect(links).toHaveCount(2);
  // A path that names no file stays plain text, and one outside the checkout until pointed at.
  await expect(reply).toContainText("src/nope.ts and /etc/hosts");

  const retry = links.filter({ hasText: "src/retry.ts:15-16" });
  await expect(retry).toHaveAttribute("data-resolved", /\/src\/retry\.ts$/);
  await retry.focus();
  await page.keyboard.press("Enter");
  const preview = page.getByTestId("file-preview");
  await expect(preview).toContainText("src/retry.ts");
  const highlighted = preview.locator("[data-highlighted]");
  await expect(highlighted).toHaveCount(2);
  await expect(highlighted.first()).toContainText("lastError = error");
  await expect(highlighted.first()).toBeInViewport();
  await expect
    .poll(() =>
      preview
        .locator(".overflow-auto")
        .first()
        .evaluate((el) => el.scrollTop),
    )
    .toBeGreaterThan(0);

  const clock = links.filter({ hasText: "the clock" });
  await clock.click({ modifiers: ["ControlOrMeta"] });
  await expect
    .poll(() => page.evaluate(() => window.gramMock?.editorOpens.at(-1)))
    .toMatchObject({ path: expect.stringMatching(/\/src\/clock\.ts$/), line: 1 });
  await expect(preview).toContainText("src/retry.ts");

  await clock.click();
  await expect(preview).toContainText("src/clock.ts");
});

test.describe("a path the agent wrote outside the checkout", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("reaches and opens it from the keyboard before and after it resolves", async ({ page }) => {
    await page.goto("/t/t-deps");
    await page
      .getByLabel("Message", { exact: true })
      .fill(
        "Wrote `/tmp/browser-research/REPORT.md`, /tmp/browser-research/notes.txt:3 and `/tmp/browser-research/login.png`",
      );
    await page.keyboard.press("Enter");
    const reply = page.getByTestId("message-assistant").filter({ hasText: "Mock reply" });
    const candidates = reply.getByTestId("file-ref-candidate");
    await expect(candidates).toHaveCount(3);

    // Focus asks about it, and the link it becomes keeps the focus.
    await candidates.filter({ hasText: "REPORT.md" }).focus();
    const report = reply.getByTestId("file-ref").filter({ hasText: "REPORT.md" });
    await expect(report).toBeFocused();
    await page.keyboard.press("Enter");
    const preview = page.getByTestId("file-preview");
    await expect(preview.getByTestId("markdown-preview")).toContainText("Browser research");

    // Enter on a path not yet known opens it once it is.
    const notes = candidates.filter({ hasText: "notes.txt:3" });
    await notes.focus();
    await page.keyboard.press("Enter");
    await expect(preview).toContainText("/tmp/browser-research/notes.txt");
    await expect(preview.locator("[data-highlighted]")).toContainText("three");

    // ⌘ or Ctrl on a path not yet known opens it in the editor once it is, as on a link.
    await candidates.filter({ hasText: "login.png" }).click({ modifiers: ["ControlOrMeta"] });
    await expect
      .poll(() => page.evaluate(() => window.gramMock?.editorOpens.at(-1)))
      .toEqual({ path: "/tmp/browser-research/login.png" });
    await expect(preview).toContainText("/tmp/browser-research/notes.txt");
  });

  test("previews it from a click or its menu, and only reveals or copies a credential file", async ({
    page,
  }) => {
    await page.goto("/t/t-deps");
    await page
      .getByLabel("Message", { exact: true })
      .fill(
        "Wrote `/tmp/browser-research/REPORT.md`, /tmp/browser-research/notes.txt:3, `/tmp/gone/missing.md` and `~/.aws/credentials`",
      );
    await page.keyboard.press("Enter");
    const reply = page.getByTestId("message-assistant").filter({ hasText: "Mock reply" });
    const candidates = reply.getByTestId("file-ref-candidate");
    // Nothing is asked about until a path is pointed at.
    await expect(candidates).toHaveCount(4);
    await expect(reply.getByTestId("file-ref")).toHaveCount(0);

    await candidates.filter({ hasText: "REPORT.md" }).hover();
    const report = reply.getByTestId("file-ref").filter({ hasText: "REPORT.md" });
    await expect(report).toHaveAttribute("data-resolved", "/tmp/browser-research/REPORT.md");
    await report.click();
    const preview = page.getByTestId("file-preview");
    await expect(preview).toContainText("/tmp/browser-research/REPORT.md");
    await expect(preview.getByTestId("markdown-preview")).toContainText("Browser research");
    // Only paths the thread wrote are read outside the checkout, so its image stays a placeholder.
    await expect(preview.getByTestId("markdown-preview")).toContainText("[Login page]");
    await expect(preview.getByTestId("checkout-image")).toHaveCount(0);

    await candidates.filter({ hasText: "notes.txt:3" }).click();
    await expect(preview).toContainText("/tmp/browser-research/notes.txt");
    await expect(preview.locator("[data-highlighted]")).toContainText("three");

    // A path that names no file goes back to plain text once it's been pointed at.
    await candidates.filter({ hasText: "missing.md" }).hover();
    await expect(candidates.filter({ hasText: "missing.md" })).toHaveCount(0);
    await expect(reply.getByTestId("file-ref").filter({ hasText: "missing.md" })).toHaveCount(0);
    await expect(reply).toContainText("/tmp/gone/missing.md");

    const menu = page.getByTestId("file-ref-menu");
    await report.click({ button: "right" });
    await expect(menu.getByRole("button", { name: "Open preview" })).toBeVisible();
    await expect(menu.getByRole("button", { name: "Open in editor" })).toBeVisible();
    await menu.getByRole("button", { name: "Copy path" }).click();
    await expect.poll(() => clipboardText(page)).toBe("/tmp/browser-research/REPORT.md");
    // Copying closes the menu; it fades out before the next one opens, or there would be two.
    await expect(menu).toHaveCount(0);

    await candidates.filter({ hasText: "credentials" }).hover();
    const secret = reply.getByTestId("file-ref").filter({ hasText: "credentials" });
    await expect(secret).toHaveAttribute("data-secret", "true");
    await secret.click();
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("button", { name: "Open preview" })).toHaveCount(0);
    await expect(menu.getByRole("button", { name: "Open in editor" })).toHaveCount(0);
    await expect(menu.getByRole("button", { name: "Copy path" })).toBeVisible();
    await menu.getByRole("button", { name: /^(Reveal|Show) in / }).click();
    await expect
      .poll(() => page.evaluate(() => window.gramMock?.reveals.at(-1)))
      .toEqual({ path: "/Users/dev/.aws/credentials" });
    await expect(preview).toContainText("/tmp/browser-research/notes.txt");
  });
});
