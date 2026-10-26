#!/usr/bin/env node
// The stable release path after the build: `bun run release:rc --stable <version>` checks, builds,
// signs, notarizes, smokes and makes the assets once, then leaves a private draft and its state in
// the work dir. This tool takes that draft the rest of the way, one phase per run:
//
//   bun run release:stable validate     --work <dir>   fresh download of every draft asset, verified
//   bun run release:stable update-check --work <dir>   read-only update check as the previous release
//   bun run release:stable publish      --work <dir> [--dry-run] [--notes <file>]
//                                       publish the draft as latest, with curated notes
//
// Publishing replaces the draft's build notes with notes for people using the app: the version's
// What's New cards, or a notes file committed in the release's source, both read from the release
// commit and passed through a fail-closed leak check. On a public repository it then reads the
// release back anonymously. Everything else uses your own `gh` login. `--dry-run` does everything
// but the writes to GitHub.
//
// See docs/RELEASING.md.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { REPO } from "../release-rc/rc-lib.mjs";
import {
  STATE_FILE,
  parseStableArgs,
  publicNotesProblems,
  releaseProblems,
  renderPublicNotes,
} from "./stable-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export class ReleaseStop extends Error {}
const stop = (message) => {
  throw new ReleaseStop(message);
};

const sha256File = (path) =>
  new Promise((done, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => done(hash.digest("hex")))
      .on("error", reject);
  });
const sha512Base64 = (path) => createHash("sha512").update(readFileSync(path)).digest("base64");

const now = () => new Date().toISOString();
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

// ---------------------------------------------------------------------------------------------
// gh: your own login.

/** gh's own credential variables, which no call here inherits. */
const GH_CREDENTIALS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
];

/**
 * Variables that make a shell or a tool trace its commands, print its requests or run a startup
 * file. An inherited `SHELLOPTS=xtrace` once printed the token; no call here inherits any of them.
 */
const TRACE_ENV = [
  "SHELLOPTS",
  "BASHOPTS",
  "BASH_XTRACEFD",
  "PS4",
  "BASH_ENV",
  "ENV",
  "GH_DEBUG",
  "DEBUG",
  "NODE_DEBUG",
  "NODE_OPTIONS",
  "GIT_TRACE",
  "GIT_TRACE_CURL",
  "GIT_CURL_VERBOSE",
];

/** `env` without gh's credentials and the tracing variables. */
const scrubbed = (env) =>
  Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => !GH_CREDENTIALS.includes(key) && !TRACE_ENV.includes(key),
    ),
  );

/** The `gh` runner, with your own login. `gh` is a path or a name on PATH. */
export function ghRunners({ gh = "gh", env = process.env }) {
  const base = scrubbed(env);
  const call = (argv, toFile) => {
    const fd = toFile ? openSync(toFile, "w") : undefined;
    try {
      const r = spawnSync(argv[0], argv.slice(1), {
        // github.com only: an exported GH_HOST must not carry your login elsewhere.
        env: { ...base, GH_PROMPT_DISABLED: "1", GH_HOST: "github.com" },
        encoding: toFile ? undefined : "utf8",
        stdio: ["ignore", fd ?? "pipe", "pipe"],
        maxBuffer: 64 * 1024 ** 2,
        timeout: 30 * 60_000,
      });
      return {
        status: r.status,
        stdout: toFile ? "" : (r.stdout ?? "").trim(),
        stderr: String(r.stderr ?? r.error ?? "").trim(),
      };
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
  return { own: (args, toFile) => call([gh, ...args], toFile) };
}

const ghJson = (run, args, what) => {
  const r = run(args);
  if (r.status !== 0) stop(`${what}: ${r.stderr || `gh exited ${r.status}`}`);
  return JSON.parse(r.stdout);
};

const ghMissing = (run, args) => {
  const r = run(args);
  if (r.status === 0) return false;
  if (/HTTP 404|Not Found/.test(r.stderr)) return true;
  return stop(`gh ${args.join(" ")}: ${r.stderr}`);
};

/** The commit a tag ref peels to, or undefined when there is no such tag. */
const tagCommit = (run, repo, tag) => {
  const args = ["api", `repos/${repo}/git/ref/tags/${tag}`];
  if (ghMissing(run, args)) return undefined;
  const ref = ghJson(run, args, `tag ${tag}`);
  return ref.object.type === "tag"
    ? ghJson(run, ["api", `repos/${repo}/git/tags/${ref.object.sha}`], `tag ${tag}`).object.sha
    : ref.object.sha;
};

// ---------------------------------------------------------------------------------------------
// Verification of downloaded assets, shared by the private draft and the public release.

/** Checks every `name  sha` line of a SHA256SUMS.txt in `dir`, and that it lists `covers`. */
async function checkSums(dir, covers) {
  const listed = new Map();
  for (const line of readFileSync(join(dir, "SHA256SUMS.txt"), "utf8")
    .split("\n")
    .filter(Boolean)) {
    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    if (!match) stop(`SHA256SUMS.txt has a malformed line: ${line}`);
    listed.set(match[2], match[1]);
  }
  for (const name of covers) if (!listed.has(name)) stop(`SHA256SUMS.txt doesn't list ${name}.`);
  for (const [name, digest] of listed) {
    if (!existsSync(join(dir, name))) stop(`SHA256SUMS.txt lists ${name}, which isn't there.`);
    if ((await sha256File(join(dir, name))) !== digest)
      stop(`${name} doesn't match SHA256SUMS.txt.`);
  }
  return [...listed.keys()].toSorted();
}

/** electron-updater's manifest, read with its own parser and the app's validation. */
async function checkManifest(dir, { source, version, zipName }) {
  const { validateNativeManifest } = await import(
    pathToFileURL(join(source, "packages/shell/src/modules/update/native-release.ts")).href
  );
  const { parseUpdateInfo } = createRequire(join(source, "apps/desktop/package.json"))(
    "electron-updater/out/providers/Provider",
  );
  const text = readFileSync(join(dir, "latest-mac.yml"), "utf8");
  const parsed = parseUpdateInfo(text, "latest-mac.yml", new URL("https://github.com/"));
  validateNativeManifest(parsed, { version, size: statSync(join(dir, zipName)).size });
  if (parsed.path !== zipName && parsed.files?.[0]?.url !== zipName)
    stop(`latest-mac.yml doesn't name ${zipName}.`);
  if (parsed.sha512 !== sha512Base64(join(dir, zipName)))
    stop("latest-mac.yml doesn't carry the downloaded ZIP's SHA-512.");
}

/**
 * Verifies freshly downloaded assets in `dir`: each equals the local build and GitHub's digest,
 * SHA256SUMS.txt holds, the manifest parses and matches the ZIP, BUILD-INFO (when present) names
 * the version, source and signing, and the app in the ZIP passes `verifyApp`.
 */
export async function verifyDownloads(dir, { expected, remote, covers, state, source, verifyApp }) {
  for (const { name, bytes, sha256 } of expected) {
    const file = join(dir, name);
    if (!existsSync(file)) stop(`${name} wasn't downloaded.`);
    const digest = await sha256File(file);
    if (digest !== sha256 || statSync(file).size !== bytes)
      stop(`the downloaded ${name} differs from the local build.`);
    const asset = remote?.find((a) => a.name === name);
    if (remote && asset?.digest !== `sha256:${digest}`)
      stop(`the downloaded ${name} differs from GitHub's digest.`);
  }
  const sums = await checkSums(dir, covers);
  await checkManifest(dir, { source, version: state.version, zipName: state.zipName });
  if (existsSync(join(dir, "BUILD-INFO.json"))) {
    const info = readJson(join(dir, "BUILD-INFO.json"));
    if (
      info.version !== state.version ||
      info.sourceCommit !== state.sourceCommit ||
      info.developerIdSigned !== true ||
      info.notarized !== true ||
      info.stapled !== true ||
      info.teamId !== state.teamId
    )
      stop("BUILD-INFO.json doesn't name this version, source and Developer ID signing.");
  }
  const app = await verifyApp(join(dir, state.zipName), state);
  return { files: expected.length, sha256sums: sums, manifest: "parsed and matched", app };
}

/** macOS's own verdicts on the app in a downloaded ZIP; see verifyDownloads. */
/** A macOS tool's exit status and its stdout and stderr together. */
const runTool = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 16 * 1024 ** 2 });
  return { status: r.status, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
};

export function macVerifyApp({ source }) {
  return async (zip, state) => {
    const into = mkdtempSync(join(dirname(zip), "extract-"));
    try {
      const unzip = runTool("/usr/bin/ditto", ["-x", "-k", zip, into]);
      if (unzip.status !== 0) stop(`ditto couldn't extract ${zip}: ${unzip.out.trim()}`);
      const app = join(into, "Gram.app");
      const requirement = `=anchor apple generic and identifier "io.github.ant1off.gram" and certificate leaf[subject.OU] = "${state.teamId}"`;
      const verify = runTool("/usr/bin/codesign", [
        "--verify",
        "--deep",
        "--strict",
        "-R",
        requirement,
        app,
      ]);
      if (verify.status !== 0) stop(`codesign --verify failed: ${verify.out.trim()}`);
      const details = runTool("/usr/bin/codesign", ["-dvv", app]).out;
      for (const line of [
        "Identifier=io.github.ant1off.gram",
        `TeamIdentifier=${state.teamId}`,
        "Authority=Developer ID Application: ",
        "Notarization Ticket=stapled",
      ])
        if (!details.includes(line)) stop(`codesign -dvv lacks ${line}`);
      if (!/flags=0x\w+\(runtime\)/.test(details)) stop("the app lacks the hardened runtime.");
      const gatekeeper = runTool("/usr/sbin/spctl", ["-a", "-vvv", "--type", "execute", app]).out;
      if (!/: accepted/.test(gatekeeper) || !gatekeeper.includes("source=Notarized Developer ID"))
        stop(`Gatekeeper didn't accept the app as notarized: ${gatekeeper.trim()}`);
      const stapler = runTool("/usr/bin/xcrun", ["stapler", "validate", app]);
      if (stapler.status !== 0) stop(`stapler validate failed: ${stapler.out.trim()}`);
      const plist = (key) =>
        runTool("/usr/bin/plutil", [
          "-extract",
          key,
          "raw",
          "-o",
          "-",
          join(app, "Contents/Info.plist"),
        ]).out.trim();
      for (const key of ["CFBundleShortVersionString", "CFBundleVersion"])
        if (plist(key) !== state.version)
          stop(`Info.plist ${key} is ${plist(key)}, not ${state.version}.`);
      const asar = createRequire(join(source, "package.json"))("@electron/asar");
      const archive = join(app, "Contents/Resources/app.asar");
      const packaged = JSON.parse(asar.extractFile(archive, "package.json"));
      if (packaged.version !== state.version)
        stop(`app.asar's package.json is ${packaged.version}.`);
      if (!asar.extractFile(archive, "out/main/index.js").toString().includes(state.sourceCommit))
        stop(`the app's main bundle doesn't embed source ${state.sourceCommit}.`);
      return {
        codesign: "verify --deep --strict with Gram's designated requirement",
        identity: `Developer ID team ${state.teamId}, hardened runtime, notarization stapled`,
        gatekeeper: "accepted, Notarized Developer ID",
        stapler: "validate passed",
        version: state.version,
        source: state.sourceCommit,
      };
    } finally {
      rmSync(into, { recursive: true, force: true });
    }
  };
}

// ---------------------------------------------------------------------------------------------
// The update check: tools/release-stable/update-check.mjs under Bun, with the app's own feed.

export function bunUpdateCheck({ bun, harnessSource, gh = "gh", env = process.env }) {
  // Resolved once, from your PATH.
  const bunPath =
    bun ?? spawnSync("/usr/bin/which", ["bun"], { encoding: "utf8", env }).stdout?.trim();
  if (!bunPath) stop("bun is not on PATH; pass --bun <path>.");
  return (args) => {
    const r = spawnSync(
      bunPath,
      [join(HERE, "update-check.mjs"), "--source", harnessSource, ...args],
      {
        encoding: "utf8",
        env: {
          ...scrubbed(env),
          GH_HOST: "github.com",
          PATH: gh.includes("/") ? `${dirname(gh)}:${env.PATH}` : env.PATH,
        },
        timeout: 5 * 60_000,
      },
    );
    if (r.status !== 0)
      stop(`update check failed: ${String(r.error ?? r.stderr ?? r.stdout ?? "").trim()}`);
    return r.stdout
      .split("\n")
      .filter((line) => line.startsWith("GRAM-UPDATE-CHECK "))
      .map((line) => JSON.parse(line.slice("GRAM-UPDATE-CHECK ".length)));
  };
}

/**
 * Fails unless every channel reads as `want`: "available" (this release, by its assets),
 * "upToDate", or "notThis" (anything but this release, as for a draft).
 */
function expectChecks(results, want, state, assets) {
  if (results.length !== 2) stop(`the update check answered ${results.length} channels, not 2.`);
  for (const result of results) {
    if (want === "notThis") {
      if (result.status === "available" && result.version === state.version)
        stop(`${result.channel} already offers ${state.tag} while it is a draft.`);
      continue;
    }
    if (result.status !== want)
      stop(
        `${result.channel}: ${result.status}${result.version ? ` ${result.version}` : ""}, expected ${want}.`,
      );
    if (want !== "available") continue;
    const zip = assets.find((a) => a.name === state.zipName);
    const manifest = assets.find((a) => a.name === "latest-mac.yml");
    if (
      result.version !== state.version ||
      result.tag !== state.tag ||
      result.zip.id !== zip?.id ||
      result.zip.digest !== zip?.digest ||
      result.manifest.id !== manifest?.id
    )
      stop(`${result.channel} offers ${JSON.stringify(result)}, not ${state.tag}'s assets.`);
  }
  return results;
}

// ---------------------------------------------------------------------------------------------
// Phases.

const loadState = (work) => {
  const path = join(work, STATE_FILE);
  if (!existsSync(path)) stop(`${path} is missing: start with bun run release:rc --stable.`);
  const state = readJson(path);
  if (state.repo !== REPO || !state.releaseId)
    stop(`${path} has no private draft (was release:rc --stable run with --no-publish?).`);
  return state;
};

/** Every phase's result goes in the work dir as `<phase>.json`, for the next one and the record. */
const record = (work, phase, result) => {
  writeJson(join(work, `${phase}.json`), { phase, at: now(), ...result });
  return result;
};

/** A phase's earlier result, which must have passed on these exact assets. */
const requirePassed = (work, phase, state) => {
  const path = join(work, `${phase}.json`);
  if (!existsSync(path)) stop(`run release:stable ${phase} first.`);
  const result = readJson(path);
  if (
    result.releaseId !== state.releaseId ||
    JSON.stringify(result.assets) !== JSON.stringify(state.assets)
  )
    stop(`${phase}.json is for other assets; run release:stable ${phase} again.`);
  return result;
};

const privateDraft = (ctx, state) => {
  const release = ghJson(
    ctx.gh.own,
    ["api", `repos/${REPO}/releases/${state.releaseId}`],
    "the private draft",
  );
  const problems = releaseProblems(release, {
    tag: state.tag,
    target: state.sourceCommit,
    draft: true,
    assets: state.assets,
  });
  if (problems.length) stop(`the private draft changed: ${problems.join("; ")}.`);
  return release;
};

/** validate: downloads every asset of the private draft into a new directory and verifies it. */
export async function validate(ctx) {
  const state = loadState(ctx.work);
  const release = privateDraft(ctx, state);
  const dir = mkdtempSync(join(ctx.work, "validate-"));
  for (const asset of release.assets) {
    const r = ctx.gh.own(
      [
        "api",
        "-H",
        "Accept: application/octet-stream",
        `repos/${REPO}/releases/assets/${asset.id}`,
      ],
      join(dir, asset.name),
    );
    if (r.status !== 0) stop(`downloading ${asset.name}: ${r.stderr}`);
  }
  ctx.say(`  downloaded ${release.assets.length} assets into ${dir}`);
  const checks = await verifyDownloads(dir, {
    expected: state.assets,
    remote: release.assets,
    covers: state.assets
      .map((a) => a.name)
      .filter((n) => !["SHA256SUMS.txt", "latest-mac.yml"].includes(n)),
    state,
    source: ctx.source,
    verifyApp: ctx.verifyApp,
  });
  ctx.say(
    `  every asset matches; ${checks.app ? "the app passed codesign, Gatekeeper and stapler" : ""}`,
  );
  return record(ctx.work, "validate", {
    releaseId: state.releaseId,
    assets: state.assets,
    downloadedTo: dir,
    remote: release.assets.map(({ id, name, size, digest }) => ({ id, name, size, digest })),
    checks,
  });
}

/**
 * update-check: as the previous stable release, the private draft as GitHub serves it (never
 * offered), then with its publication simulated (offered on both channels). `--live` checks the
 * published release instead.
 */
export async function updateCheck(ctx) {
  const state = loadState(ctx.work);
  const release = ghJson(
    ctx.gh.own,
    ["api", `repos/${REPO}/releases/${state.releaseId}`],
    "the release",
  );
  // The first release has nothing to update from: it is checked as an install older than any.
  const as = state.previousStable ?? FIRST_RELEASE_CURRENT;
  const base = ["--feed", "private", "--repo", REPO, "--current", as];
  if (ctx.live) {
    if (release.draft) stop("the release is still a draft; --live is for after publish.");
    const live = expectChecks(ctx.updateCheck(base), "available", state, release.assets);
    return record(ctx.work, "update-check-live", {
      releaseId: state.releaseId,
      assets: state.assets,
      live,
    });
  }
  privateDraft(ctx, state);
  const asServed = expectChecks(ctx.updateCheck(base), "notThis", state, release.assets);
  const simulated = expectChecks(
    ctx.updateCheck([...base, "--simulate-publish", state.tag]),
    "available",
    state,
    release.assets,
  );
  ctx.say(`  as ${as}: the draft isn't offered; once published, both channels offer ${state.tag}`);
  return record(ctx.work, "update-check", {
    releaseId: state.releaseId,
    assets: state.assets,
    as,
    asServed,
    simulated,
  });
}

/** A release body as written: GitHub may hand it back with CRLF line ends or no final newline. */
const plain = (text) => (text ?? "").replace(/\r\n/g, "\n").trimEnd();

/** The version a first release's update checks run as: older than any release. */
const FIRST_RELEASE_CURRENT = "0.0.0";

/**
 * The release repository as GitHub names it, which must be exactly `REPO`: a renamed or
 * transferred repository answers under its old name through a redirect, and this tool never
 * publishes into one it reached that way.
 */
const releaseRepo = (ctx) => {
  const repo = ghJson(ctx.gh.own, ["api", `repos/${REPO}`], REPO);
  if (repo.full_name !== REPO) stop(`${REPO} answers as ${repo.full_name}; check the repository.`);
  return repo;
};

/**
 * Why the repository can't take this release as latest, or undefined. A first release
 * (`release:rc --stable --first-release`) needs a repository holding nothing but its own draft and
 * no tag at all; any other release needs `releases/latest` to still be the version it was drafted
 * against.
 */
const latestProblem = (ctx, state) => {
  const latest = ctx.gh.own(["api", `repos/${REPO}/releases/latest`]);
  const latestTag = latest.status === 0 ? JSON.parse(latest.stdout).tag_name : undefined;
  if (state.firstRelease !== true)
    return latestTag === `v${state.previousStable}`
      ? undefined
      : `${REPO}'s latest is ${latestTag ?? "none"}, not v${state.previousStable} as when drafted.`;
  const others = ghJson(
    ctx.gh.own,
    ["api", `repos/${REPO}/releases?per_page=100`],
    "the releases",
  ).filter((release) => release.id !== state.releaseId);
  const tags = ghJson(ctx.gh.own, ["api", `repos/${REPO}/tags?per_page=100`], "the tags");
  if (latestTag || others.length || tags.length)
    return `${state.tag} was drafted as the first release, but ${REPO} now holds ${[
      ...others.map((release) => `release ${release.tag_name}`),
      ...tags.map((tag) => `tag ${tag.name}`),
    ].join(", ")}.`;
  return undefined;
};

/**
 * publish: the validated draft, published as latest with the curated notes. On a public
 * repository the release and its update manifest are then read back anonymously, as an install
 * sees them.
 */
export async function publish(ctx) {
  const state = loadState(ctx.work);
  requirePassed(ctx.work, "validate", state);
  requirePassed(ctx.work, "update-check", state);
  const repo = releaseRepo(ctx);
  privateDraft(ctx, state);
  if (tagCommit(ctx.gh.own, REPO, state.tag)) stop(`tag ${state.tag} already exists on ${REPO}.`);
  const refused = latestProblem(ctx, state);
  if (refused) stop(refused);
  const notes = await ctx.readNotes({
    source: ctx.source,
    commit: state.sourceCommit,
    notesFile: ctx.notes,
    version: state.version,
    minimumMacOS: state.minimumMacOS,
    scratch: ctx.work,
  });
  const notesPath = join(ctx.work, "public-notes.md");
  writeFileSync(notesPath, notes);
  const patch = [
    "api",
    "--method",
    "PATCH",
    `repos/${REPO}/releases/${state.releaseId}`,
    "-f",
    `tag_name=${state.tag}`,
    "-f",
    `target_commitish=${state.sourceCommit}`,
    "-F",
    `body=@${notesPath}`,
    "-F",
    "draft=false",
    "-F",
    "prerelease=false",
    "-f",
    "make_latest=true",
  ];
  if (ctx.dryRun) {
    ctx.say(
      `  dry run: would publish ${state.tag} (release ${state.releaseId}) as latest on ${REPO}, with the notes in ${notesPath}`,
    );
    return { dryRun: true, notesPath };
  }
  const published = publishOrReconcile(
    ctx.gh.own,
    patch,
    `repos/${REPO}/releases/${state.releaseId}`,
    "publishing the release",
    ctx.say,
  );
  const problems = releaseProblems(published, {
    tag: state.tag,
    target: state.sourceCommit,
    draft: false,
    assets: state.assets,
  });
  if (plain(published.body) !== plain(notes)) problems.push("its notes aren't the curated ones");
  const commit = tagCommit(ctx.gh.own, REPO, state.tag);
  if (commit !== state.sourceCommit) problems.push(`tag points at ${commit ?? "nothing"}`);
  const nowLatest = ghJson(ctx.gh.own, ["api", `repos/${REPO}/releases/latest`], "latest").tag_name;
  if (nowLatest !== state.tag) problems.push(`latest is ${nowLatest}`);
  const anonymous = repo.private === false ? await anonymousReadBack(ctx, state) : undefined;
  if (anonymous?.problems.length) problems.push(...anonymous.problems);
  if (problems.length)
    stop(`published, but ${problems.join("; ")}. Check ${published.html_url} by hand.`);
  ctx.say(
    `  published ${published.html_url} at ${published.published_at}, latest, tag on ${state.sourceCommit.slice(0, 8)}${
      anonymous ? "; read back anonymously" : ""
    }`,
  );
  return record(ctx.work, "publish", {
    releaseId: state.releaseId,
    assets: state.assets,
    url: published.html_url,
    publishedAt: published.published_at,
    notesPath,
    ...(anonymous ? { anonymous: anonymous.checked } : {}),
  });
}

/**
 * As a stranger's install sees the public release, with no credentials: `releases/latest` names
 * this tag, and the update manifest downloads with the bytes that were validated.
 */
async function anonymousReadBack(ctx, state) {
  const problems = [];
  const latest = await ctx.anonymous(
    `${ctx.api}/repos/${REPO}/releases/latest`,
    "application/vnd.github+json",
  );
  const shown = latest.status === 200 ? JSON.parse(latest.body.toString("utf8")) : undefined;
  if (shown?.tag_name !== state.tag)
    problems.push(
      `anonymously, latest is ${shown?.tag_name ?? `HTTP ${latest.status}`}, not ${state.tag}`,
    );
  const manifest = state.assets.find((asset) => asset.name === "latest-mac.yml");
  const download = await ctx.anonymous(
    `${ctx.web}/${REPO}/releases/download/${state.tag}/latest-mac.yml`,
    "application/octet-stream",
  );
  const sha256 = createHash("sha256").update(download.body).digest("hex");
  if (download.status !== 200) problems.push(`anonymous latest-mac.yml: HTTP ${download.status}`);
  else if (!manifest || sha256 !== manifest.sha256)
    problems.push("anonymous latest-mac.yml differs from the validated one");
  return { problems, checked: { latest: shown?.tag_name ?? null, manifestSha256: sha256 } };
}

/** git in the release's source checkout. */
/**
 * git in the release's source, reading objects as they are: replacement refs (`refs/replace/*`)
 * once swapped an uncommitted blob in for the committed one, so they are off, and no inherited
 * `GIT_*` variable (GIT_DIR, GIT_REPLACE_REF_BASE, GIT_OBJECT_DIRECTORY, …) may point it elsewhere.
 */
const sourceGit = (source, args) =>
  spawnSync("git", ["--no-replace-objects", ...args], {
    cwd: source,
    encoding: "utf8",
    maxBuffer: 16 * 1024 ** 2,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
      GIT_NO_REPLACE_OBJECTS: "1",
    },
  });

/**
 * Why the source's object store can't be trusted to read the release commit as committed, or
 * undefined: replacement refs or grafts rewrite what git shows. They are ignored anyway, and
 * refused outright, so a checkout carrying them is looked at by hand first.
 */
export function rewrittenHistory(source) {
  const replaced = sourceGit(source, ["for-each-ref", "--format=%(refname)", "refs/replace/"]);
  if (replaced.status !== 0) return `git for-each-ref failed: ${replaced.stderr.trim()}`;
  if (replaced.stdout.trim())
    return `the source has replacement refs (${replaced.stdout.trim().split("\n").join(", ")})`;
  const grafts = sourceGit(source, ["rev-parse", "--git-path", "info/grafts"]).stdout.trim();
  if (grafts && existsSync(resolve(source, grafts))) return `the source has grafts (${grafts})`;
  return undefined;
}

/** Whether the working tree's `file` isn't exactly `text`. */
const differs = (file, text) => !existsSync(file) || readFileSync(file, "utf8") !== text;

/**
 * `path` (inside `source`) as the release commit holds it: its text for a file, or each `.ts`
 * file's for a folder. It is read from the commit's objects (`git show <commit>:<path>`), never from
 * the working tree, so index flags such as assume-unchanged or skip-worktree can't hide an edit;
 * a working tree that differs anyway is refused, so what you reviewed locally is what goes out.
 * Returns `{ files }` (`{ name, text }` each) or `{ problem }`.
 */
export function committedSource(source, commit, path) {
  const rewritten = rewrittenHistory(source);
  if (rewritten) return { problem: rewritten };
  const rel = relative(source, path).split(sep).join("/");
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
    return { problem: `${path} is outside the release's source checkout` };
  const type = sourceGit(source, ["cat-file", "-t", `${commit}:${rel}`]);
  if (type.status !== 0) return { problem: `${rel} isn't in the release commit ${commit}` };
  const blob = (name) => {
    const r = sourceGit(source, ["show", `${commit}:${name}`]);
    if (r.status !== 0) stop(`git show ${commit}:${name}: ${r.stderr.trim()}`);
    return r.stdout;
  };
  if (type.stdout.trim() === "blob") {
    const text = blob(rel);
    if (differs(path, text)) return { problem: `${rel} differs from the release commit` };
    return { files: [{ name: basename(rel), text }] };
  }
  const listed = sourceGit(source, ["ls-tree", "--name-only", `${commit}:${rel}`]);
  const names = listed.stdout
    .split("\n")
    .filter((name) => name.endsWith(".ts"))
    .toSorted();
  const files = names.map((name) => ({ name, text: blob(`${rel}/${name}`) }));
  const local = existsSync(path)
    ? readdirSync(path)
        .filter((name) => name.endsWith(".ts"))
        .toSorted()
    : [];
  if (
    JSON.stringify(local) !== JSON.stringify(names) ||
    files.some(({ name, text }) => differs(join(path, name), text))
  )
    return { problem: `${rel} differs from the release commit` };
  return { files };
}

/**
 * The published notes. By default they are rendered from the version's What's New cards; a hand-written
 * file must be committed in the release's source (docs/public-repo/release-notes/<version>.md, say).
 * Both are read from the release commit itself. Either way they pass `publicNotesProblems`, which
 * refuses anything it doesn't know to be public.
 */
export async function readPublicNotes({
  source,
  commit,
  notesFile,
  version,
  minimumMacOS,
  scratch,
}) {
  let text;
  if (notesFile) {
    const read = committedSource(source, commit, resolve(notesFile));
    if (read.problem)
      stop(`notes must be reviewed content of the release's source: ${read.problem}.`);
    text = read.files[0].text;
  } else {
    // No notes source is a refusal, never a generic text: the cards must be in the release commit.
    const dir = join(source, "apps/web/src/whats-new", version);
    const inCommit = sourceGit(source, [
      "cat-file",
      "-e",
      `${commit}:apps/web/src/whats-new/${version}`,
    ]);
    if (inCommit.status !== 0)
      stop(
        `the release commit has no What's New cards for ${version} (apps/web/src/whats-new/${version}/); add them, or pass --notes <file> committed in the source.`,
      );
    const read = committedSource(source, commit, dir);
    if (read.problem) stop(`the What's New cards aren't the reviewed ones: ${read.problem}.`);
    if (read.files.length === 0)
      stop(
        `apps/web/src/whats-new/${version}/ in the release commit holds no cards; add them, or pass --notes <file>.`,
      );
    // The committed cards, imported from a copy: never the working tree's.
    const cards = [];
    const copy = mkdtempSync(join(scratch, "cards-"));
    for (const { name, text: card } of read.files) {
      writeFileSync(join(copy, name), card);
      cards.push((await import(pathToFileURL(join(copy, name)).href)).default);
    }
    text = renderPublicNotes({ version, cards, minimumMacOS });
  }
  const problems = publicNotesProblems(text, { versions: [version, minimumMacOS] });
  if (problems.length)
    stop(`the notes carry ${problems.join("; ")}. Nothing was written to GitHub.`);
  return text;
}

/**
 * The publishing PATCH, and what GitHub says after it if its answer didn't arrive: the server may
 * have applied it all the same. Returns the release as published, or stops when it is still a
 * draft. Any other state is for the caller's checks to catch.
 */
function publishOrReconcile(run, patch, release, what, say) {
  try {
    return ghJson(run, patch, what);
  } catch (error) {
    if (!(error instanceof ReleaseStop)) throw error;
    const reread = run(["api", release]);
    if (reread.status !== 0)
      stop(
        `${error.message} Reading the release back failed too (${reread.stderr}); check it by hand.`,
      );
    const shown = JSON.parse(reread.stdout);
    if (shown.draft !== false) stop(`${error.message} GitHub still shows it as a draft.`);
    say(`  the answer to ${what} was lost, but GitHub shows it published; checking it as usual`);
    return shown;
  }
}

const PHASE_RUNNERS = { validate, "update-check": updateCheck, publish };

/** An anonymous GET with Node's fetch: no cookies, no Authorization header, redirects followed. */
const anonymousGet = async (url, accept) => {
  const response = await fetch(url, {
    headers: { accept },
    redirect: "follow",
    credentials: "omit",
    signal: AbortSignal.timeout(10 * 60_000),
  });
  return { status: response.status, body: Buffer.from(await response.arrayBuffer()) };
};

/** Runs one phase with `options` (parseStableArgs) and the real world, unless `seams` replaces parts. */
export async function runPhase(options, seams = {}) {
  const work = resolve(options.work);
  if (!existsSync(join(work, STATE_FILE)))
    stop(`${join(work, STATE_FILE)} is missing: start with bun run release:rc --stable.`);
  const state = readJson(join(work, STATE_FILE));
  const source = resolve(seams.source ?? state.source ?? process.cwd());
  // The manifest checks, the feed and the What's New cards come from this checkout: it must be
  // the source the release was built from.
  const head = sourceGit(source, ["rev-parse", "HEAD"]);
  if (head.stdout?.trim() !== state.sourceCommit)
    stop(
      `${source} is at ${head.stdout?.trim() || "no commit"}, not the release's ${state.sourceCommit}; check it out first.`,
    );
  const gh = seams.gh ?? "gh";
  const ctx = {
    work,
    source,
    dryRun: options.dryRun,
    live: options.live,
    notes: options.notes,
    // The release commit's notes; a test gives a source of its own.
    readNotes: seams.readNotes ?? readPublicNotes,
    // A synthetic GitHub's origins, in tests only.
    api: seams.api ?? "https://api.github.com",
    web: seams.web ?? "https://github.com",
    anonymous: seams.anonymous ?? anonymousGet,
    say: seams.say ?? ((line) => process.stdout.write(`${line}\n`)),
    gh: ghRunners({ gh, env: seams.env ?? process.env }),
    verifyApp: seams.verifyApp ?? macVerifyApp({ source }),
    updateCheck:
      seams.updateCheck ??
      bunUpdateCheck({
        bun: options.bun,
        harnessSource: resolve(options.harnessSource ?? source),
        gh,
        env: seams.env ?? process.env,
      }),
  };
  return await PHASE_RUNNERS[options.phase](ctx);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseStableArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(
        `${readFileSync(fileURLToPath(import.meta.url), "utf8")
          .split("\n")
          .slice(1)
          .filter((line, i, lines) => lines.slice(0, i + 1).every((l) => l.startsWith("//")))
          .join("\n")}\n`,
      );
      process.exit(0);
    }
    process.stdout.write(
      `▸ release:stable ${options.phase}${options.dryRun ? " (dry run)" : ""}\n`,
    );
    await runPhase(options);
    process.stdout.write(`release:stable ${options.phase}: done\n`);
  } catch (error) {
    process.stderr.write(
      `\nrelease:stable stopped: ${error instanceof ReleaseStop ? error.message : error.stack}\n`,
    );
    process.exit(1);
  }
}
