import { expect, test } from "@playwright/test";

const families = ["neutral", "rose", "forest", "ocean", "ember", "violet"];
const roles = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "bright-black",
  "bright-red",
  "bright-green",
  "bright-yellow",
  "bright-blue",
  "bright-magenta",
  "bright-cyan",
  "bright-white",
];
const sgr = roles
  .map((role, i) => `\x1b[${i < 8 ? 30 + i : 90 + i - 8}m████ ${role}\x1b[0m\r\n`)
  .join("");

for (const family of families) {
  for (const mode of ["light", "dark"] as const) {
    for (const contrast of ["standard", "more"] as const) {
      test(`${family} ${mode} ${contrast} paints readable normal and bright SGR text`, async ({
        page,
      }, testInfo) => {
        await page.addInitScript(
          ({ palette, mode: seededMode, contrast: seededContrast }) => {
            localStorage.setItem(
              "gram.theme",
              JSON.stringify({
                version: 1,
                state: {
                  look: "glass",
                  palette,
                  mode: seededMode,
                  contrast: seededContrast === "standard" ? "system" : seededContrast,
                  density: "compact",
                  motion: "off",
                  customPalettes: [],
                },
              }),
            );
            sessionStorage.setItem(
              "gram.mock.settings",
              JSON.stringify({
                appearance: {
                  look: "glass",
                  paletteId: palette,
                  mode: seededMode,
                  contrast: seededContrast,
                  density: "compact",
                  motion: "off",
                },
                fonts: { mono: "Geist Mono Variable", monoSize: 16 },
              }),
            );
            sessionStorage.setItem(
              "gram.mock.launchChecks",
              JSON.stringify({
                tools: [
                  { tool: "claude", found: true, path: "/mock/bin/claude", version: "2.1.273" },
                  { tool: "codex", found: true, path: "/mock/bin/codex", version: "0.159.2" },
                  { tool: "git", found: true, path: "/mock/bin/git", version: "2.47.1" },
                  { tool: "gh", found: false },
                ],
                claudeSignIn: "notSignedIn",
                ghSignedIn: false,
              }),
            );
            sessionStorage.setItem("gram.mock.agents", "claude,codex");
          },
          { palette: family, mode, contrast },
        );
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.goto("/t/t-flaky");
        await page.waitForFunction(() => window.gramMock !== undefined);
        // Supply invented output through the actual feed/TerminalView replay path; no shell runs.
        await page.evaluate((output) => {
          const api = window.gramMock!;
          const feed = api.terminalFeed.bind(api);
          api.terminalFeed = (id, signal) => ({
            async *[Symbol.asyncIterator]() {
              for await (const event of feed(id, signal)) {
                yield event.type === "replay"
                  ? { ...event, data: `\x1b[2J\x1b[H${output}$ ` }
                  : event;
              }
            },
          });
        }, sgr);
        const panel = page.getByTestId("right-panel");
        await panel.getByRole("tab", { name: "Terminal", exact: true }).click();
        const terminal = panel.getByTestId("terminal").first();
        const surface = terminal.getByTestId("terminal-surface");
        await expect(terminal.locator("[data-terminal-text]")).toContainText("bright-white");
        await expect(page.locator("html")).toHaveAttribute("data-contrast", contrast);
        const painted = () =>
          surface.evaluate((element, keys) => {
            const canvas = element.querySelector("canvas")!;
            const context = canvas.getContext("2d")!;
            const rows = Number((element as HTMLElement).dataset["rows"]);
            const cols = Number((element as HTMLElement).dataset["cols"]);
            const width = canvas.width / cols;
            const height = canvas.height / rows;
            const css = getComputedStyle(document.documentElement);
            const parser = document.createElement("canvas").getContext("2d")!;
            const rgb = (token: string) => {
              parser.clearRect(0, 0, 1, 1);
              parser.fillStyle = css.getPropertyValue(token).trim();
              parser.fillRect(0, 0, 1, 1);
              return [...parser.getImageData(0, 0, 1, 1).data].slice(0, 3);
            };
            const weights = [0.2126, 0.7152, 0.0722];
            const luminance = (color: number[]) =>
              color
                .map((value) => {
                  const v = value / 255;
                  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
                })
                .reduce((sum, value, i) => sum + value * weights[i]!, 0);
            const ratio = (a: number[], b: number[]) =>
              (Math.max(luminance(a), luminance(b)) + 0.05) /
              (Math.min(luminance(a), luminance(b)) + 0.05);
            const lines = element.querySelector("[data-terminal-text]")!.textContent!.split("\n");
            const bg = rgb("--ansi-background");
            return keys.map((key) => {
              const row = lines.findIndex((line) => line.startsWith(`████ ${key}`));
              if (row < 0) return { key, matchingPixels: 0, ratio: 0 };
              const expected = rgb(`--ansi-${key}`);
              const pixels = context.getImageData(0, row * height, width * 4, height).data;
              let matchingPixels = 0;
              let actual = [0, 0, 0];
              for (let i = 0; i < pixels.length; i += 4) {
                if (expected.every((value, channel) => value === pixels[i + channel])) {
                  matchingPixels++;
                  actual = Array.from(pixels.slice(i, i + 3));
                }
              }
              return { key, matchingPixels, expected, actual, ratio: ratio(actual, bg) };
            });
          }, roles);
        await expect
          .poll(async () => (await painted()).every((row) => row.matchingPixels > 0))
          .toBe(true);
        const result = await painted();
        for (const row of result)
          expect(row.ratio, `${family} ${mode} ${contrast} ${row.key}`).toBeGreaterThanOrEqual(
            contrast === "more" ? 7 : 4.5,
          );
        await testInfo.attach("actual-sgr-pixels", {
          body: JSON.stringify(result, null, 2),
          contentType: "application/json",
        });
        await panel.screenshot({
          path: testInfo.outputPath(`${family}-${mode}-${contrast}-sgr.png`),
          animations: "disabled",
        });
        await expect(terminal.getByRole("alert")).toHaveCount(0);
      });
    }
  }
}
