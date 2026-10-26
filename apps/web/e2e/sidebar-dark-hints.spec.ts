import { PRESET_PALETTES } from "@gram/themes";
import { expect, test, type Locator } from "@playwright/test";

import { openOverviewDensity } from "./overview-density";
import { seedTheme } from "./seed-theme";

const luminance = (color: string) =>
  color
    .match(/[\d.]+/g)!
    .slice(0, 3)
    .map(Number)
    .map((value) => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    })
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);

async function colors(hint: Locator) {
  const sample = await hint.evaluate((element) => {
    const style = getComputedStyle(element);
    const arrow = getComputedStyle(element.lastElementChild!);
    const child = element.querySelector("kbd") ?? element.querySelector("span:last-of-type");
    const childStyle = child ? getComputedStyle(child) : undefined;
    return {
      background: style.backgroundColor,
      foreground: style.color,
      arrowBackground: arrow.backgroundColor,
      arrowFill: arrow.fill,
      borderWidth: style.borderWidth,
      borderColor: style.borderColor,
      shadow: style.boxShadow,
      childColor: childStyle?.color,
      separator: childStyle?.borderTopColor,
      duration: style.transitionDuration,
      box: {
        left: element.getBoundingClientRect().left,
        right: element.getBoundingClientRect().right,
        top: element.getBoundingClientRect().top,
        bottom: element.getBoundingClientRect().bottom,
      },
    };
  });
  const background = luminance(sample.background);
  const contrast = (color: string) => {
    const foreground = luminance(color);
    return (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05);
  };
  return {
    ...sample,
    luminance: background,
    contrast: contrast(sample.foreground),
    childContrast: sample.childColor ? contrast(sample.childColor) : undefined,
  };
}

// The quiet hint panel behind the overview header's icons, Usage and Settings: readable and
// arrowed in its own colours in every palette, by hover and by real keyboard focus.

for (const mode of ["light", "dark"] as const) {
  test(`shared icon hints in ${mode}`, async ({ page }) => {
    await seedTheme(page, { palette: "minimal-ocean", mode, motion: "reduced" });
    await page.clock.setFixedTime(new Date("2026-06-15T08:00:00Z"));
    await openOverviewDensity(page, 280);
    const hint = page.locator('[data-slot="tooltip-content"][data-open]');
    const sidebar = page.getByTestId("overview-sidebar");
    const settings = sidebar.getByRole("button", { name: "Settings", exact: true });
    await settings.hover();
    await expect(hint).toHaveText(/^Settings \(.+\)$/);
    await expect(hint).toHaveCSS("opacity", "1");
    await page.screenshot({ path: test.info().outputPath(`${mode}-icon-hover.png`) });
    const icon = await colors(hint);
    await test.info().attach("hint-colors", {
      body: JSON.stringify({ icon }, null, 2),
      contentType: "application/json",
    });
    expect(icon.contrast).toBeGreaterThanOrEqual(4.5);
    expect(icon.arrowBackground).toBe(icon.background);
    expect(icon.arrowFill).toBe(icon.background);
    expect(icon.box.left).toBeGreaterThanOrEqual(0);
    expect(icon.box.right).toBeLessThanOrEqual(1440);
    expect(icon.box.top).toBeGreaterThanOrEqual(0);
    expect(icon.box.bottom).toBeLessThanOrEqual(1400);
    if (mode === "dark") {
      expect(icon.luminance).toBeLessThan(0.15);
      expect(icon.borderWidth).toBe("1px");
      expect(icon.shadow).not.toBe("none");
    } else {
      expect(icon.background).toBe("rgb(12, 14, 18)");
      expect(icon.foreground).toBe("rgb(255, 255, 255)");
    }
    await page.mouse.move(1000, 1000);
    await expect(hint).toHaveCount(0);
    await sidebar.getByRole("button", { name: "Usage", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(settings).toBeFocused();
    await expect(hint).toHaveText(/^Settings \(.+\)$/);
    await page.keyboard.press("Escape");
    await expect(hint).toHaveCount(0);
    await expect(settings).toBeFocused();
  });
}

test("all built-in dark palettes keep readable quiet hint panels across appearances and contrast", async ({
  page,
}) => {
  await seedTheme(page, { palette: "minimal-ocean", mode: "dark", motion: "off" });
  await openOverviewDensity(page, 280);
  await page
    .getByTestId("overview-sidebar")
    .getByRole("button", { name: "Settings", exact: true })
    .hover();
  const hint = page.locator('[data-slot="tooltip-content"][data-open]');
  await expect(hint).toContainText("Settings");
  const samples = [];
  for (const palette of PRESET_PALETTES.filter((item) => item.mode === "dark")) {
    for (const look of ["glass"]) {
      for (const contrast of ["standard", "more"]) {
        await page.evaluate(
          ({ palette: paletteId, look: appearance, contrast: level }) => {
            const root = document.documentElement;
            root.dataset.palette = paletteId;
            root.dataset.look = appearance;
            root.dataset.contrast = level;
          },
          { palette: palette.id, look, contrast },
        );
        const sample = await colors(hint);
        expect(sample.luminance, `${palette.id}/${look}/${contrast}`).toBeLessThan(0.15);
        expect(sample.contrast).toBeGreaterThanOrEqual(contrast === "more" ? 7 : 4.5);
        expect(sample.arrowBackground).toBe(sample.background);
        expect(sample.arrowFill).toBe(sample.background);
        samples.push({ palette: palette.id, look, contrastPreference: contrast, ...sample });
      }
    }
  }
  await test.info().attach("dark-palette-appearance-contrast-matrix", {
    body: JSON.stringify(samples, null, 2),
    contentType: "application/json",
  });
});
