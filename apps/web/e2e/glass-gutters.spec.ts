import { expect, test, type Page } from "@playwright/test";
import { setLayout } from "./layout";

// Under Glass the panes sit flush on the grid's hairline sheet: square corners, no margin, and a 1px
// hairline where two meet. Over native vibrancy the window is transparent, so every grid pixel no
// pane covers, the hairlines and anything a moving pane uncovers, needs an opaque painter or the
// window shows through. This samples them on every other frame while panes split, resize, maximize
// and close, asserts no point lacks an opaque background, and checks the panes fill the grid at
// rest. Screenshots for review go to e2e/__screenshots__/gutters/ (gitignored).

const SETTINGS_KEY = "gram.mock.settings";

type Probe = { frames: number; points: number; unpainted: string[]; painters: string[] };

async function useGlass(page: Page) {
  await page.goto("/settings/appearance");
  // Glass is the only look. In dark mode the Catppuccin card picks Mocha; Light shows Latte.
  await page.getByRole("button", { name: "Catppuccin", exact: true }).click();
  await page.getByRole("group", { name: "Mode" }).getByRole("button", { name: "light" }).click();
  await page.getByRole("group", { name: "Motion" }).getByRole("button", { name: "system" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(sessionStorage.getItem(key) ?? "{}").appearance,
        SETTINGS_KEY,
      ),
    )
    .toMatchObject({
      look: "glass",
      paletteId: "catppuccin-mocha",
      mode: "light",
      motion: "system",
    });
}

/** Samples a 12px lattice over the grid, skipping points a pane covers, on every other frame. */
// Runs in the page through addInitScript, so its helpers must live inside it.
const MONITOR = () => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const alphaOf = (color: string) => {
    if (color === "transparent") return 0;
    const slash = /\/\s*([\d.]+)\s*\)$/.exec(color);
    if (slash) return Number(slash[1]);
    const rgba = /^rgba\(([^)]+)\)$/.exec(color);
    const parts = rgba?.[1]?.split(",") ?? [];
    return parts.length === 4 ? Number(parts[3]) : 1;
  };
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const name = (el: Element) =>
    el.tagName.toLowerCase() +
    (el.getAttribute("data-testid") ? `[${el.getAttribute("data-testid")}]` : "");
  const probe: Probe = { frames: 0, points: 0, unpainted: [], painters: [] };
  (window as unknown as { __gutters: Probe }).__gutters = probe;
  let frame = 0;
  const tick = () => {
    const grid = document.querySelector('[data-testid="thread-grid"]');
    const rect = grid?.getBoundingClientRect();
    if (grid && rect && frame++ % 2 === 0) {
      probe.frames++;
      const backgrounds = new Map<Element, string>();
      const background = (el: Element) => {
        if (!backgrounds.has(el)) backgrounds.set(el, getComputedStyle(el).backgroundColor);
        return backgrounds.get(el)!;
      };
      for (let x = rect.left + 1; x < rect.right; x += 12) {
        for (let y = rect.top + 1; y < rect.bottom; y += 12) {
          // Portaled tooltips can cross the gutter during a drag. Probe the backing grid
          // and its ancestors beneath them, so an overlay neither counts as its painter
          // nor conceals a missing backdrop. Preserve sheets inside the grid in the probe.
          const stack = document
            .elementsFromPoint(x, y)
            .filter((el) => grid.contains(el) || el.contains(grid));
          // A pane paints its own points, also beneath a divider that overlaps its edge.
          if (stack.some((el) => el.matches('[data-testid="pane"]'))) continue;
          probe.points++;
          const painter = stack.find((el) => alphaOf(background(el)) === 1);
          if (!painter) {
            if (probe.unpainted.length < 5)
              probe.unpainted.push(`${Math.round(x)},${Math.round(y)}`);
          } else if (!probe.painters.includes(name(painter))) {
            probe.painters.push(name(painter));
          }
        }
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

/** Returns what the monitor saw since the last call, and resets it. */
const drain = (page: Page) =>
  page.evaluate(() => {
    const probe = (window as unknown as { __gutters: Probe }).__gutters;
    const seen = { ...probe, unpainted: [...probe.unpainted], painters: [...probe.painters] };
    Object.assign(probe, { frames: 0, points: 0, unpainted: [], painters: [] });
    return seen;
  });

/** Where the shown panes leave the grid uncovered, and how they sit in it, in CSS pixels. */
const fit = (page: Page) =>
  page.evaluate(() => {
    const grid = document.querySelector('[data-testid="thread-grid"]')!.getBoundingClientRect();
    const panes = [...document.querySelectorAll('[data-testid="pane"]')].filter(
      (el) => getComputedStyle(el).display !== "none",
    );
    const boxes = panes.map((el) => el.getBoundingClientRect());
    const styles = panes.map((el) => getComputedStyle(el));
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const distinct = (values: number[]) => new Set(values.map((v) => Math.round(v))).size;
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const px = (value: number) => Math.round(value);
    const covered = boxes.reduce((sum, box) => sum + box.width * box.height, 0);
    return {
      cols: distinct(boxes.map((box) => box.left)),
      rows: distinct(boxes.map((box) => box.top)),
      uncovered: grid.width * grid.height - covered,
      gridWidth: grid.width,
      gridHeight: grid.height,
      edges: {
        left: px(Math.min(...boxes.map((box) => box.left)) - grid.left),
        top: px(Math.min(...boxes.map((box) => box.top)) - grid.top),
        right: px(grid.right - Math.max(...boxes.map((box) => box.right))),
        bottom: px(grid.bottom - Math.max(...boxes.map((box) => box.bottom))),
      },
      radii: [...new Set(styles.map((style) => style.borderTopLeftRadius))],
      margins: [...new Set(styles.map((style) => style.margin))],
    };
  });

/** The panes fill the grid edge to edge, square, with nothing between them but 1px hairlines. */
const expectFlush = async (page: Page, step: string) => {
  const seen = await fit(page);
  expect(seen.radii, `${step}: pane corners`).toEqual(["0px"]);
  expect(seen.margins, `${step}: pane margins`).toEqual(["0px"]);
  expect(seen.edges, `${step}: panes meet the grid's edges`).toEqual({
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
  });
  // One 1px hairline per inner column and row edge, with a pixel of slack for subpixel tracks.
  const hairlines =
    (seen.cols - 1) * seen.gridHeight + (seen.rows - 1) * seen.gridWidth + seen.gridWidth;
  expect(seen.uncovered, `${step}: grid area no pane covers`).toBeLessThanOrEqual(hairlines);
};

const expectPainted = async (page: Page, step: string) => {
  const seen = await drain(page);
  expect(seen.unpainted, `${step}: grid points with no opaque background`).toEqual([]);
  // The grid's hairline sheet paints whatever the panes leave uncovered, never the backdrop.
  expect(
    seen.painters.filter((painter) => painter !== "ul"),
    `${step}: painters`,
  ).toEqual([]);
  await expectFlush(page, step);
};

test("Glass panes stay flush and painted over native vibrancy while they split, resize and close", async ({
  page,
}) => {
  // Three times the configured timeout, which already scales for the GPU-less Windows runner.
  test.slow();
  await useGlass(page);
  await page.goto("/t/t-deps");
  await expect(page.getByTestId("thread-grid")).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.dataset["vibrancy"] = "native";
  });
  await page.waitForTimeout(300);
  await page.evaluate(MONITOR);
  await page.waitForTimeout(300);
  await expectPainted(page, "one pane");
  // The pane meets the overview sidebar and the title bar, with no gap or inset between them.
  const meets = await page.evaluate(() => {
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const pane = box('[data-testid="pane"]');
    return {
      sidebar: Math.round(pane.left - box('[data-testid="overview-sidebar"]').right),
      titlebar: Math.round(pane.top - box('[data-testid="shell-titlebar"]').bottom),
    };
  });
  expect(meets).toEqual({ sidebar: 0, titlebar: 0 });

  await page.keyboard.press("ControlOrMeta+Backslash");
  await expect(page.getByTestId("pane")).toHaveCount(2);
  await page.waitForTimeout(800);
  await expectPainted(page, "split");

  const divider = page.getByTestId("divider").first();
  const box = (await divider.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x - 250, box.y + 200, { steps: 8 });
  await page.mouse.move(box.x + 200, box.y + 200, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  await expectPainted(page, "drag resize");

  await divider.focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(500);
  await expectPainted(page, "keyboard resize");

  await setLayout(page, "2×2");
  await expect(page.getByTestId("pane")).toHaveCount(4);
  await page.waitForTimeout(800);
  await expectPainted(page, "2×2");
  await page.screenshot({ path: "e2e/__screenshots__/gutters/glass-native-2x2.png" });

  await page.keyboard.press("ControlOrMeta+Shift+Enter");
  await page.waitForTimeout(800);
  await page.keyboard.press("ControlOrMeta+Shift+Enter");
  await page.waitForTimeout(800);
  await expectPainted(page, "maximize and restore");

  await page.getByTestId("pane").nth(1).getByRole("button", { name: "Close pane" }).click();
  await page.waitForTimeout(800);
  await expectPainted(page, "close");
  await page.screenshot({ path: "e2e/__screenshots__/gutters/glass-native-closed.png" });
});

test("gutter monitor probes beneath portaled overlays without hiding missing paint", async ({
  page,
}) => {
  await page.setContent(`
    <style>html, body { margin: 0; }</style>
    <main style="background: rgb(255,255,255); width: 200px; height: 100px">
      <div data-testid="thread-grid" style="position: relative; width: 200px; height: 100px">
        <div data-testid="pane" style="position: absolute; inset: 12px; background: white"></div>
      </div>
    </main>
    <div role="tooltip" style="position: fixed; inset: 0; background: black">Overlay</div>
  `);
  await page.evaluate(MONITOR);
  await expect
    .poll(async () => {
      const seen = await drain(page);
      return { hasPoints: seen.points > 0, painters: seen.painters, unpainted: seen.unpainted };
    })
    .toEqual({ hasPoints: true, painters: ["main"], unpainted: [] });

  await page.locator("main").evaluate((el) => {
    el.style.background = "transparent";
  });
  await drain(page);
  await expect.poll(async () => (await drain(page)).unpainted.length).toBeGreaterThan(0);

  // An opaque sheet inside the grid is reported as the painter, not hidden behind main.
  await page.getByTestId("thread-grid").evaluate((el) => {
    el.style.background = "white";
  });
  await drain(page);
  await expect.poll(async () => (await drain(page)).painters).toEqual(["div[thread-grid]"]);
});
