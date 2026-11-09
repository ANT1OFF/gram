import { describe, expect, it } from "vitest";

import {
  CHECK_WORKFLOW,
  checkRunState,
  describeCheckRun,
  findCheckRun,
  pickCheckRun,
  waitForCheckRun,
} from "./ci-check.mjs";

const SHA = "a".repeat(40);
const REPO = "ANT1OFF/gram";
const ok = (value) => ({ status: 0, stdout: JSON.stringify(value), stderr: "" });
const done = (name, conclusion = "success") => ({ name, status: "completed", conclusion });
const running = (name) => ({ name, status: "in_progress", conclusion: "" });

/** The lanes of a main push run as check.yml names them, all passed, plus the rest of the run. */
const LANES = [
  "check static",
  "check tests 1/2",
  "check tests 2/2",
  "macos tests 1/3",
  "macos tests 2/3",
  "macos tests 3/3",
];
const view = (over = {}) => ({
  databaseId: 501,
  event: "push",
  headBranch: "main",
  headSha: SHA,
  workflowDatabaseId: 3,
  status: "in_progress",
  conclusion: "",
  attempt: 1,
  url: `https://github.com/${REPO}/actions/runs/501`,
  jobs: [done("classify"), ...LANES.map((name) => done(name)), running("e2e 4/8")],
  ...over,
});

describe("main's check run as the release check", () => {
  it("takes the newest push run on main at the commit", () => {
    const list = [
      { databaseId: 9, event: "push", headBranch: "main", headSha: SHA },
      { databaseId: 12, event: "push", headBranch: "main", headSha: SHA },
      { databaseId: 13, event: "pull_request", headBranch: "main", headSha: SHA },
      { databaseId: 14, event: "push", headBranch: "main", headSha: "b".repeat(40) },
      { databaseId: 15, event: "push", headBranch: "feat/x", headSha: SHA },
    ];
    expect(pickCheckRun(list, SHA).databaseId).toBe(12);
    expect(pickCheckRun([], SHA)).toBeUndefined();
  });

  it("passes once every shard of the check lanes passed, with the rest of the run still going", () => {
    const state = checkRunState(view(), { sha: SHA, workflowId: 3 });
    expect(state.problems).toEqual([]);
    expect(state.pending).toEqual([]);
    expect(state.jobs.map((job) => job.name)).toEqual(LANES);
  });

  it("waits for lanes still running, or not created yet", () => {
    const some = view({
      jobs: [done("check static"), running("check tests 1/2"), done("check tests 2/2")],
    });
    expect(checkRunState(some, { sha: SHA, workflowId: 3 })).toEqual({
      problems: [],
      pending: ["check tests 1/2", "macos tests"],
      jobs: [],
    });
  });

  it("refuses another commit, event, branch or workflow", () => {
    for (const [over, problem] of [
      [{ headSha: "b".repeat(40) }, /ran at b{40}/],
      [{ event: "pull_request" }, /pull_request run/],
      [{ headBranch: "release" }, /ran on release/],
      [{ workflowDatabaseId: 4 }, new RegExp(`not ${CHECK_WORKFLOW.replaceAll(".", "\\.")}`)],
    ])
      expect(checkRunState(view(over), { sha: SHA, workflowId: 3 }).problems.join("; ")).toMatch(
        problem,
      );
  });

  it("refuses any failed job, a skipped lane, and a shard missing once the run is over", () => {
    const failing = view({ jobs: [...view().jobs, done("e2e 2/8", "failure")] });
    expect(checkRunState(failing, { sha: SHA, workflowId: 3 }).problems).toEqual([
      'its job "e2e 2/8" ended failure',
    ]);
    const skipped = view({
      jobs: view().jobs.map((job) =>
        job.name === "macos tests 2/3" ? done(job.name, "skipped") : job,
      ),
    });
    expect(checkRunState(skipped, { sha: SHA, workflowId: 3 }).problems).toEqual([
      'its job "macos tests 2/3" is skipped',
    ]);
    const missing = view({
      status: "completed",
      conclusion: "success",
      jobs: view().jobs.filter((job) => job.name !== "check tests 2/2"),
    });
    expect(checkRunState(missing, { sha: SHA, workflowId: 3 }).problems).toEqual([
      'its "check tests" shards are check tests 1/2',
    ]);
    const none = view({
      status: "completed",
      conclusion: "success",
      jobs: view().jobs.filter((job) => !job.name.startsWith("macos tests")),
    });
    expect(checkRunState(none, { sha: SHA, workflowId: 3 }).problems).toEqual([
      'it has no "macos tests" job',
    ]);
    const renamed = view({ jobs: [...view().jobs, done("check tests (linux) 1/2")] });
    expect(checkRunState(renamed, { sha: SHA, workflowId: 3 }).problems[0]).toMatch(
      /"check tests" jobs are named/,
    );
  });
});

/** A synthetic gh answering for check.yml, its runs and the views of run 501, look after look. */
function fakeGh({ list = [{ databaseId: 501 }], views = [view()] } = {}) {
  const calls = [];
  let look = 0;
  const run = (args) => {
    calls.push(args.join(" "));
    if (args[0] === "api" && args[1] === `repos/${REPO}/actions/workflows/check.yml`)
      return ok({ id: 3, path: CHECK_WORKFLOW });
    if (args[0] === "run" && args[1] === "list")
      return ok(
        list.map((entry) => ({ event: "push", headBranch: "main", headSha: SHA, ...entry })),
      );
    if (args[0] === "run" && args[1] === "view")
      return ok(views[Math.min(look++, views.length - 1)]);
    return { status: 99, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };
  return { run, calls };
}

describe("finding and waiting for main's check run", () => {
  it("finds the run by the exact commit, or nothing", () => {
    const gh = fakeGh();
    expect(findCheckRun({ gh: gh.run, repo: REPO, sha: SHA })).toEqual({
      workflowId: 3,
      runId: 501,
      url: `https://github.com/${REPO}/actions/runs/501`,
    });
    expect(gh.calls[1]).toMatch(
      new RegExp(
        `^run list --repo ${REPO} --workflow check.yml --event push --branch main --commit ${SHA} `,
      ),
    );
    expect(findCheckRun({ gh: fakeGh({ list: [] }).run, repo: REPO, sha: SHA })).toBeUndefined();
  });

  it("stops at once on a run that already failed", () => {
    const gh = fakeGh({
      views: [view({ jobs: [done("check tests 1/2", "failure")] })],
    });
    expect(() => findCheckRun({ gh: gh.run, repo: REPO, sha: SHA })).toThrow(
      /check tests 1\/2" ended failure/,
    );
  });

  it("waits for the lanes, then returns the evidence BUILD-INFO.json records", async () => {
    const gh = fakeGh({
      views: [view({ jobs: [running("check static")] }), view({ attempt: 2 })],
    });
    const said = [];
    const evidence = await waitForCheckRun(
      { workflowId: 3, runId: 501 },
      { gh: gh.run, repo: REPO, sha: SHA, say: (line) => said.push(line), sleep: async () => {} },
    );
    expect(evidence).toEqual({
      workflow: CHECK_WORKFLOW,
      runId: 501,
      runAttempt: 2,
      url: `https://github.com/${REPO}/actions/runs/501`,
      event: "push",
      branch: "main",
      sourceCommit: SHA,
      jobs: LANES.map((name) => ({ name, conclusion: "success" })),
    });
    expect(said).toEqual([
      "  waiting for main's check run: check static, check tests, macos tests",
    ]);
    expect(describeCheckRun(evidence)).toBe(
      `main CI run 501 (attempt 2) passed check static, 2 check tests and 3 macos tests shards at ${SHA.slice(0, 12)}`,
    );
  });

  it("stops when a job fails while waiting, or the lanes run out of time", async () => {
    const failing = fakeGh({
      views: [
        view({ jobs: [running("check static")] }),
        view({ jobs: [done("macos tests 3/3", "cancelled")] }),
      ],
    });
    await expect(
      waitForCheckRun(
        { workflowId: 3, runId: 501 },
        { gh: failing.run, repo: REPO, sha: SHA, sleep: async () => {} },
      ),
    ).rejects.toThrow(/macos tests 3\/3" ended cancelled/);
    let clock = 0;
    await expect(
      waitForCheckRun(
        { workflowId: 3, runId: 501 },
        {
          gh: fakeGh({ views: [view({ jobs: [running("check static")] })] }).run,
          repo: REPO,
          sha: SHA,
          sleep: async () => {},
          now: () => (clock += 1000),
          finishMs: 5000,
        },
      ),
    ).rejects.toThrow(/still runs check static/);
  });
});
