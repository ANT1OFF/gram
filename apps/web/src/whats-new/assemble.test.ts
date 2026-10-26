import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  assembleReleases,
  compareVersionBase,
  highlightsFor,
  WHATS_NEW,
  whatsNewAudience,
  type WhatsNewItem,
  type WhatsNewShell,
} from "./index";

const item = (title: string, platform?: WhatsNewItem["platform"]): { default: WhatsNewItem } => ({
  default: { title, body: `${title} body`, ...(platform ? { platform } : {}) },
});

describe("assembleReleases", () => {
  it("groups fragments by version, newest first, ordered by slug", () => {
    const releases = assembleReleases({
      "./0.1.0/b-second.ts": item("second"),
      "./0.1.0/a-first.ts": item("first"),
      "./0.10.0/only.ts": item("ten"),
      "./0.2.0/only.ts": item("two"),
      "./not-a-version/x.ts": item("ignored"),
      "./index.ts": item("ignored too"),
    });
    expect(releases.map((r) => [r.version, r.highlights.map((h) => h.title)])).toEqual([
      ["0.10.0", ["ten"]],
      ["0.2.0", ["two"]],
      ["0.1.0", ["first", "second"]],
    ]);
  });

  it("assembles the shipped fragments into valid releases", () => {
    expect(WHATS_NEW.length).toBeGreaterThan(0);
    for (const release of WHATS_NEW) {
      expect(release.version).toMatch(/^\d+\.\d+\.\d+$/);
      for (const highlight of release.highlights) {
        expect(highlight.title.trim()).not.toBe("");
        expect(highlight.body.trim()).not.toBe("");
        // Bodies are plain text; `<kbd>` is the only markup the dialog reads.
        expect(highlight.body.replaceAll(/<\/?kbd>/g, "")).not.toMatch(/[<>]/);
      }
    }
  });
});

describe("compareVersionBase", () => {
  it("ignores prerelease suffixes and compares numerically", () => {
    expect(compareVersionBase("1.2.0-rc.1", "1.2.0")).toBe(0);
    expect(compareVersionBase("1.10.0", "1.9.3")).toBe(1);
    expect(compareVersionBase("0.1.0", "0.1.1")).toBe(-1);
  });
});

describe("highlightsFor", () => {
  it("hides other platforms' highlights, and shows all when the platform is unknown", () => {
    const [release] = assembleReleases({
      "./1.0.0/a.ts": item("everywhere"),
      "./1.0.0/b.ts": item("mac only", "darwin"),
    });
    expect(highlightsFor(release!, { platform: "win32" }).map((h) => h.title)).toEqual([
      "everywhere",
    ]);
    expect(highlightsFor(release!, {})).toHaveLength(2);
  });

  it("hides the other app's highlights, and shows all when the app is unknown", () => {
    const [release] = assembleReleases({
      "./1.0.0/a.ts": item("everywhere"),
      "./1.0.0/b.ts": { default: { title: "desktop only", body: "b", shell: "desktop" } },
    });
    const titles = (shell: WhatsNewShell | undefined) =>
      highlightsFor(release!, { shell }).map((h) => h.title);
    expect(titles("desktop")).toEqual(["everywhere", "desktop only"]);
    expect(titles(undefined)).toHaveLength(2);
  });
});

describe("whatsNewAudience", () => {
  it("is the desktop app on its platform, and unknown without the bridge", () => {
    expect(whatsNewAudience({ platform: "darwin" })).toEqual({
      platform: "darwin",
      shell: "desktop",
    });
    expect(whatsNewAudience({ platform: "win32" })).toEqual({
      platform: "win32",
      shell: "desktop",
    });
    expect(whatsNewAudience(undefined)).toEqual({
      platform: undefined,
      shell: undefined,
    });
  });
});

const WHATS_NEW_DIR = fileURLToPath(new URL(".", import.meta.url));
const versionDirs = readdirSync(WHATS_NEW_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name))
  .map((entry) => entry.name);
const fragmentsIn = (version: string) =>
  readdirSync(new URL(`./${version}/`, import.meta.url)).filter((name) => name.endsWith(".ts"));

const current: string = JSON.parse(
  readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"),
).version.split("-")[0];
describe("the first release's card set", () => {
  it("is a short set of complete cards", () => {
    const first = WHATS_NEW.find((release) => release.version === "1.0.0");
    expect(first?.highlights.length).toBeGreaterThan(0);
    expect(first?.highlights.length).toBeLessThanOrEqual(8);
  });
});

describe("fragment directories", () => {
  it("lists only Gram development and earlier versions", () => {
    expect(versionDirs).toContain(current);
    for (const version of versionDirs)
      expect(compareVersionBase(version, current)).toBeLessThanOrEqual(0);
  });
});

/** Every `v*` tag in this clone; none in CI's shallow checkout, which fetches no tags. */
const tags = (() => {
  try {
    return new Set(
      execFileSync("git", ["tag", "--list", "v*"], { cwd: WHATS_NEW_DIR, encoding: "utf8" })
        .split("\n")
        .filter((tag) => tag !== ""),
    );
  } catch {
    // Not a git checkout (an unpacked source tarball): there is nothing to compare against.
    return new Set<string>();
  }
})();

describe.skipIf(tags.size === 0)(
  "fragment directories, against release tags (skipped with none fetched)",
  () => {
    it("add nothing to a version once it is tagged", () => {
      for (const version of versionDirs.filter((dir) => tags.has(`v${dir}`))) {
        const shipped = execFileSync(
          "git",
          ["ls-tree", "-r", "--name-only", `v${version}`, "--", `${version}/`],
          { cwd: WHATS_NEW_DIR, encoding: "utf8" },
        )
          .split("\n")
          .map((path) => path.split("/").at(-1) ?? "");
        const added = fragmentsIn(version).filter((name) => !shipped.includes(name));
        // The app shows a user only the versions after the last one they saw, so a highlight added
        // under a released version is never shown to anyone who has it.
        expect(
          added,
          `added to ${version}/ after v${version}; move them to the next version`,
        ).toEqual([]);
      }
    });
  },
);
