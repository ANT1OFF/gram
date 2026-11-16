// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import * as full from "./kit";
import * as lite from "./kit-lite";

// What `@gram/web/kit-lite` exports, for a page drawn before Gram mounts. Every control in it is
// the full kit's own, from the same module; the light kit adds only what such a page needs to put
// Gram's look on itself. Remove a name only with an "Embedders" line (docs/EMBEDDED_WEB_APP.md).
const EXPORTS = [
  "Alert",
  "AlertDescription",
  "AlertTitle",
  "Badge",
  "Button",
  "ButtonGroup",
  "Checkbox",
  "Field",
  "Input",
  "InputGroup",
  "RadioGroup",
  "Shimmer",
  "Skeleton",
  "Textarea",
  "applyGramTheme",
  "buttonVariants",
  "cn",
];

afterEach(() => {
  vi.unstubAllGlobals();
  const root = document.documentElement;
  for (const name of ["look", "mode", "palette", "motion"]) delete root.dataset[name];
  document.getElementById("gram-host-theme")?.remove();
  localStorage.clear();
});

describe("@gram/web/kit-lite", () => {
  it("exports exactly the basics", () => {
    expect(Object.keys(lite).toSorted()).toEqual(EXPORTS.toSorted());
  });

  it("shares the full kit's controls, never copies of them", () => {
    const shared: Record<string, unknown> = { ...full };
    for (const [name, value] of Object.entries(lite))
      if (name !== "applyGramTheme" && name !== "Field") expect(value).toBe(shared[name]);
  });
});

describe("applyGramTheme", () => {
  it("puts the person's stored mode and palette on <html>, as mounting does", () => {
    localStorage.setItem(
      "gram.theme",
      JSON.stringify({ state: { mode: "light", palette: "tokyo-light", motion: "reduced" } }),
    );
    lite.applyGramTheme();
    const root = document.documentElement;
    expect(root.dataset).toMatchObject({
      look: "glass",
      mode: "light",
      palette: "tokyo-light",
      motion: "reduced",
    });
  });

  it("puts the app's own palette in for Gram's default, with its stylesheet", () => {
    const seeds = {
      bg: "#0b0c0d",
      surface: "#0b0c0d",
      text: "#ecebe6",
      muted: "#8a887f",
      accent: "#ecebe6",
      accent2: "#c2a878",
      red: "#d27a6e",
      green: "#8fb58a",
      yellow: "#c2a878",
      cyan: "#7fa6b5",
    };
    lite.applyGramTheme({ name: "House", palettes: { dark: seeds } });
    expect(document.documentElement.dataset["palette"]).toBe("host-dark");
    expect(document.getElementById("gram-host-theme")?.textContent).toContain(
      '[data-palette="host-dark"]',
    );
  });

  it("boots the defaults where storage can't be read", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() => lite.applyGramTheme()).not.toThrow();
    expect(document.documentElement.dataset["palette"]).toBe("neutral-dark");
  });
});
