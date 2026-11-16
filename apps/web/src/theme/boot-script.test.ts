import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

// index.html's inline boot script paints the stored theme before any module loads. A palette stored
// in the other mode (the default `neutral-dark`, with Light picked later) must paint as its partner,
// not dark until ThemeRoot pairs it. `e2e/boot-paint.spec.ts` runs it once in a real page.

const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const source = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;

/** Runs the boot script over `stored` (`gram.theme`'s state) and returns the root's dataset. */
const boot = (stored: object | undefined, systemLight = false) => {
  const dataset: Record<string, string> = {};
  const localStorage = {
    getItem: (key: string) =>
      key === "gram.theme" && stored !== undefined
        ? JSON.stringify({ state: stored, version: 1 })
        : null,
  };
  const document = { documentElement: { dataset } };
  const matchMedia = (query: string) => ({
    matches: query === "(prefers-color-scheme: light)" && systemLight,
  });
  new Function("localStorage", "document", "matchMedia", source)(
    localStorage,
    document,
    matchMedia,
  );
  return dataset;
};

it.each([
  [{ palette: "neutral-dark", mode: "light" }, "neutral", "light"],
  [{ palette: "tokyo-light", mode: "dark" }, "tokyo-night", "dark"],
  [{ palette: "neutral-dark", mode: "dark" }, "neutral-dark", "dark"],
  [{ mode: "light" }, "neutral", "light"],
  [{}, "neutral-dark", "dark"],
  [undefined, "neutral-dark", "dark"],
])("boots %j as %s in %s", (stored, palette, mode) => {
  expect(boot(stored)).toMatchObject({ palette, mode });
});

it("boots the system mode's partner by the OS's scheme", () => {
  const stored = { palette: "neutral-dark", mode: "system" };
  expect(boot(stored, true)).toMatchObject({ palette: "neutral", mode: "light" });
  expect(boot(stored, false)).toMatchObject({ palette: "neutral-dark", mode: "dark" });
});

it("keeps a stored reduced or off motion, and nothing else", () => {
  expect(boot({ motion: "off" }).motion).toBe("off");
  expect(boot({ motion: "reduced" }).motion).toBe("reduced");
  expect(boot({ motion: "full" }).motion).toBeUndefined();
});

it("leaves the page's own defaults when the stored theme isn't JSON", () => {
  const dataset: Record<string, string> = {};
  const run = new Function("localStorage", "document", "matchMedia", source);
  expect(() =>
    run({ getItem: () => "{not json" }, { documentElement: { dataset } }, () => ({})),
  ).not.toThrow();
  expect(dataset.palette).toBeUndefined();
});
