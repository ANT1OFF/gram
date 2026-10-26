import { describe, expect, it } from "vitest";
import {
  assetNames,
  checksumLines,
  classifyTitle,
  compareVersions,
  defaultWorkPrefix,
  groupTitles,
  minutes,
  nextRcVersion,
  parseArgs,
  renderNotes,
  renderRecord,
  rerunFiles,
  resolveSigning,
  summarizeVitest,
  updaterManifestName,
  uploadNames,
  validateStableTarget,
  validateTarget,
  versionFields,
  workPathProblem,
} from "./rc-lib.mjs";

describe("versions", () => {
  it("orders prereleases numerically and below the release", () => {
    expect(compareVersions("0.1.0-rc.10", "0.1.0-rc.9")).toBeGreaterThan(0);
    expect(compareVersions("0.1.0-rc.16", "0.1.0")).toBeLessThan(0);
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("0.2.0-rc.1", "0.1.9")).toBeGreaterThan(0);
  });

  it("counts the next RC from the highest tag, not the order tags arrive in", () => {
    const tags = ["v0.1.0-rc.9", "v0.1.0-rc.15", "v0.1.0-rc.13", "not-a-version"];
    expect(nextRcVersion(tags, "0.1.0-rc.15")).toBe("0.1.0-rc.16");
  });

  it("uses main's RC when nobody has tagged it yet", () => {
    expect(nextRcVersion(["v0.1.0-rc.15"], "0.1.0-rc.17")).toBe("0.1.0-rc.17");
  });

  it("asks for an explicit version after a stable tag or with no tags", () => {
    expect(() => nextRcVersion(["v0.1.0"], "0.1.0")).toThrow(/explicitly/);
    expect(() => nextRcVersion([], "0.1.0")).toThrow(/pass the version/);
  });

  const base = { publish: true, tags: ["v0.1.0-rc.15"], mainVersion: "0.1.0-rc.15" };
  it("accepts the next RC", () => {
    expect(() => validateTarget({ ...base, version: "0.1.0-rc.16" })).not.toThrow();
  });

  it("refuses stable versions and points at the stable path", () => {
    expect(() => validateTarget({ ...base, version: "0.1.0" })).toThrow(
      /RCs only.*release:rc --stable.*docs\/RELEASING\.md/,
    );
  });

  it("refuses versions the updater would not offer or accept", () => {
    expect(() => validateTarget({ ...base, version: "0.1.0-rc.15" })).toThrow(/exists/);
    expect(() => validateTarget({ ...base, version: "0.1.0-rc.14" })).toThrow(/not newer/);
    expect(() => validateTarget({ ...base, version: "0.1.0-beta.1" })).toThrow(/not an RC/);
    expect(() =>
      validateTarget({ ...base, mainVersion: "0.1.0-rc.20", version: "0.1.0-rc.16" }),
    ).toThrow(/outrank/);
  });

  it("allows a throwaway dry-run version only without publishing", () => {
    expect(() => validateTarget({ ...base, version: "0.0.0-dryrun.1" })).toThrow(/--draft/);
    expect(() =>
      validateTarget({ ...base, publish: false, version: "0.0.0-dryrun.1" }),
    ).not.toThrow();
  });
});

describe("stable versions", () => {
  const fields = { manifest: "1.0.0", root: "1.0.0", desktop: "1.0.0", lock: "1.0.0" };
  const tags = ["v0.3.1", "v0.4.0-rc.2"];

  it("accepts a newer stable version that every version field carries", () => {
    expect(() => validateStableTarget({ version: "1.0.0", tags, fields })).not.toThrow();
  });

  it("refuses an RC, an existing or older tag, and version fields that disagree", () => {
    expect(() => validateStableTarget({ version: "1.0.0-rc.1", tags, fields })).toThrow(
      /not a stable version/,
    );
    expect(() => validateStableTarget({ version: "0.3.1", tags, fields })).toThrow(/exists/);
    expect(() => validateStableTarget({ version: "0.4.0", tags: ["v0.5.0"], fields })).toThrow(
      /not newer/,
    );
    expect(() =>
      validateStableTarget({ version: "1.0.0", tags, fields: { ...fields, lock: "0.3.1" } }),
    ).toThrow(/merge the release PR first.*lock is 0\.3\.1/);
    expect(() =>
      validateStableTarget({ version: "1.0.0", tags, fields: { ...fields, lock: undefined } }),
    ).toThrow(/lock is missing/);
  });

  it("reads the four version fields, the lock's by its desktop entry", () => {
    const lock = `{\n  "workspaces": {\n    "apps/desktop": {\n      "name": "@gram/desktop",\n      "version": "1.0.0",\n    },\n  },\n}`;
    expect(
      versionFields({
        manifest: '{ ".": "1.0.0" }',
        rootPackage: '{ "version": "1.0.0" }',
        desktopPackage: '{ "version": "0.9.0" }',
        lock,
      }),
    ).toEqual({ manifest: "1.0.0", root: "1.0.0", desktop: "0.9.0", lock: "1.0.0" });
  });

  it("takes the stable path's first phase: signed, a draft at most", () => {
    expect(parseArgs(["--stable", "1.0.0"])).toMatchObject({
      stable: true,
      version: "1.0.0",
      signing: "signed",
      draft: true,
      publish: true,
    });
    expect(parseArgs(["--stable", "1.0.0", "--dry-run"])).toMatchObject({
      draft: false,
      publish: false,
    });
    expect(() => parseArgs(["--stable"])).toThrow(/needs the version/);
    expect(parseArgs(["--stable", "1.0.0", "--first-release"])).toMatchObject({
      firstRelease: true,
    });
    expect(() => parseArgs(["1.0.0-rc.1", "--first-release"])).toThrow(/for a stable release/);
    expect(() => parseArgs(["--stable", "1.0.0", "--unsigned"])).toThrow(/always signed/);
  });

  it("marks a stable build's notes as a draft's, for publish to replace", () => {
    const notes = renderNotes({
      version: "1.0.0",
      sha: "a".repeat(40),
      titles: [],
      signed: true,
      stable: true,
    });
    expect(notes).toContain("Draft of 1.0.0");
    expect(notes).toContain("`release:stable publish` replaces these notes");
    expect(notes).not.toMatch(/private/i);
    expect(notes).toContain("latest-mac.yml");
  });
});

describe("arguments", () => {
  it("reads the version and flags", () => {
    expect(
      parseArgs(["v0.1.0-rc.16", "--draft", "--highlights", "h.md", "--bun", "/b"]),
    ).toMatchObject({
      bun: "/b",
      version: "0.1.0-rc.16",
      draft: true,
      publish: true,
      highlights: "h.md",
    });
  });

  it("refuses --latest, unknown flags and conflicting modes", () => {
    expect(() => parseArgs(["--latest"])).toThrow(/never marks a release latest/);
    expect(() => parseArgs(["--latest=true"])).toThrow(/latest/);
    expect(() => parseArgs(["--force"])).toThrow(/Unknown/);
    expect(() => parseArgs(["--draft", "--no-publish"])).toThrow(/not both/);
    expect(() => parseArgs(["--highlights"])).toThrow(/needs a value/);
  });
});

describe("assets", () => {
  it("names the six assets the private updater requires", () => {
    expect(assetNames("0.1.0-rc.16")).toEqual([
      "gram_0.1.0-rc.16_darwin-arm64_unsigned.zip",
      "BUILD-INFO.json",
      "BUNDLE-INVENTORY.json",
      "BUNDLE-SHA256SUMS.txt",
      "WEB-SHA256SUMS.txt",
      "SHA256SUMS.txt",
    ]);
  });

  it("uploads electron-updater's manifest beside the six assets for a signed build only", () => {
    expect(uploadNames("0.1.0-rc.17", true)).toEqual([
      ...assetNames("0.1.0-rc.17", true),
      "rc-mac.yml",
    ]);
    expect(uploadNames("0.1.0", true).at(-1)).toBe("latest-mac.yml");
    expect(uploadNames("0.1.0-rc.17")).toEqual(assetNames("0.1.0-rc.17"));
    expect(uploadNames("0.1.0-rc.17", false)).not.toContain("rc-mac.yml");
    expect(updaterManifestName("0.1.0-rc.17")).toBe("rc-mac.yml");
    expect(() => updaterManifestName("next")).toThrow();
  });

  it("writes shasum -c lines sorted by name", () => {
    const a = "a".repeat(64),
      b = "b".repeat(64);
    expect(
      checksumLines([
        { name: "b.zip", sha256: b },
        { name: "A.json", sha256: a },
      ]),
    ).toBe(`${a}  A.json\n${b}  b.zip\n`);
  });
});

describe("changelog", () => {
  it("groups squash titles into features, fixes and maintenance", () => {
    expect(classifyTitle("feat(files): open files as tabs (#120)")).toEqual({
      kind: "feature",
      text: "Open files as tabs (#120)",
    });
    expect(classifyTitle("fix(settings): show a charter change while it saves (#121)").kind).toBe(
      "fix",
    );
    expect(classifyTitle("Fix stale updater install IDs (#135)").kind).toBe("fix");
    expect(classifyTitle("Worker rail: live workers down the left (#192)").kind).toBe("feature");
    expect(classifyTitle("docs: record private RC13 (#132)").kind).toBe("maintenance");
    expect(classifyTitle("Teardown fence test: count a Linux zombie as ended (#167)").kind).toBe(
      "maintenance",
    );
    expect(classifyTitle("e2e: fix three specs that fail on main (#184)").kind).toBe("maintenance");
  });

  it("renders short notes with highlights, source and limits", () => {
    const notes = renderNotes({
      version: "0.1.0-rc.16",
      sha: "f".repeat(40),
      previousTag: "v0.1.0-rc.15",
      titles: ["Worker rail (#192)", "Fix a crash (#195)", "test: tidy (#196)"],
      highlights: "Faster releases.\n",
      check: "10 passed, 0 failed, 1 skipped",
    });
    expect(notes.startsWith("Faster releases.\n")).toBe(true);
    expect(notes).toContain("### Features\n\n- Worker rail (#192)");
    expect(notes).toContain("### Fixes\n\n- Fix a crash (#195)");
    expect(notes).toContain("Plus 1 maintenance change ");
    expect(notes).toContain(`built from \`${"f".repeat(40)}\``);
    expect(notes).toMatch(/Unsigned: ad-hoc/);
    expect(notes).toMatch(/No installed-update test/);
  });

  it("keeps notes under the updater's display bound", () => {
    const titles = Array.from(
      { length: 400 },
      (_, i) => `A feature with a long title number ${i} (#${i})`,
    );
    const notes = renderNotes({ version: "0.1.0-rc.16", sha: "f".repeat(40), titles });
    expect(notes.length).toBeLessThan(8_000);
    expect(notes).toContain("…and more.");
    expect(notes).toMatch(/Unsigned: ad-hoc/);
  });

  it("counts groups", () => {
    expect(groupTitles(["chore: x", "Fix y", "Z"])).toEqual({
      features: ["Z"],
      fixes: ["Fix y"],
      maintenance: 1,
    });
  });
});

const report = (files) => ({
  success: files.every((f) => f.status === "passed"),
  numPassedTests: 5,
  numFailedTests: files.filter((f) => f.status === "failed").length,
  numPendingTests: 2,
  numTodoTests: 0,
  testResults: files,
});
const timedOut = (name) => ({
  name: `/src/${name}`,
  status: "failed",
  message: "",
  assertionResults: [{ status: "failed", failureMessages: ["Error: Test timed out in 5000ms."] }],
});

describe("test results", () => {
  it("reruns only a few files that all timed out", () => {
    const summary = summarizeVitest(
      report([timedOut("a.test.ts"), { name: "/src/b.test.ts", status: "passed" }]),
      "/src",
    );
    expect(summary).toMatchObject({ passed: 5, failed: 1, skipped: 2, timeoutsOnly: true });
    expect(rerunFiles(summary)).toEqual(["a.test.ts"]);
  });

  it("stops on a real failure, too many timeouts or a pass", () => {
    const real = {
      ...timedOut("c.test.ts"),
      assertionResults: [
        { status: "failed", failureMessages: ["AssertionError: expected 1 to be 2"] },
      ],
    };
    expect(
      rerunFiles(summarizeVitest(report([timedOut("a.test.ts"), real]), "/src")),
    ).toBeUndefined();
    const many = ["a", "b", "c", "d"].map((n) => timedOut(`${n}.test.ts`));
    expect(rerunFiles(summarizeVitest(report(many), "/src"))).toBeUndefined();
    const suiteError = {
      name: "/src/e.test.ts",
      status: "failed",
      message: "Cannot find module",
      assertionResults: [],
    };
    expect(rerunFiles(summarizeVitest(report([suiteError]), "/src"))).toBeUndefined();
    expect(rerunFiles(summarizeVitest(report([]), "/src"))).toBeUndefined();
  });
});

describe("record", () => {
  it("rounds durations before splitting minutes", () => {
    expect(minutes(359.6)).toBe("6m 00s");
    expect(minutes(61)).toBe("1m 01s");
  });

  it("lists source, steps and asset hashes", () => {
    const text = renderRecord({
      version: "0.1.0-rc.16",
      sha: "f".repeat(40),
      previousTag: "v0.1.0-rc.15",
      url: "https://github.com/ANT1OFF/gram/releases/tag/v0.1.0-rc.16",
      draft: false,
      publishedAt: "2026-10-16T12:00:00Z",
      check: "10 passed, 0 failed, 1 skipped",
      steps: [{ name: "tests", seconds: 361 }],
      assets: [{ name: "SHA256SUMS.txt", bytes: 10, sha256: "a".repeat(64) }],
      totalSeconds: 900,
    });
    expect(text).toContain("# Gram 0.1.0-rc.16 release");
    expect(text).toContain("| tests | 6m 01s |");
    expect(text).toContain(`| \`SHA256SUMS.txt\` | 10 | \`${"a".repeat(64)}\` |`);
    expect(text).toContain("Total time: 15m 00s.");
  });
});

const line = (name, n = 1) => `  ${n}) ${"A".repeat(40)} "${name}"`;
const answered = () => true;
const signingNotes = (signed) =>
  renderNotes({
    version: "0.1.0-rc.17",
    sha: "a".repeat(40),
    titles: [],
    highlights: "",
    check: "",
    signed,
  });

describe("signing", () => {
  const TEAM = "FAKETEAM01";
  const id = `Developer ID Application: Example Person (${TEAM})`;
  const lines = [
    line(id),
    line("Apple Development: Example Person (OTHERTEAM1)", 2),
    "     2 valid identities found",
  ];
  const base = { mode: "auto", teamId: TEAM, identityLines: lines, profile: "gram-notary" };

  it("names the signed ZIP apart from the unsigned one", () => {
    expect(assetNames("0.1.0-rc.17", true)[0]).toBe("gram_0.1.0-rc.17_darwin-arm64_signed.zip");
    expect(assetNames("0.1.0-rc.17", true).slice(1)).toEqual(assetNames("0.1.0-rc.17").slice(1));
  });

  it("signs automatically with the one identity of the source's team and a working profile", () => {
    expect(resolveSigning({ ...base, checkProfile: answered })).toEqual({
      signed: true,
      identity: id,
      teamId: TEAM,
      profile: "gram-notary",
    });
  });

  it("falls back to unsigned in auto mode and says why, without asking Apple first", () => {
    let asked = 0;
    const checkProfile = () => (asked++, true);
    expect(resolveSigning({ ...base, teamId: null, checkProfile })).toMatchObject({
      signed: false,
      reason: expect.stringContaining("GRAM_MAC_TEAM_ID"),
    });
    expect(resolveSigning({ ...base, identityLines: [], checkProfile })).toMatchObject({
      signed: false,
      reason: expect.stringContaining("no valid Developer ID"),
    });
    expect(
      resolveSigning({
        ...base,
        identityLines: [...lines, line(`Developer ID Application: Other (${TEAM})`, 3)],
        checkProfile,
      }),
    ).toMatchObject({ signed: false, reason: expect.stringContaining("pass --identity") });
    expect(asked).toBe(0);
    expect(resolveSigning({ ...base, checkProfile: () => false })).toMatchObject({
      signed: false,
      reason: expect.stringContaining('"gram-notary" did not answer'),
    });
  });

  it("turns any reason into an error with --signed, and never signs with --unsigned", () => {
    expect(() =>
      resolveSigning({ ...base, mode: "signed", identityLines: [], checkProfile: answered }),
    ).toThrow(/--signed: no valid Developer ID/);
    expect(resolveSigning({ ...base, mode: "unsigned", checkProfile: answered })).toEqual({
      signed: false,
      reason: "--unsigned",
    });
  });

  it("refuses an explicit identity of another team or kind", () => {
    for (const identity of [
      "Developer ID Application: Example Person (OTHERTEAM1)",
      `Apple Development: Example Person (${TEAM})`,
    ])
      expect(() => resolveSigning({ ...base, identity, checkProfile: answered })).toThrow(
        /not a Developer ID/,
      );
    expect(
      resolveSigning({
        ...base,
        identity: `Developer ID Application: Missing (${TEAM})`,
        checkProfile: answered,
      }),
    ).toMatchObject({ signed: false, reason: expect.stringContaining("not a valid identity") });
  });

  it("parses the signing flags", () => {
    expect(parseArgs([]).signing).toBe("auto");
    expect(parseArgs(["--signed", "--identity", id, "--notary-profile", "p"])).toMatchObject({
      signing: "signed",
      identity: id,
      notaryProfile: "p",
    });
    expect(parseArgs(["--unsigned"]).signing).toBe("unsigned");
    expect(() => parseArgs(["--signed", "--unsigned"])).toThrow(/not both/);
    expect(() => parseArgs(["--unsigned", "--identity", id])).toThrow(/takes no/);
  });

  it("states the signing in the notes and record limits", () => {
    expect(signingNotes(true)).toContain(
      "Developer ID signed with the hardened runtime, notarized and stapled",
    );
    expect(signingNotes(true)).not.toContain("Unsigned:");
    expect(signingNotes(false)).toContain("Unsigned: ad-hoc linker signatures only");
  });
});

// mkdtemp adds six characters; /tmp resolves to /private/tmp on macOS.
const made = (version) => `/private${defaultWorkPrefix(version)}XXXXXX`;

describe("work dir", () => {
  it("leaves room for the tests' Unix sockets under the default, even for a long version", () => {
    expect(workPathProblem(made("0.1.0-rc.16"))).toBeUndefined();
    expect(workPathProblem(made("10.10.10-rc.999"))).toBeUndefined();
  });

  it("refuses a work dir like the old $TMPDIR default, whose socket paths reached 122 bytes", () => {
    const old = "/var/folders/fb/ms18q89j4lb1jh02wfrc_rvc0000gn/T/gram-rc-0.1.0-rc.16-iYoRj8";
    expect(workPathProblem(old)).toMatch(/too long: .* reach 122 bytes, over macOS's 103/);
  });
});
