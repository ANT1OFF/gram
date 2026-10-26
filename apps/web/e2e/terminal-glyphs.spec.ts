import { writeFile } from "node:fs/promises";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { terminalText } from "./terminal";

const ICONS = "\uf109 \uf2db \uf108 \uf0a0 \ue70f \uf489 \u{f02e0} \ue0b0";
const GLYPHS = `ICONS: ${ICONS} \uefff`;

type ResizeReceipt = { terminalId: string; cols: number; rows: number };
const captureResizes = async (page: Page) => {
  await page.waitForFunction(() => window.gramMock !== undefined);
  await page.evaluate(() => {
    const api = window.gramMock!;
    const resize = api.terminalResize;
    const receipts: ResizeReceipt[] = [];
    api.terminalResize = async (id, cols, rows) => {
      receipts.push({ terminalId: id, cols, rows });
      document.documentElement.dataset["terminalResizes"] = JSON.stringify(receipts);
      await resize(id, cols, rows);
    };
  });
};
const resizeReceipts = (page: Page) =>
  page.evaluate(
    () =>
      JSON.parse(document.documentElement.dataset["terminalResizes"] ?? "[]") as ResizeReceipt[],
  );

const gridGeometry = (terminal: Locator) =>
  terminal.getByTestId("terminal-surface").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      cols: Number((element as HTMLElement).dataset["cols"]),
      rows: Number((element as HTMLElement).dataset["rows"]),
      fontSize: Number((element as HTMLElement).dataset["fontSize"]),
      container: { width: rect.width, height: rect.height },
    };
  });

const openTerminal = async (page: Page, beforeOpen?: () => Promise<void>) => {
  await page.addInitScript(() => {
    sessionStorage.setItem(
      "gram.mock.settings",
      JSON.stringify({ fonts: { mono: "Geist Mono Variable", monoSize: 16 } }),
    );
  });
  await page.goto("/t/t-flaky", { waitUntil: "domcontentloaded" });
  await beforeOpen?.();
  const panel = page.getByTestId("right-panel");
  await panel.getByRole("tab", { name: "Terminal", exact: true }).click();
  const terminal = panel.getByTestId("terminal").first();
  await expect(terminalText(terminal)).toContainText("$", { timeout: 15_000 });
  await terminal.getByTestId("terminal-surface").click();
  return terminal;
};

const write = async (page: Page, terminal: Locator, text: string) => {
  // insertText exercises Gram's beforeinput path, including supplementary private-use glyphs.
  await page.keyboard.insertText(text);
  await page.keyboard.press("Enter");
  await expect(terminalText(terminal)).toContainText(`echo: ${text}`);
};

/** Compare actual renderer pixels, not CSS names or the accessibility text mirror. */
const glyphPixels = (terminal: Locator) =>
  terminal.getByTestId("terminal-surface").evaluate((element) => {
    const canvas = element.querySelector("canvas")!;
    const ctx = canvas.getContext("2d")!;
    const lines = element.querySelector("[data-terminal-text]")!.textContent!.split("\n");
    const row = lines.findIndex((line) => line.startsWith("echo: ICONS:"));
    if (row < 0) throw new Error("glyph fixture is not visible");
    const line = [...lines[row]!];
    const width = canvas.width / Number((element as HTMLElement).dataset["cols"]);
    const height = canvas.height / Number((element as HTMLElement).dataset["rows"]);
    const pixels = (glyph: string) =>
      Array.from(ctx.getImageData(line.indexOf(glyph) * width, row * height, width, height).data);
    const icons = [
      "\uf109",
      "\uf2db",
      "\uf108",
      "\uf0a0",
      "\ue70f",
      "\uf489",
      "\u{f02e0}",
      "\ue0b0",
    ];
    const control = JSON.stringify(pixels("\uefff"));
    const textFamily = getComputedStyle(document.documentElement).getPropertyValue("--font-mono");
    const measured = document.createElement("canvas").getContext("2d")!;
    measured.font = `16px ${textFamily}`;
    const textWidth = measured.measureText("M").width;
    measured.font = `16px ${textFamily}, "Symbols Nerd Font Mono"`;
    return {
      matchesMissing: icons.map((glyph) => JSON.stringify(pixels(glyph)) === control),
      icons: icons.map((glyph) => JSON.stringify(pixels(glyph))),
      textWidth,
      fallbackTextWidth: measured.measureText("M").width,
      cellWidth: width / devicePixelRatio,
      textFamily,
    };
  });

for (const dpr of [1, 2]) {
  test.describe(`terminal symbols at DPR ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });
    test("renders bundled icons while retaining the selected text font and Unicode", async ({
      page,
    }, testInfo) => {
      const terminal = await openTerminal(page);
      await write(page, terminal, "ASCII: 0123456789 | text");
      await write(page, terminal, "┌──┬──┐ ⣿⣷⣤⠉ 中文 |");
      await write(page, terminal, GLYPHS);
      await expect
        .poll(async () => (await glyphPixels(terminal)).matchesMissing)
        .toEqual(Array(8).fill(false));
      const result = await glyphPixels(terminal);
      expect(new Set(result.icons).size).toBe(8);
      expect(result.fallbackTextWidth).toBe(result.textWidth);
      expect(result.cellWidth).toBe(Math.ceil(result.textWidth));
      expect(result.textFamily).toContain("Geist Mono Variable");
      expect(result.textFamily).not.toContain("Symbols Nerd Font");
      await terminal.screenshot({ path: testInfo.outputPath("terminal-glyphs.png") });
      const notice = page.locator("link[data-terminal-font-license]");
      await expect(notice).toHaveAttribute("rel", "license");
      const response = await page.request.get((await notice.getAttribute("href"))!);
      expect(response.ok()).toBe(true);
      const body = await response.text();
      for (const required of [
        "SIL OPEN FONT LICENSE",
        "Attribution 4.0 International",
        "Apache License",
        "public domain",
        "Copyright (c) 2023 GitHub Inc.",
      ]) {
        expect(body).toContain(required);
      }
    });
  });
}

test("a stalled symbols request keeps the shell usable and repaints when it finishes", async ({
  page,
}, testInfo) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/SymbolsNerdFontMono-Regular*.ttf*", async (route) => {
    if (route.request().resourceType() !== "font") return route.continue();
    await held;
    await route.continue();
  });
  try {
    const terminal = await openTerminal(page);
    await write(page, terminal, GLYPHS);
    await expect
      .poll(async () => (await glyphPixels(terminal)).matchesMissing)
      .toEqual(Array(8).fill(true));
    // Playwright screenshots wait for all fonts. Export the actual Canvas while this request
    // is deliberately held, so recording the before image does not wait for its own release.
    const pending = await terminal
      .locator("canvas")
      .evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL("image/png").split(",")[1]!);
    await writeFile(testInfo.outputPath("font-pending.png"), Buffer.from(pending, "base64"));
    release();
    await expect
      .poll(async () => (await glyphPixels(terminal)).matchesMissing)
      .toEqual(Array(8).fill(false));
    await terminal.screenshot({ path: testInfo.outputPath("font-loaded.png") });
    // Input, fit/zoom and search still operate after the late repaint.
    const surface = terminal.getByTestId("terminal-surface");
    // Zoom refits the grid; which of its sides changes depends on the font's cell metrics.
    const grid = async () =>
      `${await surface.getAttribute("data-cols")}×${await surface.getAttribute("data-rows")}`;
    const size = await surface.getAttribute("data-font-size");
    const fitted = await grid();
    await page.keyboard.press("ControlOrMeta+Equal");
    await expect(surface).not.toHaveAttribute("data-font-size", size!);
    await expect.poll(grid).not.toBe(fitted);
    await page.keyboard.press("ControlOrMeta+Minus");
    await expect(surface).toHaveAttribute("data-font-size", size!);
    await expect.poll(grid).toBe(fitted);
    await page.keyboard.press("ControlOrMeta+KeyF");
    await terminal.getByRole("textbox", { name: "Find in terminal" }).fill("ICONS");
    await expect(terminal.locator("[data-terminal-find-match]")).toHaveCount(2);
    await page.keyboard.press("Escape");
    await write(page, terminal, "still-usable");
  } finally {
    release();
  }
});

test("a failed symbols request leaves terminal input and text usable", async ({ page }) => {
  await page.route("**/SymbolsNerdFontMono-Regular*.ttf*", (route) =>
    route.request().resourceType() === "font" ? route.abort() : route.continue(),
  );
  const terminal = await openTerminal(page);
  await write(page, terminal, "font-failure-shell-usable");
});

for (const hidden of [false, true]) {
  test(`a late text font updates the PTY grid ${hidden ? "only after reactivation" : "without a container resize"}`, async ({
    page,
  }, testInfo) => {
    const terminal = await openTerminal(page, () => captureResizes(page));
    await write(page, terminal, "needle-late-font");
    const terminalId = await page.evaluate(
      async () => (await window.gramMock!.terminalList())[0]!.terminalId,
    );
    const initial = await gridGeometry(terminal);
    expect((await resizeReceipts(page)).at(-1)).toEqual({
      terminalId,
      cols: initial.cols,
      rows: initial.rows,
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/vt323-*.woff2*", async (route) => {
      if (route.request().resourceType() !== "font") return route.continue();
      await held;
      await route.continue();
    });
    const bar = terminal.getByTestId("terminal-find-bar");
    try {
      await page.keyboard.press("ControlOrMeta+KeyF");
      await bar.getByRole("textbox", { name: "Find in terminal" }).fill("needle");
      await page.evaluate(() =>
        document.documentElement.style.setProperty("--font-mono", '"VT323", monospace'),
      );
      await bar.getByRole("button", { name: "Match case" }).click();
      await expect
        .poll(() =>
          terminal
            .locator("canvas")
            .evaluate((canvas: HTMLCanvasElement) => canvas.getContext("2d")!.font),
        )
        .toContain("VT323");
      expect(await page.evaluate(() => document.fonts.check('16px "VT323"', "M"))).toBe(false);
      await page.evaluate(() => window.gramMock!.updateSettings({ fonts: { mono: "VT323" } }));
      // A newer size while the family is still loading must survive completion of both loads.
      await page.keyboard.press("Escape");
      await terminal.getByTestId("terminal-surface").click();
      await page.keyboard.press("ControlOrMeta+Equal");
      await expect(terminal.getByTestId("terminal-surface")).toHaveAttribute(
        "data-font-size",
        "17",
      );
      await expect
        .poll(() =>
          terminal
            .locator("canvas")
            .evaluate((canvas: HTMLCanvasElement) => canvas.getContext("2d")!.font),
        )
        .toContain("VT323");
      expect(await page.evaluate(() => document.fonts.check('17px "VT323"', "M"))).toBe(false);
      await page.keyboard.press("ControlOrMeta+KeyF");
      await bar.getByRole("textbox", { name: "Find in terminal" }).fill("needle");
      await expect(terminal.locator("[data-terminal-find-match]")).toHaveCount(2);
      if (hidden) {
        await page.getByRole("button", { name: "New terminal" }).click();
        await expect(page.getByRole("tab", { name: "Terminal 2", exact: true })).toHaveAttribute(
          "aria-selected",
          "true",
        );
      }
      const before = await gridGeometry(terminal);
      const beforeReceipts = (await resizeReceipts(page)).filter(
        (receipt) => receipt.terminalId === terminalId,
      );
      expect(before.container.width).toBeGreaterThan(0);
      expect(before.container.height).toBeGreaterThan(0);
      release();
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
      });
      await expect.poll(async () => (await gridGeometry(terminal)).cols).not.toBe(before.cols);
      const after = await gridGeometry(terminal);
      expect(after.container).toEqual(before.container);
      expect(after.fontSize).toBe(17);
      if (hidden) {
        expect(
          (await resizeReceipts(page)).filter((receipt) => receipt.terminalId === terminalId),
        ).toEqual(beforeReceipts);
        await page.getByRole("tab", { name: "Terminal 1", exact: true }).click();
      }
      const receipts = (await resizeReceipts(page)).filter(
        (receipt) => receipt.terminalId === terminalId,
      );
      expect(receipts.slice(beforeReceipts.length)).toEqual([
        { terminalId, cols: after.cols, rows: after.rows },
      ]);
      const canvas = (await terminal.locator("canvas").boundingBox())!;
      const match = (await terminal.locator("[data-terminal-find-match]").first().boundingBox())!;
      expect(match.width).toBeCloseTo((6 * canvas.width) / after.cols, 0);
      expect(match.height).toBeCloseTo(canvas.height / after.rows, 0);
      await terminal.screenshot({ path: testInfo.outputPath("late-text-font.png") });
      await writeFile(
        testInfo.outputPath("late-text-font.json"),
        JSON.stringify({ hidden, before, after, receipts }, null, 2),
      );
      // The existing container-resize path still reaches the same PTY boundary.
      await page.setViewportSize({ width: 1280, height: 800 });
      await expect.poll(async () => (await gridGeometry(terminal)).rows).not.toBe(after.rows);
      const resized = await gridGeometry(terminal);
      await expect
        .poll(async () =>
          (await resizeReceipts(page))
            .filter((receipt) => receipt.terminalId === terminalId)
            .at(-1),
        )
        .toEqual({ terminalId, cols: resized.cols, rows: resized.rows });
      await page.keyboard.press("Escape");
      await terminal.getByTestId("terminal-surface").click();
      await write(page, terminal, "late-font-input-usable");
    } finally {
      release();
    }
  });
}

test("a superseded text font load leaves the current font grid and find highlights intact", async ({
  page,
}) => {
  const terminal = await openTerminal(page);
  await write(page, terminal, "needle-font-grid");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/jetbrains-mono-*.woff2*", async (route) => {
    await held;
    await route.continue();
  });
  const bar = terminal.getByTestId("terminal-find-bar");
  try {
    await page.keyboard.press("ControlOrMeta+KeyF");
    await bar.getByRole("textbox", { name: "Find in terminal" }).fill("needle");
    await expect(terminal.locator("[data-terminal-find-match]")).toHaveCount(2);
    await page.evaluate(() =>
      document.documentElement.style.setProperty(
        "--font-mono",
        '"JetBrains Mono Variable", monospace',
      ),
    );
    await bar.getByRole("button", { name: "Match case" }).click();
    await expect
      .poll(() =>
        terminal
          .locator("canvas")
          .evaluate((canvas: HTMLCanvasElement) => canvas.getContext("2d")!.font),
      )
      .toContain("JetBrains Mono Variable");
    expect(
      await page.evaluate(() => document.fonts.check('16px "JetBrains Mono Variable"', "M")),
    ).toBe(false);
    await page.evaluate(() =>
      document.documentElement.style.setProperty("--font-mono", '"Commit Mono", monospace'),
    );
    await bar.getByRole("button", { name: "Match case" }).click();
    await page.evaluate(async () => {
      await Promise.all(
        ["", "bold ", "italic ", "bold italic "].map((style) =>
          document.fonts.load(`${style}16px "Commit Mono"`, "M"),
        ),
      );
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
    await expect
      .poll(() =>
        terminal
          .locator("canvas")
          .evaluate((canvas: HTMLCanvasElement) => canvas.getContext("2d")!.font),
      )
      .toContain("Commit Mono");
    const surface = terminal.getByTestId("terminal-surface");
    const grid = await surface.evaluate((el) => {
      const canvas = el.querySelector("canvas")!;
      return {
        width: canvas.width,
        height: canvas.height,
        cols: el.getAttribute("data-cols"),
        rows: el.getAttribute("data-rows"),
      };
    });
    // Count real renderer metric measurements. Cursor blinking can draw but does not remeasure M.
    await page.evaluate(() => {
      const measure = CanvasRenderingContext2D.prototype.measureText;
      const probe = { measurements: 0 };
      (window as unknown as { fontProbe: typeof probe }).fontProbe = probe;
      CanvasRenderingContext2D.prototype.measureText = function (text) {
        if (text === "M") probe.measurements++;
        return measure.call(this, text);
      };
    });
    release();
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
    expect(
      await page.evaluate(
        () => (window as unknown as { fontProbe: { measurements: number } }).fontProbe.measurements,
      ),
    ).toBe(0);
    expect(
      await surface.evaluate((el) => {
        const canvas = el.querySelector("canvas")!;
        return {
          width: canvas.width,
          height: canvas.height,
          cols: el.getAttribute("data-cols"),
          rows: el.getAttribute("data-rows"),
        };
      }),
    ).toEqual(grid);
    const canvas = (await terminal.locator("canvas").boundingBox())!;
    const match = (await terminal.locator("[data-terminal-find-match]").first().boundingBox())!;
    expect(match.width).toBeCloseTo((6 * canvas.width) / Number(grid.cols), 0);
    expect(match.height).toBeCloseTo(canvas.height / Number(grid.rows), 0);
  } finally {
    release();
  }
});

test("a disposed terminal ignores its late font completion", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/SymbolsNerdFontMono-Regular*.ttf*", async (route) => {
    if (route.request().resourceType() !== "font") return route.continue();
    await held;
    await route.continue();
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const terminal = await openTerminal(page);
    await write(page, terminal, "dispose-before-font");
    await page.getByRole("button", { name: "Close terminal 1", exact: true }).click();
    await expect(terminal).toHaveCount(0);
    release();
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
    expect(errors).toEqual([]);
    await expect(page.getByTestId("terminal-surface")).toHaveCount(0);
  } finally {
    release();
  }
});
