#!/usr/bin/env node
// Cuts a private macOS arm64 RC from a clean checkout of origin/main in one go: one full check,
// one build and package, smoke, the six updater assets (and, signed, electron-updater's
// rc-mac.yml), notes from merged PR titles, publish and a short record in the work dir.
//
//   bun run release:rc [version] [--draft | --no-publish | --dry-run] [--highlights <file>]
//                      [--signed | --unsigned] [--identity <name>]
//                      [--notary-profile <name>] [--source <checkout>] [--work <empty dir>]
//                      [--bun <pinned bun>]
//   bun run release:rc --stable <version> [--dry-run] [--work <empty dir>] …
//
// `--stable` is the stable path's first phase: the same check, build, signing (required),
// smoke and assets, with latest-mac.yml, then a private draft that is neither prerelease nor
// latest, and `release.json` in the work dir. `bun run release:stable` takes it from there
// (docs/RELEASING.md).
//
// The version is stamped into the package only (electron-builder extraMetadata); nothing is
// committed to main. Check, build and smoke run with a temporary HOME, stores and stub provider
// CLIs; only signing (your keychain, by name) and the publish step use your own setup.
// It signs, notarizes and staples when the source names its team (GRAM_MAC_TEAM_ID) and your
// keychain has that team's Developer ID identity and notarytool profile (gram-notary); see
// docs/UPDATES.md#developer-id-signing. Otherwise, or with --unsigned, it builds unsigned.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  chownSync,
  closeSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_NOTARY_PROFILE,
  REPO,
  assetNames,
  checksumLines,
  defaultWorkPrefix,
  describeTests,
  minutes,
  nextRcVersion,
  parseArgs,
  renderNotes,
  renderRecord,
  rerunFiles,
  resolveSigning,
  summarizeVitest,
  tagVersions,
  uploadNames,
  validateStableTarget,
  validateTarget,
  versionFields,
  workPathProblem,
} from "./rc-lib.mjs";
import { writeUpdaterManifest } from "./updater-manifest.mjs";
import { withReleaseCheckSlot } from "./check-slot.mjs";
import { preflightNotary } from "./notary-preflight.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const started = Date.now();
const steps = [];
const say = (line) => process.stdout.write(`${line}\n`);
const fail = (message) => {
  process.stderr.write(`\nrelease:rc stopped: ${message}\n`);
  process.exit(1);
};
const seconds = (since) => (Date.now() - since) / 1000;
/** Your own environment: git, gh. Throws with stderr on a nonzero exit. */
const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 ** 2,
    ...options,
  }).trim();
const tryRun = (cmd, args, options = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 ** 2, ...options });
  return { status: r.status, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
};

const sha256File = (path) =>
  new Promise((done, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => done(hash.digest("hex")))
      .on("error", reject);
  });

const options = (() => {
  try {
    return parseArgs(process.argv.slice(2));
  } catch (error) {
    return fail(error.message);
  }
})();
if (options.help) {
  say(
    readFileSync(fileURLToPath(import.meta.url), "utf8")
      .split("\n")
      .slice(1, 22)
      .join("\n"),
  );
  process.exit(0);
}
const publishing = options.publish && !options.draft;
const stable = options.stable;

// ---------------------------------------------------------------------------------------------
// Preconditions
say("▸ Preconditions");
if (process.platform !== "darwin" || process.arch !== "arm64")
  fail(
    `needs macOS on Apple silicon with an arm64 Node (have ${process.platform}-${process.arch}).`,
  );

const source = (() => {
  const from = resolve(options.source ?? process.cwd());
  const top = tryRun("git", ["rev-parse", "--show-toplevel"], { cwd: from });
  if (top.status !== 0) fail(`${from} is not a Git checkout.`);
  return realpathSync(top.stdout);
})();
const git = (...args) => run("git", args, { cwd: source });
const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
const want = {
  bun: readFileSync(join(source, ".bun-version"), "utf8").trim(),
  node: readFileSync(join(source, ".node-version"), "utf8").trim(),
};
if (pkg.packageManager !== `bun@${want.bun}`)
  fail(`.bun-version ${want.bun} disagrees with packageManager ${pkg.packageManager}.`);
if (process.versions.node !== want.node)
  fail(`Node ${process.versions.node} is running; this repository pins ${want.node}.`);
const bunPath = options.bun ? resolve(options.bun) : tryRun("/usr/bin/which", ["bun"]).stdout;
if (!bunPath) fail("bun is not on PATH; pass --bun <path>.");
const bunVersion = run(bunPath, ["--version"]);
if (bunVersion !== want.bun)
  fail(`bun ${bunVersion} at ${bunPath}; this repository pins ${want.bun} (pass --bun <path>).`);

if (git("status", "--porcelain", "--untracked-files=normal"))
  fail(`${source} has uncommitted or untracked changes; use a clean checkout of main.`);
if (!/[/:]ANT1OFF\/gram(?:\.git)?$/.test(git("remote", "get-url", "origin")))
  fail(`origin of ${source} is not ${REPO}.`);
const auth = tryRun("gh", ["auth", "status", "--hostname", "github.com"]);
if (auth.status !== 0) fail("gh is not signed in to github.com (run gh auth login).");
const repo = JSON.parse(
  run("gh", ["repo", "view", REPO, "--json", "nameWithOwner,isPrivate,defaultBranchRef"]),
);
// A renamed or transferred repository still answers under its old name, through a redirect.
if (repo.nameWithOwner !== REPO) fail(`${REPO} answers as ${repo.nameWithOwner}; check origin.`);
// An RC publishes straight through, so it stays private; a stable draft is checked before it is
// published, by release:stable, and may come from the public repository.
if (!stable && repo.isPrivate !== true)
  fail(`${REPO} is not private; this script only cuts private RCs (pass --stable).`);
if (repo.defaultBranchRef?.name !== "main") fail(`${REPO}'s default branch is not main.`);
git("fetch", "--quiet", "--tags", "origin", "main");
const sha = git("rev-parse", "HEAD");
if (sha !== git("rev-parse", "origin/main"))
  fail(
    `HEAD ${sha.slice(0, 8)} is not origin/main ${git("rev-parse", "origin/main").slice(0, 8)}.`,
  );

const releaseTags = run("gh", [
  "api",
  "--paginate",
  `repos/${REPO}/releases?per_page=100`,
  "--jq",
  ".[].tag_name",
])
  .split("\n")
  .filter(Boolean);
const tags = [
  ...new Set([
    ...git("tag", "--list", "v*").split("\n").filter(Boolean),
    ...git("ls-remote", "--tags", "--refs", "origin", "v*")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("refs/tags/")[1]),
    ...releaseTags,
  ]),
];
let version;
try {
  version = options.version ?? nextRcVersion(tags, pkg.version);
  if (stable)
    validateStableTarget({
      version,
      tags,
      fields: versionFields({
        manifest: readFileSync(join(source, ".release-please-manifest.json"), "utf8"),
        rootPackage: readFileSync(join(source, "package.json"), "utf8"),
        desktopPackage: readFileSync(join(source, "apps/desktop/package.json"), "utf8"),
        lock: readFileSync(join(source, "bun.lock"), "utf8"),
      }),
    });
  else validateTarget({ version, publish: publishing, tags, mainVersion: pkg.version });
} catch (error) {
  fail(error.message);
}
if (releaseTags.includes(`v${version}`)) fail(`A release (or draft) for v${version} exists.`);
const tag = `v${version}`;
// What installs run now: the stable path's update check runs as this version. A first release
// (`--first-release`) has none, and goes only into a repository with no release and no tag.
const previousStable = (() => {
  if (!stable) return undefined;
  if (options.firstRelease) {
    if (releaseTags.length || tags.length)
      fail(
        `--first-release is for a repository with no releases or tags; ${REPO} has ${[...releaseTags, ...tags].slice(0, 5).join(", ")}.`,
      );
    return null;
  }
  const latest = tryRun("gh", ["api", `repos/${REPO}/releases/latest`, "--jq", ".tag_name"]);
  if (latest.status !== 0 || !latest.stdout.startsWith("v"))
    fail(
      `${REPO} has no latest release to update from: ${latest.stderr || latest.stdout}${
        releaseTags.length || tags.length
          ? ""
          : " (a repository's first release takes --first-release)"
      }`,
    );
  return latest.stdout.slice(1);
})();
const highlights = options.highlights ? readFileSync(resolve(options.highlights), "utf8") : "";
const catalog = pkg.workspaces.catalog;

// Signing, decided before the long check: names only. The identity by its keychain name,
// notarization by a notarytool profile; neither secret is read here or by the signer.
const update = (file) =>
  pathToFileURL(join(source, "packages/shell/src/modules/update", file)).href;
const {
  GRAM_MAC_TEAM_ID,
  SIGNED_MAC_BUILD_SCHEMA,
  SIGNED_MAC_BUNDLE_ID,
  macRequirementSha256,
  verifyMacCodeSignature,
} = await import(update("mac-signature.ts"));
const signingEnv = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  HOME: userInfo().homedir,
  LANG: "en_US.UTF-8",
};
const signing = (() => {
  const profile = options.notaryProfile ?? DEFAULT_NOTARY_PROFILE;
  try {
    return resolveSigning({
      mode: options.signing,
      teamId: GRAM_MAC_TEAM_ID,
      identityLines:
        options.signing === "unsigned" || !GRAM_MAC_TEAM_ID
          ? []
          : tryRun("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"], {
              env: signingEnv,
            }).stdout.split("\n"),
      identity: options.identity,
      profile,
      checkProfile: () => preflightNotary({ profile, env: signingEnv, say }),
    });
  } catch (error) {
    return fail(error.message);
  }
})();
if (publishing && !signing.signed && options.signing === "auto" && GRAM_MAC_TEAM_ID)
  fail(
    `the source names publisher team ${GRAM_MAC_TEAM_ID} but this run would be unsigned (${signing.reason}). ` +
      "Fix the setup, or pass --unsigned to publish an unsigned RC deliberately.",
  );

const work = options.work ? resolve(options.work) : mkdtempSync(defaultWorkPrefix(version));
if (existsSync(work) && readdirSync(work).length) fail(`work dir ${work} is not empty.`);
mkdirSync(work, { recursive: true });
const workProblem = workPathProblem(realpathSync(work));
if (workProblem) fail(workProblem);
// New files take their directory's group on macOS. Under /tmp that is wheel, where chmod
// silently drops setgid, and the updater's exact-mode tests then see the wrong mode.
chownSync(work, process.getuid(), process.getgid());
for (const dir of ["logs", "probes", "assets", "home", "tmp", "bin", "fixtures", "zdot"])
  mkdirSync(join(work, dir), { recursive: true });
say(
  `  ${tag}${stable ? " (stable)" : ""} from ${sha.slice(0, 8)} · ${publishing ? "publish" : options.draft ? "draft" : "no publish"} · work ${work}`,
);
say(
  signing.signed
    ? `  signing: Developer ID team ${signing.teamId}, notarytool profile ${signing.profile}`
    : `  signing: none, unsigned build (${signing.reason})`,
);

// ---------------------------------------------------------------------------------------------
// The isolated environment for check, build and smoke: no account, provider or GitHub state.
for (const cli of ["claude", "codex", "gh", "security"]) {
  writeFileSync(join(work, "fixtures", cli), "#!/bin/sh\nexit 127\n", { mode: 0o755 });
}
for (const [name, target] of [
  ["bun", realpathSync(bunPath)],
  ["bunx", realpathSync(bunPath)],
  ["node", process.execPath],
]) {
  run("/bin/ln", ["-sf", target, join(work, "bin", name)]);
}
const realHome = userInfo().homedir;
const stores = (name) => {
  const dir = join(work, name);
  const at = (sub) => {
    mkdirSync(join(dir, sub), { recursive: true });
    return join(dir, sub);
  };
  return {
    XDG_CONFIG_HOME: at("xdg-config"),
    XDG_DATA_HOME: at("xdg-data"),
    XDG_CACHE_HOME: at("xdg-cache"),
    CODEX_HOME: at("codex"),
    CLAUDE_CONFIG_DIR: at("claude"),
    GH_CONFIG_DIR: at("gh"),
    GRAM_DATA_DIR: at("gram"),
    ELECTRON_USER_DATA_DIR: at("electron"),
  };
};
const isolated = {
  PATH: `${join(work, "fixtures")}:${join(work, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
  HOME: join(work, "home"),
  TMPDIR: `${join(work, "tmp")}/`,
  // Download caches only, so a release doesn't refetch packages and Electron.
  BUN_INSTALL_CACHE_DIR: run(bunPath, ["pm", "cache"]) || join(realHome, ".bun/install/cache"),
  ELECTRON_CACHE: join(realHome, "Library/Caches/electron"),
  ELECTRON_BUILDER_CACHE: join(realHome, "Library/Caches/electron-builder"),
  CI: "1",
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  LANG: "en_US.UTF-8",
  CSC_IDENTITY_AUTO_DISCOVERY: "false",
  ...stores("stores"),
};
const smokeStores = stores("smoke-stores");
const smokeEnv = {
  ...isolated,
  ...smokeStores,
  ZDOTDIR: join(work, "zdot"),
  GRAM_FAKE_AGENT: "1",
  GRAM_FAKE_AGENT_REPLY: "echo",
};

const portable = (text) =>
  String(text).split(work).join("<work>").split(source).join("<source>").split(realHome).join("~");

/** One logged step in the isolated environment; stops the release on a nonzero exit. */
function step(
  name,
  cmd,
  args,
  { cwd = source, env = isolated, allowFail = false, timeoutMs } = {},
) {
  const log = join(work, "logs", `${name}.log`);
  const fd = openSync(log, "w");
  const begin = Date.now();
  process.stdout.write(`  ${name} … `);
  const r = spawnSync(cmd, args, { cwd, env, stdio: ["ignore", fd, fd], timeout: timeoutMs });
  closeSync(fd);
  const record = {
    name,
    command: portable([cmd, ...args].join(" ")),
    exit: r.status ?? (r.signal ? `signal ${r.signal}` : "error"),
    seconds: Math.round(seconds(begin) * 10) / 10,
  };
  steps.push(record);
  say(`${r.status === 0 ? "ok" : "FAILED"} (${minutes(record.seconds)})`);
  const output = readFileSync(log, "utf8");
  if (r.status !== 0 && !allowFail) {
    process.stderr.write(output.split("\n").slice(-40).join("\n"));
    fail(`${name} failed; full log: ${log}`);
  }
  return { ok: r.status === 0, output, record };
}

// ---------------------------------------------------------------------------------------------
// Check: install, scaffold, docs, release metadata, static, then the tests once.
say("▸ Check");
const { check, checkText } = await withReleaseCheckSlot(
  () => {
    step("install", "bun", ["install", "--frozen-lockfile"]);
    step("scaffold", "bun", ["run", "check:scaffold"]);
    step("docs", "bun", ["run", "check:docs"]);
    step("release-metadata", "node", ["tools/check-release-please.mjs"]);
    step("static", "bun", ["run", "check:static"]);
    const testRun = (name, files) => {
      const report = join(work, "probes", `${name}.json`);
      const r = step(
        name,
        "bun",
        [
          "run",
          "test",
          "--reporter=default",
          "--reporter=json",
          `--outputFile.json=${report}`,
          ...files,
        ],
        { allowFail: true },
      );
      if (!existsSync(report)) {
        process.stderr.write(r.output.split("\n").slice(-40).join("\n"));
        fail(`${name} wrote no report; log: ${join(work, "logs", `${name}.log`)}`);
      }
      return summarizeVitest(JSON.parse(readFileSync(report, "utf8")), source);
    };
    const tests = testRun("tests", []);
    const result = { tests, rerun: undefined };
    if (!tests.success) {
      const files = rerunFiles(tests);
      if (!files)
        fail(
          `tests failed (${describeTests(tests)}): ${tests.failedFiles.join(", ") || "no file attributed"}. ` +
            `Only up to three files that all timed out are rerun. Log: ${join(work, "logs/tests.log")}`,
        );
      say(`  timeouts in ${files.join(", ")}; rerunning only those once`);
      result.rerun = { files, ...testRun("tests-rerun", files) };
      if (!result.rerun.success)
        fail(`the rerun failed too (${describeTests(result.rerun)}); see ${join(work, "logs")}.`);
    }
    const text =
      `${describeTests(tests)}` +
      (result.rerun
        ? `; ${result.rerun.files.length} timed-out file(s) passed on one rerun (${describeTests(result.rerun)})`
        : "");
    return { check: result, checkText: text };
  },
  { source, say },
);

// ---------------------------------------------------------------------------------------------
// Build and package once, with the version stamped into the package only.
say("▸ Build and package");
const output = join(work, "output");
const desktop = join(source, "apps/desktop");
step("build", "bun", ["run", "build"]);
step(
  "package",
  "bun",
  [
    "run",
    "electron-builder",
    "--mac",
    "dir",
    "--arm64",
    "--publish",
    "never",
    `-c.directories.output=${output}`,
    `-c.extraMetadata.version=${version}`,
  ],
  { cwd: desktop },
);
step(
  "verify-package",
  "bun",
  ["run", "verify:package", "--release", output, "--platform", "darwin", "--arch", "arm64"],
  { cwd: desktop },
);
if (git("status", "--porcelain", "--untracked-files=normal") || git("rev-parse", "HEAD") !== sha)
  fail("the source checkout changed during the build.");
const app = join(output, "mac-arm64/Gram.app");
if (!existsSync(app)) fail(`no app at ${app}.`);

// Sign, notarize and staple before inspection, so the probe, smoke and assets cover signed bytes.
// This one step runs with your keychain; the signer verifies with codesign, stapler and spctl.
let signed;
if (signing.signed) {
  const signStep = step(
    "sign",
    process.execPath,
    [
      join(desktop, "scripts/sign-mac.mjs"),
      "--app",
      app,
      "--identity",
      signing.identity,
      "--notary-profile",
      signing.profile,
    ],
    {
      cwd: desktop,
      env: { ...signingEnv, TMPDIR: `${join(work, "tmp")}/` },
      timeoutMs: 90 * 60_000,
    },
  );
  try {
    signed = JSON.parse(signStep.output.trim().split("\n").at(-1));
  } catch {
    fail(`the signer printed no summary; log: ${join(work, "logs/sign.log")}`);
  }
  if (
    signed.signing !== "developer-id" ||
    signed.teamId !== signing.teamId ||
    signed.identifier !== SIGNED_MAC_BUNDLE_ID ||
    signed.hardenedRuntime !== true ||
    signed.stapled !== true ||
    signed.notarization?.status !== "Accepted" ||
    signed.requirementSha256 !== macRequirementSha256(signing.teamId)
  )
    fail(`unexpected signing summary: ${JSON.stringify(signed)}`);
  say(`  notarized: submission ${signed.notarization.submissionId}, stapled, Gatekeeper accepted`);
}

// ---------------------------------------------------------------------------------------------
// Inspect the package, then the native probe and the packaged smoke with fake agents.
say("▸ Inspect and smoke");
const files = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : [],
  );
const inspection = (() => {
  const begin = Date.now();
  const asar = createRequire(join(source, "package.json"))("@electron/asar");
  const archive = join(app, "Contents/Resources/app.asar");
  const out = join(desktop, "out");
  const outputs = files(out).map((file) => {
    const rel = relative(dirname(out), file).split(sep).join("/");
    if (!readFileSync(file).equals(asar.extractFile(archive, rel)))
      fail(`app.asar's ${rel} differs from the build.`);
    return rel;
  });
  const packaged = JSON.parse(asar.extractFile(archive, "package.json"));
  if (
    packaged.version !== version ||
    packaged.name !== "@gram/desktop" ||
    packaged.productName !== "Gram"
  )
    fail(
      `packaged package.json is ${packaged.name}@${packaged.version}, not @gram/desktop@${version}.`,
    );
  if (!asar.extractFile(archive, "out/main/index.js").toString().includes(sha))
    fail("the packaged main lacks the build source revision (was the checkout clean?).");
  const web = join(source, "apps/web/dist"),
    packedWeb = join(app, "Contents/Resources/web");
  const list = files(web)
    .map((p) => relative(web, p))
    .toSorted();
  const packedList = files(packedWeb)
    .map((p) => relative(packedWeb, p))
    .toSorted();
  if (JSON.stringify(list) !== JSON.stringify(packedList))
    fail("packaged web files differ from the build.");
  for (const p of list)
    if (!readFileSync(join(web, p)).equals(readFileSync(join(packedWeb, p))))
      fail(`packaged web file ${p} differs.`);
  const plist = {};
  for (const key of [
    "CFBundleIdentifier",
    "CFBundleExecutable",
    "CFBundleShortVersionString",
    "CFBundleVersion",
    "LSMinimumSystemVersion",
  ])
    plist[key] = run("/usr/bin/plutil", [
      "-extract",
      key,
      "raw",
      "-o",
      "-",
      join(app, "Contents/Info.plist"),
    ]);
  if (
    plist.CFBundleIdentifier !== "io.github.ant1off.gram" ||
    plist.CFBundleExecutable !== "Gram" ||
    plist.CFBundleShortVersionString !== version ||
    plist.CFBundleVersion !== version
  )
    fail(`unexpected Info.plist identity/version: ${JSON.stringify(plist)}.`);
  const native = [];
  for (const file of files(app)) {
    const fd = openSync(file, "r"),
      head = Buffer.alloc(4);
    readSync(fd, head, 0, 4, 0);
    closeSync(fd);
    if (
      !["cffaedfe", "cefaedfe", "feedfacf", "feedface", "cafebabe", "bebafeca"].includes(
        head.toString("hex"),
      )
    )
      continue;
    const description = run("/usr/bin/file", ["-b", file]);
    if (!description.includes("arm64") || description.includes("x86_64"))
      fail(`${relative(app, file)} is not thin arm64: ${description}`);
    native.push(relative(app, file));
  }
  const signature = tryRun("/usr/bin/codesign", ["--display", "--verbose=4", app]);
  const signatureText = `${signature.stdout}\n${signature.stderr}`;
  const signatureSummary = ["Signature", "TeamIdentifier", "Format", "Sealed Resources"]
    .map((key) => new RegExp(`^${key}[=\\s].*$`, "m").exec(signatureText)?.[0])
    .filter(Boolean)
    .join("; ");
  const developerId = /^Authority=Developer ID Application: /m.test(signatureText);
  if (signing.signed) {
    if (!developerId || !signatureText.includes(`\nTeamIdentifier=${signing.teamId}\n`))
      fail(`the package lacks team ${signing.teamId}'s Developer ID signature.`);
  } else if (developerId) fail("the package is Developer ID signed, but this run is unsigned.");
  steps.push({
    name: "inspect",
    command: "package inspection",
    exit: 0,
    seconds: Math.round(seconds(begin) * 10) / 10,
  });
  say(
    `  inspect … ok (${outputs.length} ASAR outputs, ${list.length} web files, ${native.length} arm64 binaries)`,
  );
  return {
    asarOutputs: outputs.length,
    webFiles: list.length,
    arm64Binaries: native.length,
    signature: signatureSummary,
    minimumMacOS: plist.LSMinimumSystemVersion,
  };
})();

const marker = `GRAM_RC_NATIVE_${randomBytes(4).toString("hex")}`;
const probe = step(
  "native-probe",
  join(app, "Contents/MacOS/Gram"),
  [
    join(HERE, "native-probe.cjs"),
    join(app, "Contents/Resources/app.asar"),
    join(work, "probes"),
    marker,
  ],
  { env: { ...isolated, ELECTRON_RUN_AS_NODE: "1" }, timeoutMs: 60_000 },
);
const runtime = JSON.parse(probe.output.split("\n").find((line) => line.startsWith("{")) ?? "{}");
if (
  !probe.output.includes("NATIVE OK") ||
  runtime.electron !== catalog.electron ||
  runtime.arch !== "arm64"
)
  fail(
    `native probe: expected Electron ${catalog.electron} arm64, got ${JSON.stringify(runtime)}.`,
  );
const smoke = step(
  "smoke",
  join(app, "Contents/MacOS/Gram"),
  ["--smoke", "--password-store=basic", `--user-data-dir=${smokeStores.ELECTRON_USER_DATA_DIR}`],
  { env: smokeEnv, timeoutMs: 120_000 },
);
if (!smoke.output.includes("SMOKE OK")) fail("the packaged smoke run did not print SMOKE OK.");

// ---------------------------------------------------------------------------------------------
// Assets: inventory, bundle and web manifests, BUILD-INFO, the ZIP, one extraction, SHA256SUMS,
// and for a signed build electron-updater's manifest.
say("▸ Assets");
const assets = join(work, "assets");
const names = assetNames(version, signing.signed);
const uploads = uploadNames(version, signing.signed);
const [zipName] = names;
const assetsBegin = Date.now();
const inventory = [],
  bundleSums = [],
  webSums = [];
const walk = async (dir) => {
  for (const name of readdirSync(dir).toSorted()) {
    const path = join(dir, name),
      s = lstatSync(path),
      rel = relative(app, path).split(sep).join("/");
    const row = { path: rel, mode: `0o${(s.mode & 0o777).toString(8).padStart(3, "0")}` };
    if (s.isSymbolicLink()) {
      row.type = "symlink";
      row.target = readlinkSync(path);
      if (!realpathSync(path).startsWith(`${realpathSync(app)}${sep}`))
        fail(`symlink ${rel} leaves the bundle.`);
    } else if (s.isDirectory()) row.type = "directory";
    else if (s.isFile()) {
      row.type = "file";
      row.bytes = s.size;
      const digest = await sha256File(path);
      bundleSums.push(`${digest}  ${rel}`);
      if (rel.startsWith("Contents/Resources/web/")) webSums.push(`${digest}  ${rel}`);
    } else fail(`unexpected bundle object ${rel}.`);
    inventory.push(row);
    if (row.type === "directory") await walk(path);
  }
};
await walk(app);
writeFileSync(join(assets, "BUNDLE-INVENTORY.json"), `${JSON.stringify(inventory, null, 2)}\n`);
writeFileSync(join(assets, "BUNDLE-SHA256SUMS.txt"), `${bundleSums.join("\n")}\n`);
writeFileSync(join(assets, "WEB-SHA256SUMS.txt"), `${webSums.join("\n")}\n`);

const username = userInfo().username;
const writeBuildInfo = async (zipVerification) => {
  const info = {
    version,
    tag,
    repository: REPO,
    repositoryPrivate: repo.isPrivate === true,
    platform: "darwin-arm64",
    sourceCommit: sha,
    sourceTree: git("rev-parse", "HEAD^{tree}"),
    sourceParent: git("rev-parse", "HEAD^"),
    process: stable
      ? "bun run release:rc --stable, then release:stable (stable path)"
      : "bun run release:rc (private RC fast path)",
    ...(stable ? { previousStable } : {}),
    versionStamp: "electron-builder extraMetadata.version; main's version fields unchanged",
    developerIdSigned: signing.signed,
    notarized: signing.signed,
    ...(signing.signed
      ? {
          // What the updater's signed method requires; see validateMacBuildMethod.
          schema: SIGNED_MAC_BUILD_SCHEMA,
          method: "signed-native-macos-v1",
          stapled: true,
          teamId: signing.teamId,
          bundleId: SIGNED_MAC_BUNDLE_ID,
          requirementSha256: macRequirementSha256(signing.teamId),
          notarizationStatus: "accepted",
          notarizationSubmissionId: signed.notarization.submissionId,
          hardenedRuntime: true,
          gatekeeper: "Notarized Developer ID",
        }
      : {}),
    signatureInspection: inspection.signature,
    tools: {
      bun: bunVersion,
      hostNode: process.versions.node,
      electron: runtime.electron,
      electronNode: runtime.node,
      electronBuilder: catalog["electron-builder"],
      arch: "arm64",
    },
    fullLocalCheck: {
      sourceCommit: sha,
      tests: {
        passed: check.tests.passed,
        failed: check.tests.failed,
        skipped: check.tests.skipped,
      },
      ...(check.rerun
        ? {
            rerun: {
              files: check.rerun.files,
              passed: check.rerun.passed,
              failed: check.rerun.failed,
              reason: "timeouts only",
            },
          }
        : {}),
      result: "pass",
    },
    package: {
      appAsarSha256: await sha256File(join(app, "Contents/Resources/app.asar")),
      asarOutputsExact: inspection.asarOutputs,
      webFilesExact: inspection.webFiles,
      thinArm64MachOBinaries: inspection.arm64Binaries,
      inventoryEntries: inventory.length,
    },
    appAsarSha256: await sha256File(join(app, "Contents/Resources/app.asar")),
    bundleChecksumManifestSha256: await sha256File(join(assets, "BUNDLE-SHA256SUMS.txt")),
    webChecksumManifestSha256: await sha256File(join(assets, "WEB-SHA256SUMS.txt")),
    bundleInventorySha256: await sha256File(join(assets, "BUNDLE-INVENTORY.json")),
    qualification: {
      packageVerifier: "pass",
      nativeProbe: "NATIVE OK: speech and PTY natives through the production app.asar",
      packagedSmoke: "SMOKE OK: fake agents, temporary stores, no paid turn",
      zipVerification,
    },
    publisherActivation: "none",
    updaterOptIns: { automaticChecks: false, unsignedPrivateInstall: false },
    steps: steps.map(({ name, exit, seconds: s }) => ({ name, exit, seconds: s })),
    startedAtUtc: new Date(started).toISOString(),
    createdAtUtc: new Date().toISOString(),
    limits: [
      signing.signed
        ? "Developer ID signed, hardened runtime, notarized and stapled; Gatekeeper accepted before zipping"
        : "unsigned: ad-hoc linker signatures, no Developer ID, not notarized",
      "no live-provider or microphone test",
      "no installed-update, restart or post-launch health test",
      stable
        ? "independent artifact review of the draft before publication (stable path)"
        : "no independent artifact review (private RC fast path)",
    ],
  };
  const text = `${JSON.stringify(info, null, 2)}\n`;
  if (
    /\/Users\/|\/private\/|\/var\/folders\//.test(text) ||
    (username.length > 2 && text.includes(username))
  )
    fail("BUILD-INFO.json would contain a local path or the account name.");
  writeFileSync(join(assets, "BUILD-INFO.json"), text);
};
await writeBuildInfo("pending");
step("zip", "/usr/bin/ditto", [
  "-c",
  "-k",
  "--sequesterRsrc",
  "--keepParent",
  app,
  join(assets, zipName),
]);

// One extraction with the updater's own bounded ZIP reader, then a full bundle comparison. A signed
// build must also still satisfy macOS: the same strict deep requirement and Gatekeeper verdict the
// updater asks for before it stages an update.
const { extractMacArchive } = await import(update("mac-archive.ts"));
const { verifyMacBundle, verifyMacBundleForMethod } = await import(update("mac-bundle.ts"));
const verifyExtracted = async (bundle) => {
  if (!signing.signed) return verifyMacBundle(bundle, assets, version, sha);
  await verifyMacBundleForMethod(bundle, assets, version, sha, {
    method: "signed-native-macos-v1",
    teamId: signing.teamId,
    requirementSha256: macRequirementSha256(signing.teamId),
  });
  await verifyMacCodeSignature(bundle, signing.teamId);
};
const extractBegin = Date.now();
mkdirSync(join(work, "extract"));
const extracted = await extractMacArchive(join(assets, zipName), join(work, "extract/mac-arm64"));
await verifyExtracted(extracted);
if (
  (await sha256File(join(extracted, "Contents/Resources/app.asar"))) !==
  (await sha256File(join(app, "Contents/Resources/app.asar")))
)
  fail("the extracted app.asar differs from the package.");
await writeBuildInfo(
  "pass: extracted with the updater's bounded ZIP reader; every file hash, mode, symlink, plist and ASAR version matched" +
    (signing.signed
      ? "; the extracted app satisfied Gram's Developer ID requirement and Gatekeeper accepted it as notarized"
      : ""),
);
await verifyExtracted(extracted);
rmSync(join(work, "extract"), { recursive: true, force: true });
steps.push({
  name: "zip-verify",
  command: signing.signed
    ? "extractMacArchive + verifyMacBundleForMethod + verifyMacCodeSignature"
    : "extractMacArchive + verifyMacBundle",
  exit: 0,
  seconds: Math.round(seconds(extractBegin) * 10) / 10,
});

const covered = [];
for (const name of names.slice(0, 5))
  covered.push({ name, sha256: await sha256File(join(assets, name)) });
writeFileSync(join(assets, "SHA256SUMS.txt"), checksumLines(covered));
const check6 = tryRun("/usr/bin/shasum", ["-a", "256", "-c", "SHA256SUMS.txt"], { cwd: assets });
if (check6.status !== 0) fail(`shasum -c failed: ${check6.stdout} ${check6.stderr}`);
// Signed installs update through Electron's updater: its manifest names the signed ZIP and its
// SHA-512. An unsigned build gets none, so no signed install is ever offered it.
if (signing.signed) {
  try {
    const manifest = await writeUpdaterManifest({
      source,
      assets,
      version,
      zipName,
      releaseDate: new Date().toISOString(),
    });
    say(`  ${manifest.name} … ok (read back through electron-updater's parser)`);
  } catch (error) {
    fail(`electron-updater manifest: ${error.message}`);
  }
}
const local = [];
for (const name of uploads) {
  chmodSync(join(assets, name), 0o444);
  local.push({
    name,
    bytes: statSync(join(assets, name)).size,
    sha256: await sha256File(join(assets, name)),
  });
}
say(`  assets … ok (${inventory.length} inventory entries, ${minutes(seconds(assetsBegin))})`);

// ---------------------------------------------------------------------------------------------
// Notes from the squash titles merged since the previous v* tag on this history.
const previousVersion = tagVersions(tags.filter((t) => t !== tag)).find(
  (v) => tryRun("git", ["merge-base", "--is-ancestor", `v${v}`, sha], { cwd: source }).status === 0,
);
const previousTag = previousVersion && `v${previousVersion}`;
const titles = git(
  "log",
  "--first-parent",
  "--format=%s",
  previousTag ? `${previousTag}..${sha}` : sha,
)
  .split("\n")
  .filter(Boolean)
  .filter((title) => !/^chore: prepare private .* metadata/.test(title));
const notes = renderNotes({
  version,
  sha,
  previousTag,
  titles,
  highlights,
  check: checkText,
  signed: signing.signed,
  stable,
});
const notesPath = join(work, "release-notes.md");
writeFileSync(notesPath, notes);
say(`  notes … ${titles.length} merged PRs since ${previousTag ?? "the start"} (${notesPath})`);

/** The state the stable path's later phases read (tools/release-stable). */
const writeState = (release) =>
  writeFileSync(
    join(work, "release.json"),
    `${JSON.stringify(
      {
        version,
        tag,
        repo: REPO,
        source,
        sourceCommit: sha,
        previousStable,
        firstRelease: options.firstRelease === true,
        releaseId: release?.id ?? null,
        releaseUrl: release?.html_url ?? null,
        zipName,
        teamId: signing.teamId,
        minimumMacOS: inspection.minimumMacOS,
        notesPath,
        assets: local,
      },
      null,
      2,
    )}\n`,
  );

if (!options.publish) {
  if (stable) writeState(undefined);
  say(`\nStopped before publishing (--no-publish). Assets: ${assets}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// Publish: gh keeps the release a draft until every upload finishes, then publishes it.
say(`▸ ${options.draft ? "Draft" : "Publish"}`);
const publishBegin = Date.now();
if (
  run("gh", ["api", "--paginate", `repos/${REPO}/releases?per_page=100`, "--jq", ".[].tag_name"])
    .split("\n")
    .includes(tag) ||
  git("ls-remote", "--tags", "origin", tag)
)
  fail(`${tag} appeared while building; nothing was uploaded.`);
const created = tryRun("gh", [
  "release",
  "create",
  tag,
  "--repo",
  REPO,
  "--target",
  sha,
  "--title",
  `Gram ${version}`,
  "--notes-file",
  notesPath,
  ...(stable ? [] : ["--prerelease"]),
  "--latest=false",
  ...(options.draft ? ["--draft"] : []),
  ...uploads.map((name) => join(assets, name)),
]);
if (created.status !== 0) fail(`gh release create failed: ${created.stderr}`);
const release = JSON.parse(
  run("gh", [
    "api",
    "--paginate",
    `repos/${REPO}/releases?per_page=100`,
    "--jq",
    `.[] | select(.tag_name == "${tag}")`,
  ]),
);
const problems = [];
if (release.draft !== options.draft) problems.push(`draft is ${release.draft}`);
if (release.prerelease !== !stable)
  problems.push(stable ? "marked prerelease" : "not marked prerelease");
if (release.assets.length !== uploads.length)
  problems.push(`${release.assets.length} assets, not ${uploads.length}`);
for (const { name, bytes, sha256: digest } of local) {
  const asset = release.assets.find((a) => a.name === name);
  if (!asset) problems.push(`${name} missing`);
  else if (asset.digest !== `sha256:${digest}` || asset.size !== bytes)
    problems.push(`${name}: GitHub has ${asset.digest ?? "no digest"}/${asset.size} bytes`);
}
if (!options.draft) {
  const ref = JSON.parse(run("gh", ["api", `repos/${REPO}/git/ref/tags/${tag}`]));
  const commit =
    ref.object.type === "tag"
      ? JSON.parse(run("gh", ["api", `repos/${REPO}/git/tags/${ref.object.sha}`])).object.sha
      : ref.object.sha;
  if (commit !== sha) problems.push(`tag points at ${commit}`);
  const latest = tryRun("gh", ["api", `repos/${REPO}/releases/latest`, "--jq", ".tag_name"]);
  if (latest.stdout === tag) problems.push("marked latest");
}
steps.push({
  name: options.draft ? "draft" : "publish",
  command: "gh release create + digest check",
  exit: problems.length ? 1 : 0,
  seconds: Math.round(seconds(publishBegin) * 10) / 10,
});
if (problems.length)
  fail(
    `${release.html_url} does not match the local assets: ${problems.join("; ")}. Fix or delete it by hand.`,
  );
say(`  ${release.html_url} · all ${uploads.length} GitHub digests match the local assets`);
if (stable) {
  writeState(release);
  say(
    `\nDrafted ${tag} (stable draft, not latest): ${release.html_url}\n` +
      `Next: bun run release:stable validate --work ${work}, then update-check; publish only ` +
      "once authorized (docs/RELEASING.md).",
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// Record: a short summary of the run, kept in the work dir.
const totalSeconds = seconds(started);
const record = renderRecord({
  version,
  sha,
  previousTag,
  url: release.html_url,
  draft: options.draft,
  publishedAt: release.published_at ?? "",
  check: checkText,
  steps,
  assets: local,
  totalSeconds,
  signed: signing.signed,
});
writeFileSync(join(work, `${version}.md`), record);
say(
  `\n${options.draft ? "Drafted" : "Published"} ${tag} in ${minutes(totalSeconds)}: ${release.html_url}`,
);
say(`Check: ${checkText}. Record, logs and assets: ${work}`);
say(
  `Limits: ${signing.signed ? "Developer ID signed and notarized" : "unsigned (ad-hoc, not notarized)"}; no live-provider test; no installed-update test.`,
);
