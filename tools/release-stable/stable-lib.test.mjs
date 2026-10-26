import { describe, expect, it } from "vitest";

import {
  parseStableArgs,
  publicLinkProblem,
  publicNotesProblems,
  releaseProblems,
  renderPublicNotes,
} from "./stable-lib.mjs";

describe("arguments", () => {
  it("reads a phase, its work dir and its options", () => {
    expect(parseStableArgs(["publish", "--work", "/tmp/rel", "--dry-run"])).toMatchObject({
      phase: "publish",
      work: "/tmp/rel",
      dryRun: true,
    });
    expect(parseStableArgs(["update-check", "--work", "w", "--live"])).toMatchObject({
      phase: "update-check",
      live: true,
    });
  });

  it("refuses an unknown phase, no work dir and options that don't fit the phase", () => {
    expect(() => parseStableArgs(["release", "--work", "w"])).toThrow(/Name a phase/);
    expect(() => parseStableArgs(["public", "--work", "w"])).toThrow(/Name a phase/);
    expect(() => parseStableArgs(["validate"])).toThrow(/--work/);
    expect(() => parseStableArgs(["validate", "--work", "w", "--dry-run"])).toThrow(
      /writes nothing anyway/,
    );
    expect(() => parseStableArgs(["publish", "--work", "w", "--live"])).toThrow(/update-check/);
    expect(() => parseStableArgs(["publish", "--work", "w", "--public-repo", "a/b"])).toThrow(
      /Unknown/,
    );
    expect(parseStableArgs(["publish", "--work", "w", "--notes", "n.md"]).notes).toBe("n.md");
    expect(() => parseStableArgs(["validate", "--work", "w", "--notes", "n.md"])).toThrow(
      /--notes is for publish/,
    );
  });
});

const has = (text, reason) => expect(publicNotesProblems(text)).toContain(reason);
const reasons = (text) => publicNotesProblems(text, { versions: ["1.0.0", "13.0"] });

describe("public notes", () => {
  const cards = [
    { title: "A flush chat pane", body: "The chat pane sits flush. Press <kbd>⌘K</kbd>." },
    { title: "Windows only", body: "Not on the Mac.", platform: "win32" },
  ];

  it("renders the version's cards, requirements and install steps, and nothing private", () => {
    const notes = renderPublicNotes({ version: "1.0.0", cards, minimumMacOS: "13.0" });
    expect(notes).toContain("- **A flush chat pane.** The chat pane sits flush. Press `⌘K`.");
    expect(notes).not.toContain("Windows only");
    expect(notes).toContain("macOS 13.0 or later on Apple silicon");
    expect(notes).toContain("gram_1.0.0_darwin-arm64_signed.zip");
    expect(notes).toContain("not affiliated with Anthropic or OpenAI");
    expect(publicNotesProblems(notes, { versions: ["1.0.0", "13.0"] })).toEqual([]);
  });

  it("says something even with no cards", () => {
    const notes = renderPublicNotes({ version: "1.0.1", cards: [], minimumMacOS: "13.0" });
    expect(notes).toMatch(/^Gram 1\.0\.1: fixes and improvements\./);
  });

  it("finds PR numbers and links, SHAs, IDs, test counts and process words", () => {
    has("Flush chat pane (#287)", "a PR or issue number (#123)");
    has("Fixed in PR 287 and GH-12", "a PR or issue number (PR 123)");
    has("See https://github.com/ANT1OFF/gram/pull/287", "a PR, issue or commit link");
    has("Built from 0768646d", "a commit SHA or digest");
    has("Submission b407120d-1e44-44a8-b8a4-8cb8921425c0", "a notarization or run ID");
    has("9,613 tests passed", "a test count");
    has("Private stable release", "the word “private”");
  });

  it("refuses what it doesn't know to be public: branches, paths, handles, hosts, encodings", () => {
    expect(
      reasons(
        "From codex/fix-customer-setting at /Users/release-user/code/gram/.worktrees/release by @release-user.\n",
      ),
    ).toEqual(
      expect.arrayContaining([
        "an @handle or e-mail address",
        "a path, branch or other slash-separated name",
      ]),
    );
    expect(reasons("See [the fix](https://github.com/ANT1OFF%2Fgram/pull/12)")).toEqual(
      expect.arrayContaining(["percent-encoded text"]),
    );
    expect(reasons("See [notes](https://intranet.example/notes)")).toEqual(
      expect.arrayContaining([
        "a host name",
        "a link that is not on https://github.com (https://intranet.example/notes)",
      ]),
    );
    expect(reasons("[x][1]\n\n[1]: https://gist.github.com/someone")).toContain(
      "a link that is not on https://github.com (https://gist.github.com/someone)",
    );
    expect(reasons("[x](notes.md)")).toContain(
      "a link that is not an absolute https link (notes.md)",
    );
    expect(reasons("Fixed &#35;287 and &commat;someone")).toContain("an HTML entity");
    expect(reasons('<a href="https://evil.example">hi</a>')).toContain("HTML");
    expect(reasons("Ask on www.example")).toContain("a host name");
    expect(reasons("Run C:\\Users\\me or ~/code")).toContain("a home or Windows path");
    expect(reasons("Mail mailto:someone")).toContain("a link scheme other than https");
    // `and/or` is excused only as a whole word.
    for (const name of ["command/orchestration", "brand/order", "and/or/x", "x/and/or"])
      expect(reasons(`From ${name}.`)).toContain("a path, branch or other slash-separated name");
    expect(reasons("Claude Code and/or Codex. AND/OR. And/Or.")).toEqual([]);
  });

  it("names no version but this release's, so no earlier changelog comes along", () => {
    expect(publicNotesProblems("Since 0.3.1: …", { versions: ["1.0.0"] })).toEqual([
      "another version (0.3.1)",
    ]);
    expect(publicNotesProblems("Gram 1.0.0 needs macOS 13.0.", { versions: ["1.0.0"] })).toEqual(
      [],
    );
    // No word boundary to hide behind: `v0.3.1`, `gram_0.4.0_…`, a prerelease.
    expect(
      publicNotesProblems("Replaces v0.3.1 and gram_0.4.0_x, not 1.0.0-rc.2.", {
        versions: ["1.0.0"],
      }),
    ).toEqual([
      "another version (0.3.1)",
      "another version (0.4.0)",
      "another version (1.0.0-rc.2)",
    ]);
  });

  it("lets plain text and links to the public repository through", () => {
    expect(
      publicNotesProblems(
        "## What's new\n\nClaude Code and/or Codex. Press `⌘K`. Download `gram_1.0.0_darwin-arm64_signed.zip` and check `SHA256SUMS.txt`. See [issues](https://github.com/ANT1OFF/gram/issues) or https://github.com/ANT1OFF/gram.",
        { versions: ["1.0.0"] },
      ),
    ).toEqual([]);
  });

  it("passes every notes text the tool renders", () => {
    const notes = renderPublicNotes({ version: "1.0.0", cards, minimumMacOS: "13.0" });
    expect(publicNotesProblems(notes, { versions: ["1.0.0", "13.0"] })).toEqual([]);
  });
});

const ok = (link) => expect(publicLinkProblem(link)).toBeUndefined();
const bad = (link, why) => expect(publicLinkProblem(link)).toMatch(why);
const inside = (text) => publicNotesProblems(text, { versions: ["1.0.0"] });

// Links are parsed, not prefix-matched, and the other rules read them too.
describe("public links", () => {
  it("accepts the public repository's own pages", () => {
    ok("https://github.com/ANT1OFF/gram");
    ok("https://github.com/ANT1OFF/gram/");
    ok("https://github.com/ANT1OFF/gram/releases/latest");
    ok("https://github.com/ANT1OFF/gram/releases/tag/v1.0.0");
    ok(
      "https://github.com/ANT1OFF/gram/releases/download/v1.0.0/gram_1.0.0_darwin-arm64_signed.zip",
    );
    ok("https://github.com/ANT1OFF/gram/issues/new/choose");
    ok("https://github.com/ANT1OFF/gram/blob/main/PRIVACY.md");
  });

  it("refuses dot segments, even ones that normalize back into the repository", () => {
    bad("https://github.com/ANT1OFF/gram/../gram-dev", /\. or \.\. segment/);
    bad("https://github.com/ANT1OFF/gram/../gram/issues", /\. or \.\. segment/);
    bad("https://github.com/ANT1OFF/gram/./issues", /\. or \.\. segment/);
  });

  it("refuses queries, fragments, credentials, ports, other hosts and other repositories", () => {
    bad("https://github.com/ANT1OFF/gram/issues?q=codex/fix-customer-setting", /query/);
    bad("https://github.com/ANT1OFF/gram/issues#@release-user", /fragment/);
    bad("https://github.com/ANT1OFF/gram?", /query/);
    bad("https://user:pw@github.com/ANT1OFF/gram", /credentials/);
    bad("https://github.com:8443/ANT1OFF/gram", /github\.com/);
    bad("http://github.com/ANT1OFF/gram", /github\.com/);
    bad("https://github.com.evil.example/ANT1OFF/gram", /github\.com/);
    bad("https://github.com/ANT1OFF/gram-dev", /not in ANT1OFF\/gram/);
    bad("https://github.com/ant1off/gram", /not in/);
  });

  it("refuses pages that aren't the public ones", () => {
    bad("https://github.com/ANT1OFF/gram/tree/codex/fix-customer-setting", /public page/);
    bad("https://github.com/ANT1OFF/gram/blob/main/Users/release-user/notes", /public page/);
    bad("https://github.com/ANT1OFF/gram/pull/12", /public page/);
  });

  it("reads the private-reference rules inside allowed links too", () => {
    expect(
      inside("See https://github.com/ANT1OFF/gram/issues?from=/Users/release-user/x@y"),
    ).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/query or fragment/),
        "an @handle or e-mail address",
      ]),
    );
    expect(inside("[see](https://github.com/ANT1OFF/gram/../gram-dev/pull/12)")).toEqual(
      expect.arrayContaining([expect.stringMatching(/\. or \.\. segment/)]),
    );
    expect(inside("Fixes bug#123.")).toContain("a PR or issue number (#123)");
    expect(inside("See https://github.com/ANT1OFF/gram/releases/tag/v0.3.1")).toContain(
      "another version (0.3.1)",
    );
  });
});

describe("releases", () => {
  const assets = ["gram_1.0.0_darwin-arm64_signed.zip", "latest-mac.yml", "SHA256SUMS.txt"].map(
    (name, i) => ({
      name,
      bytes: 10 + i,
      sha256: String(i).repeat(64),
    }),
  );
  const release = {
    tag_name: "v1.0.0",
    target_commitish: "b".repeat(40),
    draft: true,
    prerelease: false,
    assets: assets.map(({ name, bytes, sha256 }) => ({
      name,
      size: bytes,
      digest: `sha256:${sha256}`,
    })),
  };
  const want = { tag: "v1.0.0", target: "b".repeat(40), draft: true, assets };

  it("accepts a release that matches, and names each difference", () => {
    expect(releaseProblems(release, want)).toEqual([]);
    expect(
      releaseProblems(
        {
          ...release,
          prerelease: true,
          draft: false,
          assets: [
            { ...release.assets[0], digest: "sha256:ff" },
            ...release.assets.slice(1),
            { name: "BUILD-INFO.json", size: 1, digest: "sha256:00" },
          ],
        },
        want,
      ),
    ).toEqual([
      "draft is false",
      "marked prerelease",
      "4 assets, not 3",
      "gram_1.0.0_darwin-arm64_signed.zip: GitHub has sha256:ff/10 bytes",
    ]);
  });
});
