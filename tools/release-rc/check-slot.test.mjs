import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";

import { acquireSlot, holders, slotDir } from "../check/slots.mjs";
import { withReleaseCheckSlot } from "./check-slot.mjs";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A source checkout and stub `git`, `gh`, `bun`, `security` and `xcrun` for running rc.mjs up to
 * its first check: the repository `gh repo view` describes, its latest release, its releases and
 * its tags. `start(args)` runs rc.mjs with `args` and returns the child and its output.
 */
function releaseFixture({
  repo = { nameWithOwner: "ANT1OFF/gram", isPrivate: true, defaultBranchRef: { name: "main" } },
  latest = "v0.3.0",
  releases = ["v0.3.0"],
  tags = ["v0.3.0"],
} = {}) {
  const root = realpathSync(mkdtempSync("/tmp/grs-"));
  dirs.push(root);
  const env = {
    XDG_CACHE_HOME: join(root, "cache"),
    GRAM_CHECK_SLOTS: "1",
    CI: "1",
    PATH: `${root}/bin:/usr/bin:/bin`,
    HOME: join(root, "home"),
  };
  const dir = slotDir(env);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const source = join(root, "source");
  mkdirSync(join(source, "packages/shell/src/modules/update"), { recursive: true });
  mkdirSync(join(source, "apps/desktop"), { recursive: true });
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({
      version: "0.4.0",
      packageManager: "bun@1.4.3",
      workspaces: { catalog: {} },
    }),
  );
  writeFileSync(join(source, ".bun-version"), "1.4.3");
  writeFileSync(join(source, ".node-version"), process.versions.node);
  writeFileSync(join(source, ".release-please-manifest.json"), '{".":"0.4.0"}');
  writeFileSync(join(source, "apps/desktop/package.json"), '{"version":"0.4.0"}');
  writeFileSync(
    join(source, "bun.lock"),
    '"apps/desktop": {"name": "@gram/desktop", "version": "0.4.0"}',
  );
  writeFileSync(
    join(source, "packages/shell/src/modules/update/mac-signature.ts"),
    'export const GRAM_MAC_TEAM_ID="FAKETEAM01", SIGNED_MAC_BUILD_SCHEMA=1, SIGNED_MAC_BUNDLE_ID="fake", macRequirementSha256=()=>"", verifyMacCodeSignature=()=>{};',
  );
  const executable = (name, body) =>
    writeFileSync(join(bin, name), `#!${process.execPath}\n${body}`, { mode: 0o755 });
  executable(
    "git",
    `const a=process.argv.slice(2).join(" ");
if(a==="rev-parse --show-toplevel") console.log(${JSON.stringify(source)});
else if(a.startsWith("rev-parse ")) console.log("a".repeat(40));
else if(a==="remote get-url origin") console.log("https://github.com/ANT1OFF/gram.git");
else if(a==="tag --list v*") console.log(${JSON.stringify(tags.join("\n"))});
else if(!["status --porcelain --untracked-files=normal","fetch --quiet --tags origin main","ls-remote --tags --refs origin v*"].includes(a)) process.exit(99);`,
  );
  executable(
    "gh",
    `const a=process.argv.slice(2).join(" ");
if(a.startsWith("repo view ")) console.log(JSON.stringify(${JSON.stringify(repo)}));
else if(a.includes("releases/latest")) { if (${JSON.stringify(latest)}) console.log(${JSON.stringify(latest)}); else { console.error("HTTP 404"); process.exit(1); } }
else if(a.includes("releases?")) console.log(${JSON.stringify(releases.join("\n"))});
else if(a!=="auth status --hostname github.com") process.exit(99);`,
  );
  const marker = join(root, "entered.json");
  executable(
    "bun",
    `import {readFileSync,writeFileSync} from "node:fs";
const a=process.argv.slice(2).join(" ");
if(a==="--version") console.log("1.4.3");
else if(a==="pm cache") console.log(${JSON.stringify(join(root, "bun-cache"))});
else if(a==="install --frozen-lockfile") {
writeFileSync(${JSON.stringify(marker)}, readFileSync(${JSON.stringify(join(dir, "slot-0/owner.json"))}));
process.exit(42);
} else process.exit(99);`,
  );
  executable(
    "security",
    `console.log('  1) ${"A".repeat(40)} "Developer ID Application: Example (FAKETEAM01)"');`,
  );
  executable("xcrun", 'console.log("{}");');
  // Intercept only the two absolute macOS commands, before rc.mjs imports their ESM bindings.
  // Even on macOS this fixture cannot touch the actual keychain or xcrun.
  const bootstrap = join(root, "bootstrap.mjs");
  writeFileSync(
    bootstrap,
    `import cp from "node:child_process";
import {syncBuiltinESMExports} from "node:module";
const original=cp.spawnSync;
cp.spawnSync=(cmd,args,opts)=>original(cmd==="/usr/bin/security" ? ${JSON.stringify(join(bin, "security"))} : cmd==="/usr/bin/xcrun" ? ${JSON.stringify(join(bin, "xcrun"))} : cmd,args,opts);
syncBuiltinESMExports();
Object.defineProperty(process,"platform",{value:"darwin"});
Object.defineProperty(process,"arch",{value:"arm64"});
await import(${JSON.stringify(new URL("./rc.mjs", import.meta.url).href)});`,
  );
  const start = (args) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        bootstrap,
        fileURLToPath(new URL("./rc.mjs", import.meta.url)),
        ...args,
        "--no-publish",
        "--source",
        source,
        "--work",
        join(root, "work"),
        "--bun",
        join(bin, "bun"),
      ],
      { env },
    );
    const result = { child, output: "" };
    child.stdout.on("data", (s) => (result.output += s));
    child.stderr.on("data", (s) => (result.output += s));
    result.exited = new Promise((resolve) => child.once("exit", resolve));
    return result;
  };
  return { root, env, dir, source, marker, start };
}

/** rc.mjs run to its exit: its code and everything it printed. */
const runRelease = async (fixture, args) => {
  const run = fixture.start(args);
  return { code: await run.exited, output: run.output };
};

it.each([false, true])(
  "release entrypoint (stable=%s) waits despite isolated CI stores, then frees on failure",
  async (stable) => {
    const fixture = releaseFixture();
    const { dir, source, marker } = fixture;
    const free = await acquireSlot({ dir, slots: 1, label: "other-worktree" });
    // Both paths stop at our invented install failure.
    const run = fixture.start(stable ? ["--stable", "0.4.0"] : ["0.4.1-rc.1", "--unsigned"]);
    let waited;
    const waiting = new Promise((resolve, reject) => {
      waited = resolve;
      run.child.once("error", reject);
      run.child.once("exit", () =>
        reject(new Error(`release exited before waiting:\n${run.output}`)),
      );
    });
    run.child.stdout.on("data", () => {
      if (run.output.includes("held by:")) waited();
    });
    try {
      await waiting;
      expect(run.output).toContain("other-worktree");
      expect(existsSync(marker)).toBe(false);
    } finally {
      free();
    }
    expect(await run.exited).toBe(1);
    expect(run.output).toContain("install failed");
    expect(JSON.parse(readFileSync(marker, "utf8")).cwd).toBe(source);
    expect(holders(dir)).toEqual([]);
  },
  10_000,
);

const PUBLIC = {
  nameWithOwner: "ANT1OFF/gram",
  isPrivate: false,
  defaultBranchRef: { name: "main" },
};

it("cuts a private RC only from a private repository", async () => {
  const { code, output } = await runRelease(releaseFixture({ repo: PUBLIC }), [
    "0.4.1-rc.1",
    "--unsigned",
  ]);
  expect(code).toBe(1);
  expect(output).toMatch(/ANT1OFF\/gram is not private; this script only cuts private RCs/);
}, 10_000);

it("refuses a repository that answers under another name", async () => {
  const fixture = releaseFixture({ repo: { ...PUBLIC, nameWithOwner: "ANT1OFF/gram-dev" } });
  const { code, output } = await runRelease(fixture, ["--stable", "0.4.0"]);
  expect(code).toBe(1);
  expect(output).toMatch(/ANT1OFF\/gram answers as ANT1OFF\/gram-dev/);
}, 10_000);

it("takes a first release only into a repository with no release or tag", async () => {
  const empty = { repo: PUBLIC, latest: "", releases: [], tags: [] };
  // Without the flag, an empty repository says how to cut its first release.
  let run = await runRelease(releaseFixture(empty), ["--stable", "0.4.0"]);
  expect(run.code).toBe(1);
  expect(run.output).toMatch(/first release takes --first-release/);
  // With it, the run gets past the repository checks to the install.
  run = await runRelease(releaseFixture(empty), ["--stable", "0.4.0", "--first-release"]);
  expect(run.output).toContain("install failed");
  // Any release or tag already there refuses it.
  for (const held of [{ releases: ["v0.3.0"] }, { tags: ["v0.3.0"] }]) {
    run = await runRelease(releaseFixture({ ...empty, ...held }), [
      "--stable",
      "0.4.0",
      "--first-release",
    ]);
    expect(run.code).toBe(1);
    expect(run.output).toMatch(/--first-release is for a repository with no releases or tags/);
  }
}, 20_000);

it("returns the slot on a failed release check", async () => {
  const root = mkdtempSync(join(tmpdir(), "gram-release-slot-"));
  dirs.push(root);
  const env = { GRAM_CHECK_SLOT_DIR: root, GRAM_CHECK_SLOTS: "1" };
  await expect(
    withReleaseCheckSlot(
      () => {
        throw new Error("check failed");
      },
      { source: "release", env, say: () => {} },
    ),
  ).rejects.toThrow("check failed");
  expect(holders(root)).toEqual([]);
});
