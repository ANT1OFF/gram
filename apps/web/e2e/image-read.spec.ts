import { expect, test, type Page } from "@playwright/test";
import type { GramUIMessage } from "@gram/contracts";

import { MOCK_TOOL_IMAGE } from "../src/api/mock-files";

const path = MOCK_TOOL_IMAGE.path;
const name = path.split("/").at(-1)!;
const history: GramUIMessage[] = [
  {
    id: "image-source",
    role: "user",
    parts: [{ type: "file", url: `file://${path}`, mediaType: "image/png", filename: name }],
  },
  {
    id: "image-read-history",
    role: "assistant",
    metadata: { agent: "codex" },
    parts: [
      {
        type: "dynamic-tool",
        toolName: "Read",
        toolCallId: "native-image",
        state: "output-available",
        input: { file_path: path },
        output: { type: "image", path },
        providerExecuted: true,
      },
      { type: "text", text: "The provider viewed this image." },
      {
        type: "dynamic-tool",
        toolName: "Read",
        toolCallId: "historical-image",
        state: "output-available",
        input: { file_path: path },
        output: {},
        providerExecuted: true,
      },
      { type: "text", text: "An older saved image read." },

      { type: "text", text: "A persisted MCP image block." },
      {
        type: "dynamic-tool",
        toolName: "mcp__synthetic__view_image",
        toolCallId: "inline-image",
        state: "output-available",
        input: {},
        output: {
          content: [
            { type: "image", mimeType: "image/png", data: MOCK_TOOL_IMAGE.base64 },
            { type: "text", text: "Saved image metadata" },
          ],
        },
        providerExecuted: true,
      },
      { type: "text", text: "An unavailable source." },
      {
        type: "dynamic-tool",
        toolName: "Read",
        toolCallId: "missing-image",
        state: "output-available",
        input: { file_path: "/unattached/missing.png" },
        output: { type: "image", path: "/unattached/missing.png" },
        providerExecuted: true,
      },
    ],
  },
];

/** Mock feeds reset on navigation: restore the same serialized server history, without a turn. */
async function restore(page: Page) {
  await page.getByLabel("Message", { exact: true }).waitFor();
  await page.evaluate(() => {
    const saved = JSON.parse(sessionStorage.getItem("gram.test.image-read-history")!);
    for (const message of saved) window.gramMock!.simulateMessage("t-deps" as never, message);
  });
}

for (const width of [1440, 390]) {
  test(`Codex image Read previews open and survive restored history at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/t/t-deps");
    await page.evaluate(
      (saved) => sessionStorage.setItem("gram.test.image-read-history", saved),
      JSON.stringify(history),
    );
    await restore(page);
    const card = page.locator('[data-tool-call-id="native-image"]');
    const thumbnail = card.getByRole("button", { name: `Open ${name}`, exact: true });
    const image = thumbnail.getByRole("img", { name, exact: true });
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0))
      .toBe(true);
    await card.getByRole("button", { name: /Read/ }).click();
    await expect(card.getByTestId("tool-images")).toHaveAttribute("data-size", "large");
    await expect(card).toContainText('"type": "image"');
    const bounds = (await image.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await thumbnail.focus();
    await thumbnail.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toContainText(
      "Preview of the current attached source",
    );
    await thumbnail.press("Enter");
    const lightbox = page.getByTestId("attachment-lightbox");
    await expect(lightbox.getByRole("img", { name, exact: true })).toBeVisible();
    await expect(lightbox).toHaveCSS("opacity", "1");
    await page.screenshot({ path: testInfo.outputPath(`image-read-open-${width}.png`) });
    await page.keyboard.press("Escape");
    await expect(lightbox).toBeHidden();
    await expect(page.locator('[data-tool-call-id="missing-image"]')).toContainText(
      "Image preview unavailable",
    );
    const historical = page.locator('[data-tool-call-id="historical-image"]');
    await historical.getByRole("button", { name: /Read/ }).click();
    await expect(historical).toContainText("No result details were provided.");
    await expect(historical.getByRole("img", { name, exact: true })).toBeVisible();
    await expect(historical.getByRole("button", { name: /Read/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await page.screenshot({ path: testInfo.outputPath(`image-read-card-${width}.png`) });

    const inline = page.locator('[data-tool-call-id="inline-image"]');
    await inline.getByRole("button", { name: /^mcp__synthetic/ }).click();
    await expect(inline).toContainText("Saved image metadata");
    await expect(inline).not.toContainText(MOCK_TOOL_IMAGE.base64);
    const inlineImage = inline.getByRole("img");
    await expect
      .poll(() =>
        inlineImage.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0),
      )
      .toBe(true);
    await page.reload();
    await restore(page);
    await expect(inline.getByRole("img")).toBeVisible();
    await expect(image).toBeVisible();
    await thumbnail.click();
    await expect(lightbox.getByRole("img", { name, exact: true })).toBeVisible();
    await expect(lightbox).toHaveCSS("opacity", "1");
    await page.screenshot({ path: testInfo.outputPath(`image-read-reload-${width}.png`) });
  });
}
