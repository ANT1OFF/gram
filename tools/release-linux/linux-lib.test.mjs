import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LINUX_BUILD_INFO,
  LINUX_WORKFLOW,
  attestationArgs,
  checkLinuxBuild,
  dispatchArgs,
  linuxAssetNames,
  linuxManifestName,
  linuxPackageNames,
  matchRun,
  rerunArgs,
  runNonce,
  runProblems,
  runTitle,
  verifyAttestations,
} from "./linux-lib.mjs";
import {
  LinuxBuildError,
  adoptLinuxBuild,
  collectLinuxBuild,
  startLinuxBuild,
} from "./linux-release.mjs";
import { writeLinuxBuild } from "./testing/linux-build.mjs";

const SHA = "a".repeat(40);
const VERSION = "1.4.0";
const NONCE = "0123456789abcdef";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** gh's JSON for a verified attestation of `digest`. */
const verdict = (digest) =>
  JSON.stringify([
    { verificationResult: { statement: { subject: [{ digest: { sha256: digest } }] } } },
  ]);
const ok = (value) => ({ status: 0, stdout: JSON.stringify(value), stderr: "" });

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "gram-linux-release-"));
  dirs.push(dir);
  return dir;
};

describe("Linux release names", () => {
  it("names electron-builder's packages, the record and electron-updater's manifest", () => {
    expect(linuxPackageNames("1.4.0")).toEqual({
      appImage: "gram_1.4.0_x86_64.AppImage",
      deb: "gram_1.4.0_amd64.deb",
    });
    expect(linuxManifestName("1.4.0")).toBe("latest-linux.yml");
    expect(linuxManifestName("1.4.0-rc.1")).toBe("rc-linux.yml");
    expect(linuxAssetNames("1.4.0")).toEqual({
      covered: ["gram_1.4.0_x86_64.AppImage", "gram_1.4.0_amd64.deb", "LINUX-BUILD.json"],
      manifest: "latest-linux.yml",
      all: [
        "gram_1.4.0_x86_64.AppImage",
        "gram_1.4.0_amd64.deb",
        "LINUX-BUILD.json",
        "latest-linux.yml",
      ],
    });
    expect(() => linuxPackageNames("../1.4.0")).toThrow();
  });
});

describe("checkLinuxBuild", () => {
  it("accepts exactly this release's build", async () => {
    const dir = scratch();
    const info = writeLinuxBuild(dir);
    const checked = await checkLinuxBuild(dir, { version: VERSION, sourceCommit: SHA, runId: 77 });
    expect(checked.problems).toEqual([]);
    expect(checked.files).toEqual(info.files);
  });

  it("refuses another version, source, run or workflow, and an extra file", async () => {
    const cases = [
      [{ version: "1.3.9" }, /not 1\.4\.0|holds/],
      [{ sourceCommit: "b".repeat(40) }, /built from b{40}/],
      [{ runId: 78 }, /names run 78, not 77/],
      [
        { edit: (info) => ({ ...info, workflow: ".github/workflows/check.yml" }) },
        /names workflow/,
      ],
      [{ edit: (info) => ({ ...info, schema: 2 }) }, /schema 2/],
    ];
    for (const [how, problem] of cases) {
      const dir = scratch();
      writeLinuxBuild(dir, how);
      const checked = await checkLinuxBuild(dir, {
        version: VERSION,
        sourceCommit: SHA,
        runId: 77,
      });
      expect(checked.problems.join("; ")).toMatch(problem);
    }
    const extra = scratch();
    writeLinuxBuild(extra);
    writeFileSync(join(extra, "evil.sh"), "#!/bin/sh\n");
    expect(
      (await checkLinuxBuild(extra, { version: VERSION, sourceCommit: SHA, runId: 77 })).problems,
    ).toContainEqual(expect.stringMatching(/the build holds .*evil\.sh/));
  });

  it("refuses a package that isn't the file the record lists, or isn't what it is named", async () => {
    const dir = scratch();
    writeLinuxBuild(dir);
    const { appImage, deb } = linuxPackageNames(VERSION);
    writeFileSync(join(dir, appImage), "#!/bin/sh\necho swapped\n");
    writeFileSync(join(dir, deb), "PK\u0003\u0004 not a deb");
    const { problems } = await checkLinuxBuild(dir, {
      version: VERSION,
      sourceCommit: SHA,
      runId: 77,
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        `${appImage} isn't the file ${LINUX_BUILD_INFO} lists`,
        `${appImage} isn't an AppImage`,
        `${deb} isn't a Debian package`,
      ]),
    );
  });
});

describe("the dispatched run", () => {
  it("dispatches on main for the release commit, refusing anything else", () => {
    expect(dispatchArgs({ version: VERSION, sha: SHA, nonce: NONCE })).toEqual([
      "workflow",
      "run",
      "release-linux.yml",
      "--repo",
      "ANT1OFF/gram",
      "--ref",
      "main",
      "-f",
      "version=1.4.0",
      "-f",
      `source_sha=${SHA}`,
      "-f",
      `nonce=${NONCE}`,
      "-f",
      "dry_run=false",
    ]);
    for (const bad of [
      { version: "1.4.0; rm -rf", sha: SHA, nonce: NONCE },
      { version: VERSION, sha: "main", nonce: NONCE },
      { version: VERSION, sha: SHA, nonce: "x" },
    ])
      expect(() => dispatchArgs(bad)).toThrow();
  });

  it("finds the run by its name, and refuses one that isn't a dispatch on main at the commit", () => {
    const run = {
      databaseId: 77,
      displayTitle: runTitle(VERSION, NONCE),
      event: "workflow_dispatch",
      headBranch: "main",
      headSha: SHA,
    };
    const other = { ...run, databaseId: 76, displayTitle: runTitle(VERSION, "f".repeat(16)) };
    expect(matchRun([other], { version: VERSION, sha: SHA, nonce: NONCE })).toBeUndefined();
    expect(matchRun([other, run], { version: VERSION, sha: SHA, nonce: NONCE })).toBe(run);
    expect(() =>
      matchRun([{ ...run, headSha: "b".repeat(40) }], { version: VERSION, sha: SHA, nonce: NONCE }),
    ).toThrow(/not a dispatch on main/);
    expect(() =>
      matchRun([{ ...run, headBranch: "feat/x" }], { version: VERSION, sha: SHA, nonce: NONCE }),
    ).toThrow(/not a dispatch on main/);
    expect(() => matchRun([run, run], { version: VERSION, sha: SHA, nonce: NONCE })).toThrow(
      /2 runs/,
    );
  });

  it("requires a successful build and attestation from the release workflow", () => {
    const view = {
      status: "completed",
      conclusion: "success",
      event: "workflow_dispatch",
      headBranch: "main",
      headSha: SHA,
      workflowDatabaseId: 9,
      jobs: [
        { name: "build", conclusion: "success" },
        { name: "sherpa-onnx", conclusion: "success" },
        { name: "attest", conclusion: "success" },
      ],
    };
    expect(runProblems(view, { sha: SHA, workflowId: 9 })).toEqual([]);
    // The sherpa-onnx rebuild runs beside the build; a run without its pass builds no release.
    expect(
      runProblems(
        { ...view, jobs: view.jobs.filter((j) => j.name !== "sherpa-onnx") },
        { sha: SHA, workflowId: 9 },
      ),
    ).toEqual(["its sherpa-onnx job is missing"]);
    expect(runProblems({ ...view, conclusion: "failure" }, { sha: SHA, workflowId: 9 })).toEqual([
      "it ended failure",
    ]);
    expect(runProblems(view, { sha: SHA, workflowId: 10 })[0]).toMatch(/not .*release-linux\.yml/);
    const unattested = {
      ...view,
      jobs: [...view.jobs.slice(0, 2), { name: "attest", conclusion: "skipped" }],
    };
    expect(runProblems(unattested, { sha: SHA, workflowId: 9 })).toEqual([
      "its attest job is skipped",
    ]);
    expect(runProblems(unattested, { sha: SHA, workflowId: 9, dryRun: true })).toEqual([]);
    // A dry run that signed anyway is not a dry run.
    expect(runProblems(view, { sha: SHA, workflowId: 9, dryRun: true })).toEqual([
      "its attest job is success in a dry run",
    ]);
  });

  it("reads the nonce of a run named for this version, and reruns only failed jobs", () => {
    expect(runNonce(runTitle(VERSION, NONCE), VERSION)).toBe(NONCE);
    expect(runNonce(runTitle("1.3.9", NONCE), VERSION)).toBeUndefined();
    expect(runNonce("Linux release dry run (feat/x)", VERSION)).toBeUndefined();
    expect(runNonce(undefined, VERSION)).toBeUndefined();
    expect(rerunArgs({ runId: 77 })).toEqual([
      "run",
      "rerun",
      "77",
      "--failed",
      "--repo",
      "ANT1OFF/gram",
    ]);
    expect(() => rerunArgs({ runId: "77 --debug" })).toThrow();
  });
});

describe("attestations", () => {
  it("asks gh for the release workflow's provenance on main at the release commit", () => {
    expect(attestationArgs("/d/gram.AppImage", { sourceCommit: SHA })).toEqual([
      "attestation",
      "verify",
      "/d/gram.AppImage",
      "--repo",
      "ANT1OFF/gram",
      "--cert-identity",
      "https://github.com/ANT1OFF/gram/.github/workflows/release-linux.yml@refs/heads/main",
      "--source-ref",
      "refs/heads/main",
      "--source-digest",
      SHA,
      "--deny-self-hosted-runners",
      "--predicate-type",
      "https://slsa.dev/provenance/v1",
      "--format",
      "json",
    ]);
  });

  it("passes only when gh verified an attestation naming each file's SHA-256", () => {
    const files = [
      { name: "a.AppImage", sha256: "1".repeat(64) },
      { name: "a.deb", sha256: "2".repeat(64) },
    ];
    const run = vi.fn((args) =>
      args[2].endsWith(".AppImage")
        ? { status: 0, stdout: verdict("1".repeat(64)), stderr: "" }
        : { status: 1, stdout: "", stderr: "no attestations found" },
    );
    const result = verifyAttestations(run, files, { dir: "/d", sourceCommit: SHA });
    expect(result.verified).toEqual([
      { name: "a.AppImage", sha256: "1".repeat(64), attestations: 1 },
    ]);
    expect(result.problems).toEqual(["a.deb's attestation didn't verify: no attestations found"]);
    const wrong = verifyAttestations(
      () => ({ status: 0, stdout: verdict("9".repeat(64)), stderr: "" }),
      files.slice(0, 1),
      { dir: "/d", sourceCommit: SHA },
    );
    expect(wrong.problems).toEqual(["no verified attestation names a.AppImage's SHA-256"]);
  });
});

/**
 * A synthetic `gh` for the release workflow: the dispatch, a run list that shows the run on the
 * second look, its view (in progress, then done), the artifact download and the attestations.
 */
function fakeGh({ view = {}, attest = true, build = {} } = {}) {
  const calls = [];
  let nonce;
  let lists = 0;
  let views = 0;
  const run = (args) => {
    calls.push(args.join(" "));
    if (args[0] === "workflow" && args[1] === "run") {
      nonce = args.find((arg) => arg.startsWith("nonce=")).slice(6);
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "api" && args[1].endsWith("actions/workflows/release-linux.yml"))
      return ok({ id: 9, path: LINUX_WORKFLOW });
    if (args[0] === "run" && args[1] === "list")
      return ok(
        ++lists < 2
          ? []
          : [
              {
                databaseId: 77,
                displayTitle: runTitle(VERSION, nonce),
                event: "workflow_dispatch",
                headBranch: "main",
                headSha: SHA,
              },
            ],
      );
    if (args[0] === "run" && args[1] === "view")
      return ok({
        status: ++views < 2 ? "in_progress" : "completed",
        conclusion: views < 2 ? null : "success",
        event: "workflow_dispatch",
        headBranch: "main",
        headSha: SHA,
        workflowDatabaseId: 9,
        url: "https://github.com/ANT1OFF/gram/actions/runs/77",
        jobs: [
          { name: "build", conclusion: "success" },
          { name: "sherpa-onnx", conclusion: "success" },
          { name: "attest", conclusion: "success" },
        ],
        ...view,
      });
    if (args[0] === "run" && args[1] === "download") {
      writeLinuxBuild(args[args.indexOf("--dir") + 1], build);
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "attestation") {
      if (!attest) return { status: 1, stdout: "", stderr: "no attestations found" };
      const digest = sha256(readFileSync(args[2]));
      return ok([
        { verificationResult: { statement: { subject: [{ digest: { sha256: digest } }] } } },
      ]);
    }
    return { status: 99, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };
  return { run, calls };
}

/** `collectLinuxBuild` with no waiting between polls. */
const collect = (gh, assets, build) =>
  collectLinuxBuild(build, {
    gh,
    into: join(scratch(), "linux"),
    assets,
    sleep: async () => {},
    pollMs: 0,
  });

describe("collectLinuxBuild", () => {
  it("waits for the dispatched run, then checks and copies exactly its files", async () => {
    const gh = fakeGh();
    const assets = scratch();
    const build = startLinuxBuild({ gh: gh.run, version: VERSION, sha: SHA });
    const got = await collect(gh.run, assets, build);
    expect(got.runId).toBe(77);
    expect(got.attestations.map((a) => a.name)).toEqual([
      "gram_1.4.0_x86_64.AppImage",
      "gram_1.4.0_amd64.deb",
    ]);
    expect(readdirSync(assets).toSorted()).toEqual([
      "LINUX-BUILD.json",
      "gram_1.4.0_amd64.deb",
      "gram_1.4.0_x86_64.AppImage",
    ]);
    // Nothing it asked gh for writes anything but the dispatch.
    expect(
      gh.calls.filter(
        (call) =>
          !/^(workflow run|api repos|run (list|view|download)|attestation verify)/.test(call),
      ),
    ).toEqual([]);
  });

  it("copies nothing from a failed run, an unattested build or another commit's build", async () => {
    for (const how of [
      { view: { conclusion: "failure" } },
      { attest: false },
      { build: { sourceCommit: "b".repeat(40) } },
    ]) {
      const gh = fakeGh(how);
      const assets = scratch();
      const build = startLinuxBuild({ gh: gh.run, version: VERSION, sha: SHA });
      await expect(collect(gh.run, assets, build)).rejects.toThrow();
      expect(readdirSync(assets)).toEqual([]);
    }
  });

  it("skips the attestation only on a dry run", async () => {
    const gh = fakeGh({
      view: {
        jobs: [
          { name: "build", conclusion: "success" },
          { name: "sherpa-onnx", conclusion: "success" },
          { name: "attest", conclusion: "skipped" },
        ],
      },
    });
    const build = startLinuxBuild({ gh: gh.run, version: VERSION, sha: SHA, dryRun: true });
    expect(gh.calls[0]).toMatch(/dry_run=true$/);
    const got = await collect(gh.run, scratch(), build);
    expect(got.attestations).toEqual([]);
    expect(gh.calls.some((call) => call.startsWith("attestation"))).toBe(false);
  });
});

/**
 * A run that already exists, as `gh run view` shows it look after look: `views` is the sequence
 * (the last repeats), each `{ attempt, status, conclusion }` over a successful release run.
 */
function existingRunGh(views, { title = runTitle(VERSION, NONCE), headSha = SHA } = {}) {
  const calls = [];
  let look = 0;
  const run = (args) => {
    calls.push(args.join(" "));
    if (args[0] === "api" && args[1].endsWith("actions/workflows/release-linux.yml"))
      return ok({ id: 9, path: LINUX_WORKFLOW });
    if (args[0] === "run" && args[1] === "view") {
      const at = views[Math.min(look++, views.length - 1)];
      return ok({
        databaseId: 77,
        displayTitle: title,
        event: "workflow_dispatch",
        headBranch: "main",
        headSha,
        workflowDatabaseId: 9,
        url: "https://github.com/ANT1OFF/gram/actions/runs/77",
        jobs: [
          { name: "build", conclusion: at.conclusion === "success" ? "success" : "failure" },
          { name: "sherpa-onnx", conclusion: "success" },
          { name: "attest", conclusion: at.conclusion === "success" ? "success" : "skipped" },
        ],
        ...at,
      });
    }
    if (args[0] === "run" && args[1] === "rerun") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "run" && args[1] === "download") {
      writeLinuxBuild(args[args.indexOf("--dir") + 1]);
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "attestation") return ok(JSON.parse(verdict(sha256(readFileSync(args[2])))));
    return { status: 99, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };
  return { run, calls };
}

const failed = { attempt: 1, status: "completed", conclusion: "failure" };
const passed = (attempt) => ({ attempt, status: "completed", conclusion: "success" });

describe("adopting and rerunning a Linux build", () => {
  it("adopts a run dispatched for this release, and refuses any other", () => {
    const adopted = adoptLinuxBuild({
      gh: existingRunGh([passed(1)]).run,
      version: VERSION,
      sha: SHA,
      runId: 77,
    });
    expect(adopted).toMatchObject({ runId: 77, nonce: NONCE, sha: SHA, dryRun: false });
    expect(() =>
      adoptLinuxBuild({
        gh: existingRunGh([passed(1)], { title: runTitle("1.3.9", NONCE) }).run,
        version: VERSION,
        sha: SHA,
        runId: 77,
      }),
    ).toThrow(/not as a 1\.4\.0 release/);
    expect(() =>
      adoptLinuxBuild({
        gh: existingRunGh([passed(1)], { headSha: "b".repeat(40) }).run,
        version: VERSION,
        sha: SHA,
        runId: 77,
      }),
    ).toThrow(/ran at b{40}/);
    expect(() =>
      adoptLinuxBuild({ gh: existingRunGh([]).run, version: VERSION, sha: SHA, runId: "x" }),
    ).toThrow(/Not a run id/);
  });

  it("reruns a failed run's failed jobs once, at the same commit, and takes the new attempt", async () => {
    // The view may still show the failed attempt right after the rerun is asked for.
    const gh = existingRunGh([
      failed,
      failed,
      { attempt: 2, status: "in_progress", conclusion: "" },
      passed(2),
    ]);
    const build = adoptLinuxBuild({ gh: gh.run, version: VERSION, sha: SHA, runId: 77 });
    const assets = scratch();
    const got = await collectLinuxBuild(build, {
      gh: gh.run,
      into: join(scratch(), "linux"),
      assets,
      sleep: async () => {},
      pollMs: 0,
      reruns: 1,
    });
    expect(got).toMatchObject({ runId: 77, attempt: 2 });
    expect(gh.calls.filter((call) => call.startsWith("run rerun"))).toEqual([
      "run rerun 77 --failed --repo ANT1OFF/gram",
    ]);
    expect(readdirSync(assets)).toHaveLength(3);
  });

  it("stops after its reruns, naming the run to pick up later, with nothing copied", async () => {
    // adoptLinuxBuild takes the first look.
    const gh = existingRunGh([failed, failed, { ...failed, attempt: 2 }]);
    const build = adoptLinuxBuild({ gh: gh.run, version: VERSION, sha: SHA, runId: 77 });
    const assets = scratch();
    const error = await collectLinuxBuild(build, {
      gh: gh.run,
      into: join(scratch(), "linux"),
      assets,
      sleep: async () => {},
      pollMs: 0,
      reruns: 1,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(LinuxBuildError);
    expect(error.message).toMatch(/it ended failure; its build job is failure/);
    expect(error).toMatchObject({ runId: 77, runUrl: expect.stringMatching(/runs\/77$/) });
    expect(gh.calls.filter((call) => call.startsWith("run rerun"))).toHaveLength(1);
    expect(readdirSync(assets)).toEqual([]);
  });
});
