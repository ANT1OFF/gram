// Worker memory headers, fuzzed: a worker reads a memory file only when it has no header, or a
// closed `---` block that is a flat map of plain scalars with no `private` anywhere. Every unusual
// YAML feature, alone or mixed into otherwise plain headers, must be denied; plain ones allowed.
import { describe, expect, it } from "vitest";
import { workerMayEnter, workerMayRead } from "./memory.ts";

/** A small seeded PRNG (mulberry32), so a failure names a seed that reproduces it. */
const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const KEYS = ["title", "updated", "owner", "status", "repo", "topic"];
const VALUES = ["Plans", "2026-11-07", "3", "true", "null", "'ops'", '"a b"', "1.5"];

/** One feature a plain header never has, as a line or block to splice in. */
const UNUSUAL: ReadonlyArray<(pick: <T>(items: ReadonlyArray<T>) => T) => string> = [
  () => "private: true",
  () => "Private: no",
  () => "# private",
  (pick) => `${pick(KEYS)}: !!str ${pick(VALUES)}`,
  (pick) => `${pick(KEYS)}: !custom ${pick(VALUES)}`,
  (pick) => `${pick(KEYS)}: &anchor ${pick(VALUES)}`,
  () => "alias: *anchor",
  (pick) => `${pick(KEYS)}:\n  nested: ${pick(VALUES)}`,
  (pick) => `${pick(KEYS)}:\n  - ${pick(VALUES)}`,
  (pick) => `${pick(KEYS)}: [a, b]`,
  (pick) => `${pick(KEYS)}: {a: b}`,
  () => "note: |\n  text",
  () => "note: >\n  text",
  () => "<<: {title: x}",
  () => "? complex\n: key",
  () => "!!omap",
  () => "!!set",
  () => "%YAML 1.2",
];

const header = (lines: ReadonlyArray<string>) => `---\n${lines.join("\n")}\n---\nThe body.`;

describe("workerMayRead, by header", () => {
  it("allows no header, an empty one, and a flat map of plain scalars", () => {
    expect(workerMayRead("a.md", "Just a body.")).toBe(true);
    expect(workerMayRead("a.md", "---\n---\nBody.")).toBe(true);
    expect(workerMayRead("a.md", header(["title: Plans", "count: 3", "owner: 'ops'"]))).toBe(true);
  });

  it("denies the reviewer's cases: !!omap, !!set and private nested past eight levels", () => {
    expect(workerMayRead("a.md", header(["!!omap", "- title: x", "- private: true"]))).toBe(false);
    expect(workerMayRead("a.md", header(["!!set", "? private", "? title"]))).toBe(false);
    const deep = Array.from({ length: 12 }, (_, n) => `${"  ".repeat(n)}l${n}:`);
    expect(workerMayRead("a.md", header([...deep, `${"  ".repeat(12)}private: true`]))).toBe(false);
  });

  it("denies every unusual feature, alone or mixed into plain headers (fuzzed, 3,000 headers)", () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const random = prng(seed);
      const pick = <T>(items: ReadonlyArray<T>): T => items[Math.floor(random() * items.length)]!;
      const used = new Set<string>();
      const plain: Array<string> = [];
      for (let n = Math.floor(random() * 4); n > 0; n--) {
        const key = pick(KEYS);
        if (used.has(key)) continue;
        used.add(key);
        plain.push(`${key}: ${pick(VALUES)}`);
      }
      const unusual = Array.from({ length: 1 + Math.floor(random() * 2) }, () =>
        pick(UNUSUAL)(pick),
      );
      const lines = [...plain];
      for (const line of unusual) lines.splice(Math.floor(random() * (lines.length + 1)), 0, line);
      expect(workerMayRead("a.md", header(lines)), `seed ${seed}:\n${header(lines)}`).toBe(false);
      // The same plain lines alone are fine.
      expect(workerMayRead("a.md", header(plain)), `seed ${seed} plain`).toBe(true);
    }
  });

  it("denies headers it can't take as plain: unclosed, TOML, a leading comment, broken YAML", () => {
    for (const text of [
      "---\ntitle: Plans\nBody.",
      "+++\ntitle = 'Plans'\n+++\nBody.",
      "<!-- note -->\nBody.",
      "---\ntitle: [unclosed\n---\nBody.",
      "---\ntitle: a\ntitle: b\n---\nBody.",
      "---\njust a scalar\n---\nBody.",
      "----\nBody.",
    ]) {
      expect(workerMayRead("a.md", text), text).toBe(false);
    }
  });
});

// Synthetic credential shapes, joined from parts so no credential-shaped literal sits in the source.
const GH = ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789AB"].join("_");
const PEM_BEGIN = ["-----BEGIN", "OPENSSH PRIVATE KEY-----"].join(" ");
const PEM_END = ["-----END", "OPENSSH PRIVATE KEY-----"].join(" ");
const SLACK = ["xoxb", "123456789012", "abcdefghijkl"].join("-");
const escaped = [...GH]
  .map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
  .join("");
const percent = [...GH].map((char) => `%${char.charCodeAt(0).toString(16)}`).join("");
const html = [...GH].map((char) => `&#${char.charCodeAt(0)};`).join("");
const base64 = Buffer.from(`token=${GH}`).toString("base64");
const AWS_ASSIGNMENT = `${["AWS", "SECRET", "ACCESS", "KEY"].join("_")}=${"abcdefghijklmnopqrstuv"}0123456789ABCDxyz`;
const SLACK_LONG = ["xoxb", "123456789012", "123456789012", "abcdefghijklmnopqrstuvwx"].join("-");
const USERINFO = ["amy", "orchard-willow"].join(":");
const HEX_TEXT = Buffer.from(["pass", "word=abcdefgh"].join("")).toString("hex");
const SPACED_BASE64 = (
  Buffer.from(GH)
    .toString("base64")
    .match(/.{1,3}/g) ?? []
).join(" ");
const WRAPPED_BY_4 = (
  Buffer.from(GH)
    .toString("base64")
    .match(/.{1,4}/g) ?? []
).join("\n");
/** `GH` in base64, wrapped every 12 characters as the reviewer sent it. */
const WRAPPED_BASE64 = (
  Buffer.from(GH)
    .toString("base64")
    .match(/.{1,12}/g) ?? []
).join("\n");

/**
 * Every case from the reviews of #198, rounds 3 to 9, as one table: the path and text a worker would
 * read, and whether it may. A file a worker may not read is dropped whole: nothing in it is shown.
 */
const CASES: ReadonlyArray<readonly [label: string, path: string, text: string, allowed: boolean]> =
  [
    // Allowed: no header, an empty one, a flat plain one; ordinary prose.
    ["no header", "a.md", "Tabs, not spaces.", true],
    ["empty header", "a.md", "---\n---\nBody.", true],
    ["flat plain header", "a.md", "---\ntitle: Plans\nupdated: 2026-11-07\n---\nBody.", true],
    // Round 3: private names and folders, credential-shaped names, private front matter.
    ["private folder", "private/plans.md", "Body.", false],
    ["*.private.md", "people.private.md", "Body.", false],
    ["token-named", "deploy-token.md", "Body.", false],
    ["api-keys-named", "api-keys.md", "Body.", false],
    ["private: true", "a.md", "---\nprivate: true\n---\nBody.", false],
    // Round 4: more credential names, credential text.
    ["key-named", "deploy-key.md", "Body.", false],
    ["auth dotfile", ".npmrc", "Body.", false],
    ["auth-named", "github-auth.md", "Body.", false],
    ["PEM block", "a.md", `${PEM_BEGIN}\nb3Blbg==\n${PEM_END}`, false],
    ["Slack token", "a.md", `Webhook ${SLACK}`, false],
    // Round 5: private front matter inside a comment, or in another form.
    ["commented front matter", "a.md", "<!--\n---\nprivate: true\n---\n-->\nBody.", false],
    ["inline comment", "a.md", "<!-- private: true -->\nBody.", false],
    ["YAML comment", "a.md", "---\ntitle: Plans\n# private: true\n---\nBody.", false],
    ["TOML", "a.md", '+++\nprivate = "yes"\n+++\nBody.', false],
    ["bare private", "a.md", "---\nprivate\n---\nBody.", false],
    // Round 6: flow style, nesting, broken YAML.
    ["flow map", "a.md", "---\n{private: true}\n---\nBody.", false],
    ["nested", "a.md", "---\nmeta:\n  private: true\n---\nBody.", false],
    ["broken", "a.md", "---\ntitle: [unclosed\n---\nBody.", false],
    ["private: false", "a.md", "---\nprivate: false\n---\nBody.", false],
    // Round 7: tags and deep nesting.
    ["!!omap", "a.md", "---\n!!omap\n- private: true\n---\nBody.", false],
    ["!!set", "a.md", "---\n!!set\n? private\n---\nBody.", false],
    ["explicit key", "a.md", "---\n? title\n: Plans\n---\nBody.", false],
    // Round 8: a `...` close, auth headers and cookies, escaped and encoded tokens.
    ["... close hides private", "a.md", "---\ntitle: Plans\n...\nprivate: true\n---\nBody.", false],
    ["... close alone", "a.md", "---\ntitle: Plans\n...\nBody.", false],
    ["authorization header", "a.md", "authorization: bearer abc", false],
    ["Authorization in prose", "a.md", "Send Authorization: Basic with the build.", false],
    ["cookie", "a.md", "cookie: session=abc123", false],
    ["set-cookie", "a.md", "Set-Cookie: id=1", false],
    ["unicode-escaped token", "a.md", `"${escaped}"`, false],
    ["percent-encoded token", "a.md", `see ${percent}`, false],
    ["HTML-encoded token", "a.md", `see ${html}`, false],
    ["base64-encoded token", "a.md", `blob ${base64}`, false],
    // Round 8: delimiters left open, behind which a credential could hide.
    ["truncated PEM", "a.md", `${PEM_BEGIN}\nb3Blbg==`, false],
    ["unclosed code fence", "a.md", "```\nsomething\n", false],
    ["unbalanced quote around a run", "a.md", `value: "${"A".repeat(24)}`, false],
    // Round 9: `_` as a separator, names, nested and mixed encodings, short base64, escapes,
    // entities, Unicode lookalikes and zero-width characters.
    ["AWS_SECRET_ACCESS_KEY=", "a.md", "AWS_SECRET_ACCESS_KEY=abc", false],
    ["session header", "a.md", "x-session: 1", false],
    ["short Basic", "a.md", "Basic dXNlcjpw", false],
    ["short padded base64", "a.md", "blob dG9rZW4=", false],
    ["wrapped base64", "a.md", "Z2hwX2FiY2RlZmdo\naWprbG1ub3BxcnN0", false],
    ["mixed run of 16", "a.md", "id a1b2c3d4e5f6g7h8", false],
    ["uncited hex run of 20", "a.md", "id 0123456789abcdef0123", false],
    ["nested encoding", "a.md", "see %5Cu0067hp", false],
    ["greedy unicode escape", "a.md", "see \\u{67}hp", false],
    ["bad percent before a good one", "a.md", "see %zz%67hp", false],
    ["uppercase HTML hex", "a.md", "see &#X67;hp", false],
    ["named entity", "a.md", "a &amp; b", false],
    ["lookalike letter", "a.md", "see \u1E6Doken", false],
    ["zero-width inside a word", "a.md", "see to\u200Bken", false],
    ["fullwidth letters", "a.md", "\uFF54\uFF4F\uFF4B\uFF45\uFF4E", false],
    ["MEMORY.md, not a plain name", "MEMORY.md", "The index.", false],
    ["underscore name", "notes_v2.md", "Body.", false],
    ["keyword in a name", "aws-secret.md", "Body.", false],
    ["keyword in a folder", "session/notes.md", "Body.", false],
    // Round 9, the reviewer's exact payloads (findings 1 to 8).
    ["1: AWS key assignment", "a.md", AWS_ASSIGNMENT, false],
    ["2: token as a filename", `${GH}.md`, "Ordinary prose.", false],
    ["3: nested percent", "a.md", "%2563ookie: sid=abc123", false],
    ["3: mixed percent and HTML", "a.md", "author%69zat&#105;on: abc123", false],
    ["4: short base64", "a.md", "cGFzc3dvcmQ9YWJj", false],
    ["4: short Basic", "a.md", "Basic YTpi", false],
    ["5: four-digit escape", "a.md", "\\u0062earer abcdefghijklmnop", false],
    ["6: bad percent shields a good one", "a.md", "%FF%63ookie: sid=abc123", false],
    ["7: uppercase HTML hex", "a.md", "&#X63;ookie: sid=abc123", false],
    ["8: fullwidth label", "a.md", "\uFF43\uFF4F\uFF4F\uFF4B\uFF49\uFF45: sid=abc123", false],
    ["8: zero-width label", "a.md", `coo${String.fromCharCode(0x200b)}kie: sid=abc123`, false],
    ["letters-only base64 of text", "a.md", "see YWJjZGVm", false],
    // Round 10, the reviewer's exact payloads (findings 1 to 5), and their class.
    ["10.1: wrapped base64, as sent", "a.md", WRAPPED_BASE64, false],
    ["10.1: base64 split by spaces", "a.md", `blob ${SPACED_BASE64} done`, false],
    ["10.1: base64 split every 4 over lines", "a.md", WRAPPED_BY_4, false],
    ["10.2: Slack token as a name", `${SLACK}.md`, "Ordinary prose.", false],
    ["10.2: longer Slack token as a name", `${SLACK_LONG}.md`, "Ordinary prose.", false],
    ["10.2: token in a folder name", `${SLACK}/notes.md`, "Ordinary prose.", false],
    ["10.3: URL userinfo", "url.md", `https://${USERINFO}@example.test/`, false],
    ["10.3: connection string", "url.md", `postgresql://${USERINFO}@db.example.test/app`, false],
    [
      "10.4: 40 mixed past hex, after at",
      "a.md",
      `Landed at ${"0123456789abcdefghij".repeat(2)}.`,
      false,
    ],
    ["10.4: hex-encoded text, after at", "a.md", `Landed at ${HEX_TEXT}.`, false],
    // Plain prose a worker still reads: not over-blocked.
    ["a word on each line", "days.md", "Mondays\nTuesdays\nWednesdays\nrelease-notes", true],
    [
      "10.4: a decision with its commit",
      "decisions.md",
      "2026-11-07: PR #198 landed at 0123456789abcdef0123456789abcdef01234567.",
      true,
    ],
    ["10.4: a short head", "decisions.md", "Reviewed at head e0d0a61, then fixed.", true],
    ["10.4: a SHA with an ellipsis", "decisions.md", "Merged as 3b64ac47\u2026 on Friday.", true],
    ["10.4: commit and sha", "decisions.md", "See commit 720331533d7451d6 and sha: abc1234.", true],
    [
      "10.5: a file in a folder",
      "repos/api.md",
      "2026-11-07: PR #198 uses the daily schedule.",
      true,
    ],
    ["10.5: a nested folder", "repos/gram/notes.md", "Ordinary prose.", true],
    ["plain names with numbers", "release-notes-2026-11-07.md", "Ordinary prose.", true],
    ["a word that starts like a prefix", "github-actions.md", "Ordinary prose.", true],
    ["a URL with no userinfo", "links.md", "Docs live at https://example.test/docs/start.", true],
    ["tabs, not spaces", "conventions.md", "Use tabs, not spaces.", true],
    [
      "typographic punctuation",
      "style/voice.md",
      "\u201CShip small\u201D \u2014 never rebase\u2026 \u2022 squash merges.",
      true,
    ],
    ["paths and versions", "release.md", "Release notes go in CHANGELOG.md before 1.10.1.", true],
    ["a short path", "repo-layout.md", "Server tests live in packages/server/src.", true],
    [
      "dates and times",
      "schedule.md",
      "---\ntitle: Weekly\nupdated: 2026-11-07\n---\nRuns at 09:00 on Mondays.",
      true,
    ],
  ];

describe("workerMayRead, every review's cases", () => {
  it.each(CASES)("%s", (_label, path, text, allowed) => {
    expect(workerMayRead(path, text)).toBe(allowed);
  });
});

describe("workerMayEnter", () => {
  it("goes into plain folders only, none named for a credential", () => {
    for (const path of ["repos", "repos/shop", "release-notes"]) {
      expect(workerMayEnter(path), path).toBe(true);
    }
    for (const path of [".git", "Repos", "private", "session", "repos/api_keys", "a b", "ok.md"]) {
      expect(workerMayEnter(path), path).toBe(false);
    }
  });
});
