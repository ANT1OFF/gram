import { describe, expect, it } from "vitest";

import { quitPage } from "./quit-page.ts";

const colors = { background: "#111", foreground: "#eee" };

describe("progress window page", () => {
  it("offers Quit Now on a quit, and not while an update stops the app", () => {
    expect(quitPage(colors)).toContain('id="now"');
    const update = quitPage(colors, { heading: "Restarting to update…", quitNow: false });
    expect(update).not.toContain("<button");
  });
});
