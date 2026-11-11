// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { bootTheme } from "./theme-boot";

const stored = (state: object) => ({ getItem: () => JSON.stringify({ state }) });

describe("the theme before first paint, on a page that isn't Gram's own", () => {
  it("boots the defaults with nothing stored", () => {
    const root = document.createElement("html");
    bootTheme(root, { getItem: () => null }, () => false);
    expect(root.dataset).toMatchObject({
      look: "glass",
      mode: "dark",
      palette: "neutral-dark",
      motion: "system",
    });
    expect(root.hasAttribute("data-theme-booting")).toBe(true);
  });

  it("paints a stored palette as its partner in the other mode", () => {
    const root = document.createElement("html");
    bootTheme(root, stored({ mode: "light", palette: "tokyo-night", motion: "off" }), () => false);
    expect(root.dataset).toMatchObject({ mode: "light", palette: "tokyo-light", motion: "off" });
    bootTheme(root, stored({ mode: "system", palette: "tokyo-light" }), () => false);
    expect(root.dataset).toMatchObject({ mode: "dark", palette: "tokyo-night", motion: "system" });
  });

  it("keeps a look the page set, and survives unreadable storage", () => {
    const root = document.createElement("html");
    root.dataset["look"] = "flat";
    bootTheme(root, { getItem: () => "{nope" }, () => true);
    expect(root.dataset).toMatchObject({ look: "flat", mode: "dark", palette: "neutral-dark" });
  });
});
