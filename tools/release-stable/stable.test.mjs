// The stable tool's phases end to end against a synthetic GitHub (testing/fake-github.mjs) and a
// fake `gh` (testing/fake-gh.mjs): the draft's validation, the read-only update check through the
// app's own feed, and publishing.
// macOS's verdicts on the app (codesign, Gatekeeper, stapler) need a signed build, so a stub
// stands in for them here; everything else is the tool's real code.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checksumLines } from "../release-rc/rc-lib.mjs";
import { parseStableArgs } from "./stable-lib.mjs";
import { committedSource, readPublicNotes, runPhase } from "./stable.mjs";
import { spawnFakeGitHub } from "./testing/fake-github.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(HERE, "../..");
const REPO = "ANT1OFF/gram";
// The checkout under test stands in for the release's source, so the tool finds it at that commit.
const SHA = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: SOURCE,
  encoding: "utf8",
}).stdout.trim();
const LOGIN = "login-secret-0123";
const AMBIENT = "ambient-secret-89ab";
const VERSION = "1.0.0";
const ZIP = `gram_${VERSION}_darwin-arm64_signed.zip`;
const TEAM = "ANVR857GFZ";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
// The fake gh starts once per REST request. Node startup dominated this fixture under load;
// use the already-required pinned Bun for that tiny CLI, retaining real child/environment/HTTP
// boundaries (including the nested update-check process). Production gh is unchanged.
const bun = spawnSync("bun", ["--print", "process.execPath"], { encoding: "utf8" });
const hasBun = bun.status === 0;
const bunPath = bun.stdout?.trim();

let github;
let root;
let work;
let env;
let ghLog;
let said;
let appChecks;

/** The assets `release:rc --stable` would leave, with a real manifest for the fake ZIP. */
async function makeAssets(dir) {
  mkdirSync(dir, { recursive: true });
  const zip = Buffer.from(`not really a zip ${Math.random()}`);
  writeFileSync(join(dir, ZIP), zip);
  writeFileSync(
    join(dir, "BUILD-INFO.json"),
    JSON.stringify({
      version: VERSION,
      sourceCommit: SHA,
      developerIdSigned: true,
      notarized: true,
      stapled: true,
      teamId: TEAM,
    }),
  );
  for (const name of ["BUNDLE-INVENTORY.json", "BUNDLE-SHA256SUMS.txt", "WEB-SHA256SUMS.txt"])
    writeFileSync(join(dir, name), `${name}\n`);
  const { renderNativeManifest } = await import(
    pathToFileURL(join(SOURCE, "packages/shell/src/modules/update/native-release.ts")).href
  );
  writeFileSync(
    join(dir, "latest-mac.yml"),
    renderNativeManifest({
      version: VERSION,
      zip: ZIP,
      sha512: createHash("sha512").update(zip).digest("base64"),
      size: zip.length,
      releaseDate: new Date().toISOString(),
    }),
  );
  const covered = [
    ZIP,
    "BUILD-INFO.json",
    "BUNDLE-INVENTORY.json",
    "BUNDLE-SHA256SUMS.txt",
    "WEB-SHA256SUMS.txt",
  ];
  writeFileSync(
    join(dir, "SHA256SUMS.txt"),
    checksumLines(covered.map((name) => ({ name, sha256: sha256(readFileSync(join(dir, name))) }))),
  );
  return [...covered, "SHA256SUMS.txt", "latest-mac.yml"].map((name) => {
    const bytes = readFileSync(join(dir, name));
    return { name, bytes: bytes.length, sha256: sha256(bytes) };
  });
}

/** An older signed release to update from, on `repo`. */
async function seedPrevious(repo, version) {
  const zipName = `gram_${version}_darwin-arm64_signed.zip`;
  const zip = Buffer.from(`old ${version}`);
  const { renderNativeManifest } = await import(
    pathToFileURL(join(SOURCE, "packages/shell/src/modules/update/native-release.ts")).href
  );
  const manifest = renderNativeManifest({
    version,
    zip: zipName,
    sha512: createHash("sha512").update(zip).digest("base64"),
    size: zip.length,
    releaseDate: new Date().toISOString(),
  });
  await github.seed({
    repo,
    tag: `v${version}`,
    assets: [
      { name: zipName, base64: zip.toString("base64") },
      { name: "latest-mac.yml", base64: Buffer.from(manifest).toString("base64") },
    ],
  });
}

const options = (phase, extra = []) => parseStableArgs([phase, "--work", work, ...extra]);

const seams = (overrides = {}) => ({
  source: SOURCE,
  api: github.origin,
  web: github.origin,
  gh: join(root, "bin", "gh"),
  env,
  say: (line) => said.push(line),
  // This checkout has no cards for the synthetic version: its notes come from a committed repo of
  // their own, through the real reader.
  readNotes: (args) => {
    const repo = notesRepo();
    return readPublicNotes({ ...args, source: repo.dir, commit: repo.commit });
  },
  verifyApp: async (zip, state) => {
    appChecks.push({ zip, sha256: sha256(readFileSync(zip)), version: state.version });
    return { stub: "macOS checks need a signed build" };
  },
  ...overrides,
});

/**
 * A synthetic GitHub holding `previous` (a published stable release, or none for a first release)
 * and this release's draft, and the work dir `release:rc --stable` would leave for it.
 */
async function setUp({ previous = "0.3.1", repo = {} } = {}) {
  github = await spawnFakeGitHub({
    [REPO]: { private: false, tokens: [LOGIN], head: SHA, ...repo },
  });
  root = mkdtempSync(join(tmpdir(), "gram-stable-"));
  work = join(root, "work");
  mkdirSync(join(root, "bin"));
  writeFileSync(
    join(root, "bin", "gh"),
    `#!/bin/sh\nexec "${bunPath}" "${join(HERE, "testing/fake-gh.mjs")}" "$@"\n`,
    { mode: 0o755 },
  );
  mkdirSync(join(root, "gh-login"));
  writeFileSync(join(root, "gh-login", "fake-login"), LOGIN);
  ghLog = join(root, "gh.log");
  env = {
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    HOME: root,
    TMPDIR: tmpdir(),
    FAKE_GITHUB: github.origin,
    FAKE_GH_LOG: ghLog,
    GH_CONFIG_DIR: join(root, "gh-login"),
    // Your shell's own gh settings, which no call may inherit.
    GH_TOKEN: AMBIENT,
    GH_HOST: "ghe.example.invalid",
  };
  said = [];
  appChecks = [];
  const assets = await makeAssets(join(work, "assets"));
  if (previous) await seedPrevious(REPO, previous);
  const draft = await github.seed({
    repo: REPO,
    tag: `v${VERSION}`,
    draft: true,
    target: SHA,
    assets: assets.map(({ name }) => ({
      name,
      base64: readFileSync(join(work, "assets", name)).toString("base64"),
    })),
  });
  writeFileSync(
    join(work, "release.json"),
    JSON.stringify({
      version: VERSION,
      tag: `v${VERSION}`,
      repo: REPO,
      source: SOURCE,
      sourceCommit: SHA,
      releaseId: draft.id,
      previousStable: previous,
      firstRelease: previous === null,
      zipName: ZIP,
      teamId: TEAM,
      minimumMacOS: "13.0",
      assets,
    }),
  );
}

beforeEach(() => setUp());

/** Starts again from `setUp(how)`, for a test that needs another repository. */
const again = async (how) => {
  await github.close();
  await setUp(how);
};

afterEach(async () => {
  await github.close();
});

describe.skipIf(!hasBun)("release:stable against a synthetic GitHub", () => {
  it("validates, checks and publishes with your own login", async () => {
    await runPhase(options("validate"), seams());
    expect(appChecks).toHaveLength(1);
    expect(
      JSON.parse(readFileSync(join(work, "validate.json"), "utf8")).checks.sha256sums,
    ).toContain(ZIP);

    const checked = await runPhase(options("update-check"), seams());
    expect(checked.asServed.map((r) => r.status)).toEqual(["upToDate", "upToDate"]);
    expect(checked.simulated.map((r) => [r.channel, r.status, r.version])).toEqual([
      ["stable", "available", VERSION],
      ["prerelease", "available", VERSION],
    ]);

    await runPhase(options("publish", ["--dry-run"]), seams());
    let state = await github.state();
    expect(state.repos[REPO].releases.find((r) => r.tag_name === `v${VERSION}`).draft).toBe(true);
    expect(state.log.filter((e) => e.method !== "GET")).toEqual([]);

    await runPhase(options("publish"), seams());
    state = await github.state();
    const published = state.repos[REPO].releases.find((r) => r.tag_name === `v${VERSION}`);
    expect(published.draft).toBe(false);
    expect(state.repos[REPO].latestId).toBe(published.id);
    expect(state.repos[REPO].tags[`v${VERSION}`]).toBe(SHA);
    // The draft's build notes gave way to the curated ones, and nothing private went with them.
    const notes = readFileSync(join(work, "public-notes.md"), "utf8");
    expect(notes).toContain("## Requirements");
    expect(notes).toContain("- **A reviewed card.** Press `⌘K`.");
    expect(published.body).toBe(notes);
    expect(notes).not.toMatch(/#\d|private|tests?\b|[0-9a-f]{40}/i);
    // Then read back with no credentials, as a stranger's install would.
    const record = JSON.parse(readFileSync(join(work, "publish.json"), "utf8"));
    expect(record.anonymous.latest).toBe(`v${VERSION}`);
    expect(record.anonymous.manifestSha256).toBe(
      sha256(readFileSync(join(work, "assets", "latest-mac.yml"))),
    );
    expect(
      state.log.some(
        (e) => e.path.endsWith("/releases/download/v1.0.0/latest-mac.yml") && !e.token,
      ),
    ).toBe(true);
    const live = await runPhase(options("update-check", ["--live"]), seams());
    expect(live.live.map((r) => r.status)).toEqual(["available", "available"]);

    // Every call used your own login; the ambient GH_TOKEN never reached GitHub.
    expect(state.log.every((e) => e.token === LOGIN || e.token === null)).toBe(true);
    expect(state.log.some((e) => e.token === AMBIENT)).toBe(false);
  }, 120_000);

  it("publishes a first release into an empty repository, checked as an install older than any", async () => {
    await again({ previous: null });
    await runPhase(options("validate"), seams());
    const checked = await runPhase(options("update-check"), seams());
    expect(checked.as).toBe("0.0.0");
    expect(checked.simulated.map((r) => r.status)).toEqual(["available", "available"]);
    await runPhase(options("publish"), seams());
    const state = await github.state();
    expect(state.repos[REPO].releases.map((r) => [r.tag_name, r.draft])).toEqual([
      [`v${VERSION}`, false],
    ]);
  }, 120_000);

  it("refuses a first release once the repository holds another release or tag", async () => {
    await again({ previous: null });
    await runPhase(options("validate"), seams());
    await runPhase(options("update-check"), seams());
    await seedPrevious(REPO, "0.9.0");
    await expect(runPhase(options("publish"), seams())).rejects.toThrow(
      /drafted as the first release, but ANT1OFF\/gram now holds release v0\.9\.0, tag v0\.9\.0/,
    );
    const state = await github.state();
    expect(state.repos[REPO].releases.find((r) => r.tag_name === `v${VERSION}`).draft).toBe(true);
  }, 120_000);

  it("refuses to publish when latest moved, the tag exists or the repository answers as another", async () => {
    await runPhase(options("validate"), seams());
    await runPhase(options("update-check"), seams());
    const draft = () =>
      github.state().then((s) => s.repos[REPO].releases.find((r) => r.tag_name === `v${VERSION}`));

    await seedPrevious(REPO, "0.4.0");
    await expect(runPhase(options("publish"), seams())).rejects.toThrow(
      /latest is v0\.4\.0, not v0\.3\.1 as when drafted/,
    );
    expect((await draft()).draft).toBe(true);

    await again({ repo: { fullName: "ANT1OFF/gram-dev" } });
    await runPhase(options("validate"), seams());
    await runPhase(options("update-check"), seams());
    await expect(runPhase(options("publish"), seams())).rejects.toThrow(
      /ANT1OFF\/gram answers as ANT1OFF\/gram-dev/,
    );
    expect((await draft()).draft).toBe(true);
  }, 120_000);

  it("takes hand-written notes only from the reviewed source, and refuses leaking ones", async () => {
    await runPhase(options("validate"), seams());
    await runPhase(options("update-check"), seams());
    const notes = join(root, "notes.md");
    writeFileSync(notes, "Fixed in #123, see /Users/release-user/code/gram.\n");
    await expect(runPhase(options("publish", ["--notes", notes]), seams())).rejects.toThrow(
      /reviewed content of the release's source: .*outside the release's source checkout/,
    );
    const state = await github.state();
    expect(state.log.filter((e) => e.method !== "GET")).toEqual([]);
  }, 60_000);

  it("checks a release whose publish answer was lost", async () => {
    await runPhase(options("validate"), seams());
    await runPhase(options("update-check"), seams());
    env.FAKE_GH_DROP_RESPONSE = "PATCH repos/ANT1OFF/gram/releases/\\d+ ";
    const result = await runPhase(options("publish"), seams());
    expect(result.url).toMatch(/v1\.0\.0$/);
    const state = await github.state();
    const published = state.repos[REPO].releases.find((r) => r.tag_name === `v${VERSION}`);
    expect(published.draft).toBe(false);
    expect(state.repos[REPO].latestId).toBe(published.id);
  }, 60_000);

  it("won't publish before validation, nor after the draft changed", async () => {
    await expect(runPhase(options("publish"), seams())).rejects.toThrow(
      /run release:stable validate first/,
    );
    await runPhase(options("validate"), seams());
    await runPhase(options("update-check"), seams());
    const state = JSON.parse(readFileSync(join(work, "release.json"), "utf8"));
    state.assets[0].sha256 = "0".repeat(64);
    writeFileSync(join(work, "release.json"), JSON.stringify(state));
    await expect(runPhase(options("publish"), seams())).rejects.toThrow(
      /validate.json is for other assets/,
    );
  }, 60_000);
});

/**
 * A git repository standing in for the release's source: committed hand-written notes and a
 * What's New card for 1.0.0. Returns its folder, its commit and git in it.
 */
const notesRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), "gram-notes-source-"));
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  mkdirSync(join(dir, "notes"));
  writeFileSync(join(dir, "notes", "1.0.0.md"), "Gram 1.0.0.\n");
  const cards = join(dir, "apps/web/src/whats-new/1.0.0");
  mkdirSync(cards, { recursive: true });
  writeFileSync(
    join(cards, "01-card.ts"),
    'export default { title: "A reviewed card", body: "Press <kbd>⌘K</kbd>." };\n',
  );
  git("add", ".");
  git(
    "-c",
    "user.name=Synthetic",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "notes",
  );
  return { dir, commit: git("rev-parse", "HEAD").stdout.trim(), git, cards };
};

const notesOptions = (repo, extra = {}) => ({
  source: repo.dir,
  commit: repo.commit,
  version: "1.0.0",
  minimumMacOS: "13.0",
  scratch: mkdtempSync(join(tmpdir(), "gram-notes-scratch-")),
  ...extra,
});

describe("notes from the release commit", () => {
  it("refuses to publish with no notes source: no cards in the release commit and no --notes", async () => {
    const repo = notesRepo();
    repo.git("rm", "-rq", "apps/web/src/whats-new");
    repo.git(
      "-c",
      "user.name=S",
      "-c",
      "user.email=s@example.invalid",
      "commit",
      "-qm",
      "no cards",
    );
    const commit = repo.git("rev-parse", "HEAD").stdout.trim();
    await expect(readPublicNotes(notesOptions({ ...repo, commit }))).rejects.toThrow(
      /has no What's New cards for 1\.0\.0.*pass --notes/,
    );
    // An empty folder is no source either.
    mkdirSync(repo.cards, { recursive: true });
    writeFileSync(join(repo.cards, "README.md"), "Cards go here.\n");
    repo.git("add", ".");
    repo.git("-c", "user.name=S", "-c", "user.email=s@example.invalid", "commit", "-qm", "empty");
    const empty = repo.git("rev-parse", "HEAD").stdout.trim();
    await expect(readPublicNotes(notesOptions({ ...repo, commit: empty }))).rejects.toThrow(
      /holds no cards/,
    );
    // Explicit notes are still taken.
    expect(
      await readPublicNotes(
        notesOptions({ ...repo, commit: empty }, { notesFile: join(repo.dir, "notes/1.0.0.md") }),
      ),
    ).toBe("Gram 1.0.0.\n");
  });

  it("lets ordinary product sentences with numbers through", async () => {
    for (const fine of [
      "Failed 2FA requests now show a helpful error.",
      "Fixed 2 failed uploads.",
      "Retries 3 times, then says what failed.",
      "Shows the 5 newest threads first.",
      "Uploads that failed 3 times now retry later.",
      "Lists 4 skipped steps in the summary.",
    ]) {
      const repo = notesRepo();
      writeFileSync(join(repo.dir, "notes", "1.0.0.md"), `Gram 1.0.0. ${fine}\n`);
      repo.git("add", ".");
      repo.git("-c", "user.name=S", "-c", "user.email=s@example.invalid", "commit", "-qm", "ok");
      const commit = repo.git("rev-parse", "HEAD").stdout.trim();
      expect(
        await readPublicNotes(
          notesOptions({ ...repo, commit }, { notesFile: join(repo.dir, "notes/1.0.0.md") }),
        ),
        fine,
      ).toBe(`Gram 1.0.0. ${fine}\n`);
    }
  });

  it("refuses committed notes that carry PR references, test counts or SHAs in ordinary forms", async () => {
    for (const leak of [
      "Tests: 9613 passed; PR: 287.",
      "PR-287 and PRs 288.",
      "Pull request no. 12.",
      "9,613 passed, 52 skipped.",
      "Built from deadbeef.",
      "Built from **0768646d**.",
      "Built from 07686\u200b46d.",
      "Fixed in **#**287.",
      "Passed ９６１３.",
      "Ships from build.**widgets**.internal.",
      "Replaces 0.**3**.1.",
      "From codex／fix-customer.",
      "Passed: 9613.",
      "Test results: 9,613 passed successfully.",
      "Passed 9613 checks.",
      "9613 successfully passed.",
    ]) {
      const repo = notesRepo();
      writeFileSync(join(repo.dir, "notes", "1.0.0.md"), `Gram 1.0.0. ${leak}\n`);
      repo.git("add", ".");
      repo.git("-c", "user.name=S", "-c", "user.email=s@example.invalid", "commit", "-qm", "leak");
      const commit = repo.git("rev-parse", "HEAD").stdout.trim();
      await expect(
        readPublicNotes(
          notesOptions({ ...repo, commit }, { notesFile: join(repo.dir, "notes/1.0.0.md") }),
        ),
        leak,
      ).rejects.toThrow(/the notes carry/);
    }
  });

  it("reads committed notes and cards from the commit itself", async () => {
    const repo = notesRepo();
    expect(committedSource(repo.dir, repo.commit, join(repo.dir, "notes", "1.0.0.md"))).toEqual({
      files: [{ name: "1.0.0.md", text: "Gram 1.0.0.\n" }],
    });
    expect(
      await readPublicNotes(notesOptions(repo, { notesFile: join(repo.dir, "notes/1.0.0.md") })),
    ).toBe("Gram 1.0.0.\n");
    expect(await readPublicNotes(notesOptions(repo))).toContain(
      "- **A reviewed card.** Press `⌘K`.",
    );
  });

  it("refuses a file outside the source, an uncommitted one and a changed one", () => {
    const repo = notesRepo();
    const read = (path) => committedSource(repo.dir, repo.commit, path).problem;
    expect(read(join(tmpdir(), "notes.md"))).toMatch(/outside/);
    writeFileSync(join(repo.dir, "notes", "extra.md"), "x\n");
    expect(read(join(repo.dir, "notes", "extra.md"))).toMatch(/isn't in the release commit/);
    writeFileSync(join(repo.cards, "02-new.ts"), "export default {};\n");
    expect(read(repo.cards)).toMatch(/differs from the release commit/);
    writeFileSync(join(repo.dir, "notes", "1.0.0.md"), "changed\n");
    expect(read(join(repo.dir, "notes", "1.0.0.md"))).toMatch(/differs/);
  });

  // A replacement ref once made `git show` return an uncommitted edit.
  it("won't publish notes swapped in through a replacement ref or grafts", async () => {
    const repo = notesRepo();
    const leak = "From codex/fix-customer-setting by @release-user.\n";
    writeFileSync(join(repo.dir, "notes", "1.0.0.md"), leak);
    const original = repo.git("rev-parse", `${repo.commit}:notes/1.0.0.md`).stdout.trim();
    const swapped = repo.git("hash-object", "-w", "notes/1.0.0.md").stdout.trim();
    expect(repo.git("replace", original, swapped).status).toBe(0);
    // What plain git now shows as committed is the edit, and the working tree matches it.
    expect(repo.git("show", `${repo.commit}:notes/1.0.0.md`).stdout).toBe(leak);
    const notesFile = join(repo.dir, "notes/1.0.0.md");
    await expect(readPublicNotes(notesOptions(repo, { notesFile }))).rejects.toThrow(
      /replacement refs \(refs\/replace\//,
    );
    // A replacement under another namespace, which the refs/replace/ scan can't see: git in this
    // process honors it, yet the tool, reading with replacements off and no GIT_* inherited,
    // still gets the committed blob, which the edited working tree doesn't match.
    repo.git("replace", "-d", original);
    repo.git("update-ref", "refs/swap/" + original, swapped);
    const before = process.env.GIT_REPLACE_REF_BASE;
    process.env.GIT_REPLACE_REF_BASE = "refs/swap/";
    try {
      expect(repo.git("show", `${repo.commit}:notes/1.0.0.md`).stdout).toBe(leak);
      expect(committedSource(repo.dir, repo.commit, notesFile).problem).toMatch(
        /notes\/1\.0\.0\.md differs from the release commit/,
      );
    } finally {
      if (before === undefined) delete process.env.GIT_REPLACE_REF_BASE;
      else process.env.GIT_REPLACE_REF_BASE = before;
    }
    // Grafts rewrite history the same way.
    writeFileSync(join(repo.dir, "notes", "1.0.0.md"), "Gram 1.0.0.\n");
    writeFileSync(join(repo.dir, ".git", "info", "grafts"), `${repo.commit}\n`);
    expect(committedSource(repo.dir, repo.commit, notesFile).problem).toMatch(/grafts/);
  });

  // Index flags hide these edits from `git status`.
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    it(`won't publish notes or cards edited behind ${flag}`, async () => {
      const repo = notesRepo();
      repo.git("update-index", flag, "notes/1.0.0.md", "apps/web/src/whats-new/1.0.0/01-card.ts");
      const leak = "From codex/fix-customer-setting by @release-user.\n";
      writeFileSync(join(repo.dir, "notes", "1.0.0.md"), leak);
      writeFileSync(
        join(repo.cards, "01-card.ts"),
        `export default { title: "Leak", body: ${JSON.stringify(leak)} };\n`,
      );
      expect(repo.git("status", "--porcelain").stdout).toBe("");
      await expect(
        readPublicNotes(notesOptions(repo, { notesFile: join(repo.dir, "notes/1.0.0.md") })),
      ).rejects.toThrow(/notes\/1\.0\.0\.md differs from the release commit/);
      await expect(readPublicNotes(notesOptions(repo))).rejects.toThrow(
        /whats-new\/1\.0\.0 differs from the release commit/,
      );
    });
  }
});

// The command line itself, as `bun run release:stable` starts it: the phases above call runPhase
// directly and never load its argument handling. No host GitHub state reaches it.
const cli = (...args) =>
  spawnSync(process.execPath, [join(HERE, "stable.mjs"), ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });

describe("the release:stable command line", () => {
  it("prints its usage", () => {
    const r = cli("--help");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("bun run release:stable validate");
  });

  it("stops on a work dir with no draft, naming what is missing", () => {
    const empty = mkdtempSync(join(tmpdir(), "gram-stable-cli-"));
    const r = cli("validate", "--work", empty);
    rmSync(empty, { recursive: true });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("release:stable stopped: ");
    expect(r.stderr).toContain("release.json is missing");
    expect(r.stderr).not.toContain("Error:");
  });
});
