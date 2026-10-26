import { describe, expect, it } from "vitest";

import type { WhatsNewRelease } from "./index";
import { whatsNewOnLaunch } from "./launch";

const RELEASES: WhatsNewRelease[] = [
  { version: "0.3.0", highlights: [{ title: "mac chips", body: "b", platform: "darwin" }] },
  { version: "0.2.0", highlights: [{ title: "grid", body: "b" }] },
  { version: "0.1.0", highlights: [{ title: "chat", body: "b" }] },
];

const titles = (decision: ReturnType<typeof whatsNewOnLaunch>) =>
  decision.kind === "show"
    ? decision.releases.map((r) => [r.version, r.highlights.map((h) => h.title)])
    : decision.kind;

describe("whatsNewOnLaunch", () => {
  it("shows every unseen version up to the running one, newest first", () => {
    expect(titles(whatsNewOnLaunch(RELEASES, "0.1.0", "0.3.0", { platform: "darwin" }))).toEqual([
      ["0.3.0", ["mac chips"]],
      ["0.2.0", ["grid"]],
    ]);
  });

  it("drops versions whose highlights are all for another platform", () => {
    expect(titles(whatsNewOnLaunch(RELEASES, "0.2.0", "0.3.0", { platform: "win32" }))).toBe(
      "record",
    );
    expect(titles(whatsNewOnLaunch(RELEASES, "0.1.0", "0.3.0", { platform: "win32" }))).toEqual([
      ["0.2.0", ["grid"]],
    ]);
  });

  it("ignores a prerelease suffix when comparing and never shows future versions", () => {
    expect(titles(whatsNewOnLaunch(RELEASES, "0.1.0", "0.2.0-rc.1", {}))).toEqual([
      ["0.2.0", ["grid"]],
    ]);
    expect(titles(whatsNewOnLaunch(RELEASES, "0.2.0-rc.1", "0.2.0", {}))).toBe("record");
  });

  it("records quietly on a first run, a downgrade or an earlier version line", () => {
    expect(whatsNewOnLaunch(RELEASES, undefined, "0.3.0", {}).kind).toBe("record");
    expect(whatsNewOnLaunch(RELEASES, "1.9.0", "0.3.0", {}).kind).toBe("record");
    expect(whatsNewOnLaunch(RELEASES, "not a version", "0.3.0", {}).kind).toBe("record");
  });

  it("does nothing when already recorded or the version is unknown", () => {
    expect(whatsNewOnLaunch(RELEASES, "0.3.0", "0.3.0", {}).kind).toBe("none");
    expect(whatsNewOnLaunch(RELEASES, "0.1.0", "dev", {}).kind).toBe("none");
  });
});
