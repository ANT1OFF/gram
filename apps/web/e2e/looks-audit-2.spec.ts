import { expect, test, type Locator, type Page } from "@playwright/test";

import { slowdown } from "./slowdown";
import { threadRow } from "./thread-row";

// Looks and accessibility audit of the surfaces added in M3 wave "tonight": Glass, the only look,
// light and dark, standard and more contrast. Each surface is driven from the mock, then its text is checked
// against the WCAG floor on the colour actually painted behind it (composited up the ancestors),
// its controls are checked for a visible focus indicator, and a screenshot goes to
// e2e/__screenshots__/audit-2/ (gitignored) for review. The theme runs are opt-in:
// GRAM_AUDIT=default covers two themes that between them hit every mode and contrast,
// GRAM_AUDIT=1 all four. The motion test always runs.

const LOOKS = ["glass"] as const;
const MODES = ["dark", "light"] as const;
const CONTRASTS = ["standard", "more"] as const;
type Theme = {
  look: (typeof LOOKS)[number];
  mode: (typeof MODES)[number];
  contrast: (typeof CONTRASTS)[number];
};

const ALL: Theme[] = LOOKS.flatMap((look) =>
  MODES.flatMap((mode) => CONTRASTS.map((contrast) => ({ look, mode, contrast }))),
);
const DEFAULT_THEMES: Theme[] = [
  { look: "glass", mode: "dark", contrast: "standard" },
  { look: "glass", mode: "light", contrast: "more" },
];
const AUDIT = process.env["GRAM_AUDIT"];
/** GRAM_AUDIT_SURFACES=a,b audits only those surfaces, for a focused rerun. */
const ONLY = process.env["GRAM_AUDIT_SURFACES"]?.split(",");
const THEMES: Theme[] = AUDIT === "1" ? ALL : AUDIT === "default" ? DEFAULT_THEMES : [];

const PALETTES = { dark: "tokyo-night", light: "catppuccin-latte" } as const;

const LAUNCH_CHECKS = {
  tools: [
    { tool: "claude", found: true, path: "/mock/bin/claude", version: "2.1.273" },
    { tool: "git", found: true, path: "/usr/bin/git", version: "2.47.1" },
    { tool: "gh", found: false },
  ],
  claudeSignIn: "notSignedIn",
  ghSignedIn: false,
};

test.describe.configure({ timeout: 180_000 * slowdown });
// A surface that doesn't open fails in seconds rather than holding the whole theme run.
test.use({ actionTimeout: 15_000 * slowdown });

/** Seeds the theme where the app reads it, with Motion Off so screenshots are settled. */
const seed = (page: Page, theme: Theme, motion: "system" | "reduced" | "off" = "off") =>
  page.addInitScript(
    ({ theme: seeded, palette, motion: level, launchChecks }) => {
      if (sessionStorage.getItem("gram.mock.settings") === null) {
        sessionStorage.setItem(
          "gram.mock.settings",
          JSON.stringify({
            appearance: {
              look: seeded.look,
              paletteId: palette,
              mode: seeded.mode,
              density: "comfortable",
              contrast: seeded.contrast,
              motion: level,
            },
          }),
        );
      }
      localStorage.setItem(
        "gram.theme",
        JSON.stringify({
          state: {
            look: seeded.look,
            palette,
            mode: seeded.mode,
            density: "comfortable",
            contrast: seeded.contrast === "standard" ? "system" : seeded.contrast,
            motion: level,
            customPalettes: [],
          },
          version: 1,
        }),
      );
      sessionStorage.setItem("gram.mock.launchChecks", JSON.stringify(launchChecks));
      sessionStorage.setItem("gram.mock.agents", "claude,codex");
    },
    { theme, palette: PALETTES[theme.mode], motion, launchChecks: LAUNCH_CHECKS },
  );

type Failure = { text: string; ratio: number; floor: number; fg: string; bg: string };

/** Text under `root` below its WCAG floor, against the composited background it sits on. */
const auditContrast = (root: Locator, contrast: Theme["contrast"]) =>
  root.evaluate(
    (element, more) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      const rgba = (color: string): [number, number, number, number] => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = "#0000";
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
        return [r!, g!, b!, a! / 255];
      };
      // In-page helpers stay inside the evaluated function: Playwright serialises only its body.
      // oxlint-disable-next-line unicorn/consistent-function-scoping
      const over = (top: number[], bottom: number[]) =>
        [0, 1, 2].map((i) => top[i]! * top[3]! + bottom[i]! * (1 - top[3]!)).concat(1);
      // oxlint-disable-next-line unicorn/consistent-function-scoping
      const luminance = ([r, g, b]: number[]) => {
        // oxlint-disable-next-line unicorn/consistent-function-scoping
        const channel = (value: number) => {
          const c = value / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
      };
      const ratio = (a: number[], b: number[]) => {
        const [hi, lo] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
        return (hi! + 0.05) / (lo! + 0.05);
      };
      const backdrop =
        document.documentElement.dataset["mode"] === "light" ? [255, 255, 255, 1] : [0, 0, 0, 1];
      const background = (start: Element) => {
        const layers: number[][] = [];
        for (let node: Element | null = start; node; node = node.parentElement) {
          const layer = rgba(getComputedStyle(node).backgroundColor);
          if (layer[3] > 0) layers.push(layer);
          if (layer[3] === 1) break;
        }
        return layers.reduceRight((below, layer) => over(layer, below), backdrop);
      };
      // oxlint-disable-next-line unicorn/consistent-function-scoping
      const faded = (start: Element) => {
        for (let node: Element | null = start; node; node = node.parentElement) {
          if (Number(getComputedStyle(node).opacity) < 1) return true;
          if (node.matches(":disabled, [aria-disabled='true']")) return true;
        }
        return false;
      };

      const failures: Failure[] = [];
      let checked = 0;
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        const text = node.textContent?.trim() ?? "";
        if (!parent || text === "" || parent.getClientRects().length === 0) continue;
        const style = getComputedStyle(parent);
        if (style.visibility === "hidden" || faded(parent)) continue;
        const size = Number.parseFloat(style.fontSize);
        const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
        const floor = more ? (large ? 4.5 : 7) : large ? 3 : 4.5;
        const bg = background(parent);
        const fg = over(rgba(style.color), bg);
        const value = ratio(fg, bg);
        checked++;
        if (value < floor - 0.005) {
          failures.push({
            text: text.slice(0, 48),
            ratio: Math.round(value * 100) / 100,
            floor,
            fg: `rgb(${fg.slice(0, 3).map(Math.round).join(" ")})`,
            bg: `rgb(${bg.slice(0, 3).map(Math.round).join(" ")})`,
          });
        }
      }
      return { checked, failures };
    },
    contrast === "more",
    { timeout: 10_000 },
  );

/** Controls under `root` that show no outline or ring when focused from the keyboard. */
const auditFocus = async (page: Page, root: Locator) => {
  await page.keyboard.press("Shift");
  return root.evaluate(
    (element) => {
      const missing: string[] = [];
      const controls = element.querySelectorAll<HTMLElement>(
        "button, a[href], input, textarea, select, [tabindex]:not([tabindex='-1'])",
      );
      for (const control of controls) {
        if (control.getClientRects().length === 0 || control.matches(":disabled")) continue;
        if (control.closest("[role='menu'], [role='listbox']")) continue;
        control.focus({ focusVisible: true } as FocusOptions);
        if (document.activeElement !== control) continue;
        const style = getComputedStyle(control);
        const outlined = style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0;
        if (!outlined && style.boxShadow === "none") {
          missing.push(
            control.getAttribute("aria-label") ?? control.textContent?.trim().slice(0, 32) ?? "?",
          );
        }
      }
      return missing;
    },
    undefined,
    { timeout: 10_000 },
  );
};

/** `retry`: open and audit again as one unit, for menus a row re-render can detach mid-audit. */
type Surface = { name: string; retry?: boolean; open: (page: Page) => Promise<Locator> };

async function openPrSubmenu(page: Page) {
  const row = threadRow(page, "t-deps");
  await expect(async () => {
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "PR", exact: true }).hover({ timeout: 2_000 });
    await expect(page.getByRole("menuitem", { name: "Bind PR…" })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
}

const newThreadForm = async (page: Page) => {
  await page.goto("/new");
  return page.getByRole("form", { name: "New thread" });
};

const SURFACES: Surface[] = [
  {
    name: "launch-banner",
    open: async (page) => {
      await page.goto("/t/t-flaky");
      const banner = page.getByTestId("launch-checks-banner");
      await expect(banner).toContainText("gh isn't installed");
      await expect(banner.locator("svg").first()).toBeVisible();
      return banner;
    },
  },
  {
    name: "toast-dock",
    open: async (page) => {
      // A success and an error toast, docked below the right panel's content.
      await page.evaluate(() => {
        window.gramMock?.simulateChecks("t-flaky" as never, "passing");
        window.gramMock?.simulateChecks("t-flaky" as never, "failing");
      });
      const dock = page.getByTestId("toast-dock");
      await expect(
        dock.getByTestId("toast").filter({ hasText: "CI passed on #412" }),
      ).toBeVisible();
      await expect(
        dock.getByTestId("toast").filter({ hasText: "CI failed on #412" }),
      ).toBeVisible();
      return dock;
    },
  },
  {
    name: "pr-badge-chips",
    open: async (page) => {
      // The header's chips stand in for the PR strip once the PR is hidden from it.
      await page
        .getByTestId("pr-row")
        .getByRole("button", { name: /^Hide #412 / })
        .click();
      await expect(page.getByTestId("pane-merge-state")).toHaveText("Blocked");
      await expect(page.getByTestId("pane-review-decision")).toHaveText("Changes requested");
      return page.getByTestId("pane-header").first();
    },
  },
  {
    name: "pr-actions",
    open: async (page) => {
      await page.getByTestId("right-panel").getByRole("tab", { name: "PR", exact: true }).click();
      const panel = page.getByTestId("pr-panel");
      await expect(panel.getByTestId("pr-actions")).toBeVisible();
      return panel;
    },
  },
  {
    name: "diff-panel",
    open: async (page) => {
      await page.getByTestId("right-panel").getByRole("tab", { name: "Diff", exact: true }).click();
      const file = page
        .getByTestId("right-panel")
        .locator("[data-testid='diff-file'][data-path='src/retry.test.ts']");
      const toggle = file.getByRole("button", { expanded: false });
      if (await toggle.isVisible()) await toggle.click();
      await expect(file.getByTestId("patch").locator("tr[data-kind='add']").first()).toBeVisible();
      return file;
    },
  },
  {
    name: "window-title",
    open: async (page) => {
      await expect(page).toHaveTitle(/^\(\d+\) Gram$/);
      return threadRow(page, "t-flaky");
    },
  },
  {
    name: "pr-submenu",
    retry: true,
    open: async (page) => {
      await openPrSubmenu(page);
      return page
        .getByRole("menuitem", { name: "Bind PR…" })
        .locator("xpath=ancestor::*[@role='menu'][1]");
    },
  },
  {
    name: "bind-pr-dialog",
    retry: true,
    open: async (page) => {
      const dialog = page.getByTestId("bind-pr-dialog");
      if (!(await dialog.isVisible())) {
        await openPrSubmenu(page);
        await page.getByRole("menuitem", { name: "Bind PR…" }).click({ timeout: 2_000 });
      }
      await dialog.getByLabel("Pull request number or URL").fill("#412", { timeout: 2_000 });
      return dialog;
    },
  },
  {
    name: "bulk-worktrees",
    open: async (page) => {
      await page.keyboard.press("Escape");
      await page.evaluate(() => sessionStorage.setItem("gram.mock.worktrees", "many"));
      await page.keyboard.press("ControlOrMeta+k");
      const palette = page.getByTestId("command-palette");
      await palette.getByRole("combobox").fill(">Worktrees");
      await palette.getByRole("combobox").press("Enter");
      const dialog = page.getByTestId("worktrees-dialog");
      // Rows are named by branch.
      await dialog.getByRole("checkbox", { name: "Select spike/retry" }).check();
      await dialog.getByRole("checkbox", { name: "Select docs/refresh" }).check();
      await dialog.getByRole("button", { name: /^Remove 2 worktrees/ }).click();
      await expect(dialog.getByTestId("worktree-bulk-remove")).toBeVisible();
      return dialog;
    },
  },
  {
    name: "key-capture",
    open: async (page) => {
      await page.keyboard.press("Escape");
      await page.goto("/settings/keyboard");
      const settings = page.getByTestId("keyboard-settings");
      await settings
        .getByTestId("binding-panel.toggle")
        .getByRole("button", { name: "Change Show / hide right panel" })
        .click();
      const dialog = page.getByTestId("key-capture-dialog");
      await expect(dialog.getByTestId("key-capture-status")).toContainText("Recording");
      await page.keyboard.press("ControlOrMeta+b");
      await expect(dialog.getByTestId("key-capture-clash")).toBeVisible();
      return dialog;
    },
  },
  {
    name: "notifications",
    open: async (page) => {
      await page.keyboard.press("Escape");
      await page.goto("/settings/notifications");
      const section = page.getByTestId("notification-settings");
      await section.scrollIntoViewIfNeeded();
      return section;
    },
  },
  {
    name: "custom-shell",
    open: async (page) => {
      await page.goto("/settings/terminal");
      const field = page.getByLabel("Custom shell path");
      await field.scrollIntoViewIfNeeded();
      await field.fill("/bin/zsh");
      await page.getByRole("button", { name: "Use this shell" }).click();
      return field.locator("xpath=ancestor::form[1]/..");
    },
  },
  {
    name: "checkout-in-use",
    open: async (page) => {
      const form = await newThreadForm(page);
      await form
        .getByRole("region", { name: "Recent" })
        .getByRole("button", { name: /^docs/ })
        .click();
      await form.getByRole("radio", { name: "Current checkout" }).click();
      const notice = form.getByTestId("checkout-in-use");
      await expect(notice).toBeVisible();
      return notice;
    },
  },
  {
    name: "remove-from-recents",
    open: async (page) => {
      const recent = page.getByRole("form", { name: "New thread" }).getByRole("region", {
        name: "Recent",
      });
      await recent
        .getByRole("button", { name: /from recents$/ })
        .first()
        .focus();
      return recent;
    },
  },
  {
    name: "behind-origin",
    open: async (page) => {
      const form = await newThreadForm(page);
      await page.getByRole("combobox", { name: "Project path" }).fill("~/code/api");
      await form.getByRole("radio", { name: "Current checkout" }).click();
      const freshness = form.getByTestId("base-freshness");
      await freshness.getByRole("button", { name: "Fetch" }).click();
      await expect(form.getByTestId("upstream-sync")).toContainText("2 commits behind");
      return form.getByTestId("upstream-sync").locator("xpath=..");
    },
  },
  {
    name: "resume-picker",
    open: async (page) => {
      await newThreadForm(page);
      await page.getByRole("button", { name: "Resume a past session…" }).click();
      const picker = page.getByTestId("resume-sessions");
      await picker.getByTestId("past-session").first().hover();
      await expect(picker.getByTestId("session-preview")).toBeVisible();
      return picker;
    },
  },
  {
    name: "gateways",
    open: async (page) => {
      await page.goto("/settings/gateways");
      const profiles = page.getByRole("list", { name: "Gateway profiles" });
      await expect(profiles).toContainText("No API key yet");
      return page.locator("main");
    },
  },
  {
    name: "gateway-key-prompt",
    open: async (page) => {
      // The seeded gateway profile has no key, so a gateway agent points at Settings instead.
      const form = await newThreadForm(page);
      await form.getByLabel("Agent").click();
      await page.getByRole("option", { name: "Codex", exact: true }).click();
      const link = form.getByRole("link", { name: "Add your gateway key" });
      await expect(link).toBeVisible();
      return link.locator("xpath=..");
    },
  },
];

for (const theme of THEMES) {
  const id = `${theme.look}-${theme.mode}-${theme.contrast}`;
  test(`audit: ${id}`, async ({ page }) => {
    await seed(page, theme);
    await page.goto("/t/t-flaky");
    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-look", theme.look);
    await expect(html).toHaveAttribute("data-mode", theme.mode);
    await expect(html).toHaveAttribute("data-contrast", theme.contrast);

    const problems: string[] = [];
    for (const surface of SURFACES) {
      if (ONLY && !ONLY.includes(surface.name)) continue;
      const audit = async () => {
        const found: string[] = [];
        const root = await surface.open(page);
        await page.waitForTimeout(150);
        await page.screenshot({ path: `e2e/__screenshots__/audit-2/${id}-${surface.name}.png` });
        const { checked, failures } = await auditContrast(root, theme.contrast);
        for (const f of failures) {
          found.push(`${surface.name}: "${f.text}" ${f.fg} on ${f.bg} = ${f.ratio} (< ${f.floor})`);
        }
        if (checked === 0 && surface.name !== "window-title")
          found.push(`${surface.name}: no text`);
        for (const control of await auditFocus(page, root)) {
          found.push(`${surface.name}: no focus indicator on "${control}"`);
        }
        return found;
      };
      try {
        if (surface.retry) {
          let found: string[] = [];
          await expect(async () => {
            found = await audit();
          }).toPass({ timeout: 45_000 });
          problems.push(...found);
        } else {
          problems.push(...(await audit()));
        }
      } catch (error) {
        // A surface that can't open is a finding too, and the surfaces after it still get audited.
        problems.push(`${surface.name}: couldn't open: ${String(error).split("\n")[0]}`);
      }
    }
    expect(problems).toEqual([]);
  });
}

test("Motion Off stops every CSS animation and transition; Reduced keeps fades only", async ({
  page,
}) => {
  const cssAnimations = () =>
    page.evaluate(
      () =>
        document
          .getAnimations()
          .filter((a) => a instanceof CSSAnimation || a instanceof CSSTransition).length,
    );
  // t-docs is seeded running and nothing drives it from here, so its icon works steadily; t-flaky's
  // own icon stops once its autoplay turn ends, which a slow runner reached before measuring. The
  // overview's rows show a status dot, so the icon measured is the one in t-docs's pane header. The
  // spinner is turned from script (`motion/spin.ts`), so what counts is whether it moves.
  const spinning = () =>
    page
      .getByTestId("pane-header")
      .locator('[data-testid="status-icon"][data-working="true"]')
      .evaluate(async (el: SVGElement) => {
        const angles = new Set<string>();
        for (let i = 0; i < 4; i++) {
          angles.add(el.style.rotate);
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
        return angles.size - 1;
      });

  await seed(page, { look: "glass", mode: "dark", contrast: "standard" }, "system");
  await page.goto("/t/t-docs");
  await expect(page.locator("html")).toHaveAttribute("data-motion", "full");
  await expect.poll(spinning, { message: "a working status spins at Full" }).toBeGreaterThan(0);

  const setMotion = async (motion: string) => {
    await page.goto("/settings/appearance");
    await page.getByRole("group", { name: "Motion" }).getByRole("button", { name: motion }).click();
    await expect(page.locator("html")).toHaveAttribute("data-motion", motion);
    await page.goto("/t/t-docs");
    await expect(page.getByTestId("pane-header")).toBeVisible();
  };

  await setMotion("reduced");
  expect(await spinning(), "Reduced stops spinning").toBe(0);
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByTestId("command-palette");
  await expect(palette).toBeVisible();
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.querySelector('[data-testid="command-palette"]')!).getPropertyValue(
        "--tw-enter-scale",
      ),
    ),
  ).not.toMatch(/0\.9/);
  await page.keyboard.press("Escape");

  await setMotion("off");
  expect(await spinning(), "Off stops spinning").toBe(0);
  await page.keyboard.press("ControlOrMeta+k");
  await expect(palette).toBeVisible();
  const row = palette.getByRole("option").first();
  await row.hover();
  expect(await cssAnimations(), "Off leaves no CSS animation or transition running").toBe(0);
  const button = page.getByRole("button", { name: "Settings", exact: true });
  await page.keyboard.press("Escape");
  expect(
    await button.evaluate((el) => getComputedStyle(el).transitionDuration),
    "buttons don't transition at Off",
  ).toMatch(/^0s/);
});
