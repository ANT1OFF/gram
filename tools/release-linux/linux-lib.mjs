// The Linux half of a stable release: the x64 AppImage and .deb, built on a GitHub-hosted
// ubuntu-24.04 runner by .github/workflows/release-linux.yml from the exact release commit, with a
// GitHub build attestation for each. `release:rc --stable` dispatches that workflow, waits for it,
// downloads and checks what it built here, and attaches it to the same draft as the macOS files
// with your own `gh` login: the workflow itself holds no write token. `release:stable validate`
// checks the downloaded draft's Linux files the same way.
//
// Everything that runs a process takes it as `run(args) → { status, stdout, stderr }`, so the
// tests drive these against a synthetic `gh`.
import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

/** The release repository. */
export const LINUX_REPO = "ANT1OFF/gram";
/** The workflow that builds the Linux release files, and signs their attestations. */
export const LINUX_WORKFLOW = ".github/workflows/release-linux.yml";
/** Its workflow_dispatch runs only ever on this branch, from the release commit at its head. */
export const LINUX_WORKFLOW_REF = "refs/heads/main";
/** The artifact the workflow uploads. */
export const LINUX_ARTIFACT = "gram-linux-release";
/** What the workflow writes about its build, beside the two packages. */
export const LINUX_BUILD_INFO = "LINUX-BUILD.json";
/** The biggest Linux package accepted; the AppImage is about 160 MB. */
export const LINUX_PACKAGE_MAX_BYTES = 600 * 1024 ** 2;

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA = /^[0-9a-f]{40}$/;

/** The two packages for `version`, as electron-builder names them (`gram_${version}_${arch}`). */
export function linuxPackageNames(version) {
  if (!SEMVER.test(version)) throw new Error(`Not a version: ${version}`);
  return {
    appImage: `gram_${version}_x86_64.AppImage`,
    deb: `gram_${version}_amd64.deb`,
  };
}

/** electron-updater's Linux manifest for `version`: `latest-linux.yml`, `rc-linux.yml` for an RC. */
export const linuxManifestName = (version) =>
  version.includes("-") ? "rc-linux.yml" : "latest-linux.yml";

/**
 * Every Linux asset a release carries: the AppImage, the .deb, LINUX-BUILD.json and the AppImage's
 * update manifest. SHA256SUMS.txt lists all but the manifest, as it does the macOS files.
 */
export function linuxAssetNames(version) {
  const { appImage, deb } = linuxPackageNames(version);
  return {
    covered: [appImage, deb, LINUX_BUILD_INFO],
    manifest: linuxManifestName(version),
    all: [appImage, deb, LINUX_BUILD_INFO, linuxManifestName(version)],
  };
}

export const sha256File = (path) =>
  new Promise((done, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => done(hash.digest("hex")))
      .on("error", reject);
  });

/** The first `length` bytes of `path`. */
function head(path, length) {
  const fd = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(length);
    const read = readSync(fd, bytes, 0, length, 0);
    return bytes.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** ELF, then the AppImage type 2 magic (`AI\x02`) at offset 8. */
export const isAppImage = (path) => {
  const bytes = head(path, 11);
  return (
    bytes.length === 11 &&
    bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
    bytes.subarray(8, 11).equals(Buffer.from([0x41, 0x49, 0x02]))
  );
};

/** A Debian package: an `ar` archive whose first member is `debian-binary`. */
export const isDeb = (path) => head(path, 21).toString("latin1") === "!<arch>\ndebian-binary";

/**
 * Why the files the workflow built, in `dir`, aren't exactly this release's, or nothing: the two
 * packages and LINUX-BUILD.json and nothing else; the record naming this version, source commit
 * and run, with each package's size and SHA-256 as found here; and each package's header. Returns
 * `{ problems, info, files }`, `files` being `{ name, bytes, sha256 }` per package.
 */
export async function checkLinuxBuild(dir, { version, sourceCommit, runId }) {
  const problems = [];
  const { appImage, deb } = linuxPackageNames(version);
  const want = [appImage, deb, LINUX_BUILD_INFO].toSorted();
  const found = existsSync(dir) ? readdirSync(dir).toSorted() : [];
  if (JSON.stringify(found) !== JSON.stringify(want))
    problems.push(`the build holds ${found.join(", ") || "nothing"}, not ${want.join(", ")}`);
  let info;
  try {
    info = JSON.parse(readFileSync(join(dir, LINUX_BUILD_INFO), "utf8"));
  } catch {
    problems.push(`${LINUX_BUILD_INFO} is missing or not JSON`);
    return { problems, info: undefined, files: [] };
  }
  if (info.schema !== 1) problems.push(`${LINUX_BUILD_INFO} has schema ${info.schema}`);
  if (info.version !== version) problems.push(`it is for ${info.version}, not ${version}`);
  if (info.sourceCommit !== sourceCommit)
    problems.push(`it was built from ${info.sourceCommit}, not ${sourceCommit}`);
  if (info.workflow !== LINUX_WORKFLOW) problems.push(`it names workflow ${info.workflow}`);
  if (runId !== undefined && String(info.runId) !== String(runId))
    problems.push(`it names run ${info.runId}, not ${runId}`);
  const files = [];
  for (const name of [appImage, deb]) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    const bytes = statSync(path).size;
    const sha256 = await sha256File(path);
    files.push({ name, bytes, sha256 });
    const listed = (info.files ?? []).find((file) => file.name === name);
    if (!listed) problems.push(`${LINUX_BUILD_INFO} doesn't list ${name}`);
    else if (listed.sha256 !== sha256 || listed.bytes !== bytes)
      problems.push(`${name} isn't the file ${LINUX_BUILD_INFO} lists`);
    if (bytes < 1 || bytes > LINUX_PACKAGE_MAX_BYTES) problems.push(`${name} is ${bytes} bytes`);
    if (name === appImage && !isAppImage(path)) problems.push(`${name} isn't an AppImage`);
    if (name === deb && !isDeb(path)) problems.push(`${name} isn't a Debian package`);
  }
  if ((info.files ?? []).length !== 2) problems.push(`${LINUX_BUILD_INFO} lists other files`);
  return { problems, info, files };
}

/** `gh workflow run` for the release build of `version` from `sha`, told apart by `nonce`. */
export function dispatchArgs({ repo = LINUX_REPO, version, sha, nonce, dryRun = false }) {
  if (!SEMVER.test(version) || !SHA.test(sha) || !/^[0-9a-f]{16}$/.test(nonce))
    throw new Error("the Linux build needs a version, a full commit SHA and a 16-hex nonce");
  return [
    "workflow",
    "run",
    "release-linux.yml",
    "--repo",
    repo,
    "--ref",
    "main",
    "-f",
    `version=${version}`,
    "-f",
    `source_sha=${sha}`,
    "-f",
    `nonce=${nonce}`,
    "-f",
    `dry_run=${dryRun}`,
  ];
}

/** The run name the workflow gives a dispatch (its `run-name`), by which the tool finds it. */
export const runTitle = (version, nonce) => `Linux release ${version} (${nonce})`;

/**
 * The one dispatched run of the release workflow named for `version` and `nonce`, on main at
 * `sha`, from `gh run list --json …` output; undefined while it hasn't appeared. Two such runs, or
 * one at another commit, throw.
 */
export function matchRun(list, { version, sha, nonce }) {
  const title = runTitle(version, nonce);
  const runs = list.filter((run) => run.displayTitle === title);
  if (runs.length > 1) throw new Error(`${runs.length} runs are named ${title}`);
  const [run] = runs;
  if (!run) return undefined;
  if (run.event !== "workflow_dispatch" || run.headBranch !== "main" || run.headSha !== sha)
    throw new Error(
      `the run named ${title} is a ${run.event} on ${run.headBranch} at ${run.headSha}, not a dispatch on main at ${sha}`,
    );
  return run;
}

/**
 * Why a finished run (`gh run view --json …`) didn't build this release, or nothing: it must have
 * succeeded, be the release workflow's (`workflowId`, GitHub's id for LINUX_WORKFLOW) dispatch on
 * main at `sha`, and (unless a dry run) have run its attestation job.
 */
export function runProblems(view, { sha, workflowId, dryRun = false }) {
  const problems = [];
  if (view.status !== "completed") problems.push(`it is ${view.status}`);
  else if (view.conclusion !== "success") problems.push(`it ended ${view.conclusion}`);
  if (view.event !== "workflow_dispatch") problems.push(`it is a ${view.event} run`);
  if (view.headBranch !== "main") problems.push(`it ran on ${view.headBranch}`);
  if (view.headSha !== sha) problems.push(`it ran at ${view.headSha}`);
  if (view.workflowDatabaseId !== workflowId)
    problems.push(
      `it is workflow ${view.workflowDatabaseId}, not ${LINUX_WORKFLOW} (${workflowId})`,
    );
  const jobs = new Map((view.jobs ?? []).map((job) => [job.name, job.conclusion]));
  if (jobs.get("build") !== "success")
    problems.push(`its build job is ${jobs.get("build") ?? "missing"}`);
  const attest = jobs.get("attest");
  if (dryRun ? attest === "success" : attest !== "success")
    problems.push(`its attest job is ${attest ?? "missing"}${dryRun ? " in a dry run" : ""}`);
  return problems;
}

/**
 * The exact signer an attestation's certificate must name: this repository's release workflow at
 * main. `--signer-workflow` only matches a prefix of it, which another workflow or ref could share;
 * `--cert-identity` is the whole SubjectAlternativeName.
 */
export const signerIdentity = (repo = LINUX_REPO) =>
  `https://github.com/${repo}/${LINUX_WORKFLOW}@${LINUX_WORKFLOW_REF}`;

/**
 * `gh attestation verify` for one Linux package: a SLSA provenance attestation signed by exactly
 * this repository's release workflow at main (`signerIdentity`), for a run of main at the release
 * commit, on a GitHub-hosted runner.
 */
export const attestationArgs = (file, { repo = LINUX_REPO, sourceCommit }) => [
  "attestation",
  "verify",
  file,
  "--repo",
  repo,
  "--cert-identity",
  signerIdentity(repo),
  "--source-ref",
  LINUX_WORKFLOW_REF,
  "--source-digest",
  sourceCommit,
  "--deny-self-hosted-runners",
  "--predicate-type",
  "https://slsa.dev/provenance/v1",
  "--format",
  "json",
];

/**
 * Checks each package's attestation with `run` (gh). Returns `{ problems, verified }`, `verified`
 * holding each file's name, SHA-256 and how many attestations verified for it.
 */
export function verifyAttestations(run, files, { dir, repo = LINUX_REPO, sourceCommit }) {
  const problems = [];
  const verified = [];
  for (const { name, sha256 } of files) {
    const r = run(attestationArgs(join(dir, name), { repo, sourceCommit }));
    if (r.status !== 0) {
      problems.push(`${name}'s attestation didn't verify: ${(r.stderr || r.stdout).trim()}`);
      continue;
    }
    let results;
    try {
      results = JSON.parse(r.stdout);
    } catch {
      problems.push(`gh attestation verify printed no JSON for ${name}`);
      continue;
    }
    const subjects = Array.isArray(results)
      ? results.flatMap((result) => result?.verificationResult?.statement?.subject ?? [])
      : [];
    if (!subjects.some((subject) => subject?.digest?.sha256 === sha256))
      problems.push(`no verified attestation names ${name}'s SHA-256`);
    else verified.push({ name, sha256, attestations: results.length });
  }
  return { problems, verified };
}
