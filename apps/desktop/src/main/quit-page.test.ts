import { describe, expect, it } from "vitest";

import { quitPage } from "./quit-page.ts";

const colors = { background: "#111", foreground: "#eee" };

describe("progress window page", () => {
  it("is the quit's by default, with Quit Now", () => {
    const page = quitPage(colors);
    expect(page).toContain("Quitting Gram…</h1>");
    expect(page).toContain('id="now"');
  });

  it("shows an update's stop under its own heading, without Quit Now", () => {
    const page = quitPage(colors, { heading: "Restarting to update…", quitNow: false });
    expect(page).toContain("<title>Restarting to update</title>");
    expect(page).toContain("Restarting to update…</h1>");
    expect(page).not.toContain("<button");
  });
});
