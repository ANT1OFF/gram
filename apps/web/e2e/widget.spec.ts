import { expect, test } from "@playwright/test";

test("a chart the agent draws renders as an image, in the theme, and opens full size", async ({
  page,
}) => {
  await page.goto("/t/t-deps");
  const composer = page.getByLabel("Message", { exact: true });
  await composer.fill("draw a chart of latency");
  await composer.press("ControlOrMeta+Enter");

  const widget = page.getByTestId("widget");
  const image = widget.getByRole("img", { name: "p95 latency by region" });
  await expect(image).toBeVisible();
  // The browser decoded the SVG: a data URL the CSP refused or a malformed document has no size.
  await expect
    .poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth))
    .toBe(480);
  const source = decodeURIComponent((await image.getAttribute("src")) ?? "");
  expect(source).toMatch(/<style>:root\{[^}]*--accent:[^;}]+/);
  // The drawing never becomes markup in the page.
  await expect(widget.locator("svg")).toHaveCount(0);

  await widget.getByRole("button", { name: "Open p95 latency by region" }).click();
  await expect(page.getByTestId("widget-full")).toBeVisible();
});
