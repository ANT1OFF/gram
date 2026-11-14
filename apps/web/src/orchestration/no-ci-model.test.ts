import type { ProjectId, ThreadId, WorkerLedgerEntry, WorkerPr } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { noCiRepos, noCiText } from "./no-ci-model";

const NO_GATE = "no local check configured for runheim; local gate OFF — CI and GitHub rules apply";

const pr = (patch: Partial<WorkerPr> = {}): WorkerPr => ({
  repo: "example/runheim",
  number: 1294,
  state: "open",
  checks: "none",
  ...patch,
});

const worker = (id: string, patch: Partial<WorkerLedgerEntry> = {}): WorkerLedgerEntry => ({
  feature: "codex-login-import",
  projectId: "p-runheim" as ProjectId,
  project: "runheim",
  threadId: id as ThreadId,
  title: `Worker ${id}`,
  state: "inReview",
  status: "idle",
  pendingRequests: [],
  changedFiles: 0,
  overlapsWith: [],
  userIntervened: false,
  messagesFromOrchestrator: 0,
  localGate: NO_GATE,
  pr: pr(),
  ...patch,
});

const ledger = (...workers: WorkerLedgerEntry[]) => ({
  features: [{ feature: "codex-login-import", state: "inReview" as const, workers }],
});

describe("noCiRepos", () => {
  it("names a repo once whose PRs report no hosted checks and whose project has no local check", () => {
    const repos = noCiRepos(
      ledger(
        worker("a"),
        worker("b", { pr: pr({ number: 1299 }), morePrs: [pr({ number: 1300 })] }),
      ),
    );
    expect(repos).toEqual([{ repo: "example/runheim", project: "runheim" }]);
  });

  it("says nothing without a ledger, or for a repo with a local check", () => {
    expect(noCiRepos(undefined)).toEqual([]);
    const { localGate: _gate, ...gated } = worker("a");
    expect(noCiRepos(ledger(gated))).toEqual([]);
  });

  it.each([
    ["passing", "passing"],
    ["failing", "failing"],
    ["pending", "pending"],
    ["not looked up yet", undefined],
  ] as const)("leaves out a repo with any PR whose checks are %s", (_, checks) => {
    const { checks: _none, ...bare } = pr({ number: 1299 });
    const other = worker("b", { pr: checks === undefined ? bare : { ...bare, checks } });
    expect(noCiRepos(ledger(worker("a"), other))).toEqual([]);
  });

  it("goes by open PRs of live workers only", () => {
    // A merged PR's checks, or an archived worker's, are history.
    const merged = worker("b", { pr: pr({ number: 7, state: "merged", checks: "passing" }) });
    const archived = worker("c", { state: "archived", pr: pr({ number: 8, checks: "passing" }) });
    expect(noCiRepos(ledger(worker("a"), merged, archived))).toHaveLength(1);
    expect(noCiRepos(ledger({ ...worker("a"), state: "archived" }))).toEqual([]);
  });

  it("reads the extra repos a worker works in by their own project's gate", () => {
    const spanning = worker("a", {
      pr: pr({ repo: "example/api", checks: "passing" }),
      alsoIn: [
        {
          projectId: "p-runheim" as ProjectId,
          project: "runheim",
          changedFiles: 0,
          localGate: NO_GATE,
          pr: pr(),
        },
      ],
    });
    expect(noCiRepos(ledger(spanning))).toEqual([{ repo: "example/runheim", project: "runheim" }]);
  });
});

describe("noCiText", () => {
  it("explains calmly, naming every repo", () => {
    expect(noCiText([{ repo: "example/runheim", project: "runheim" }])).toBe(
      "No CI on example/runheim: its pull requests report no hosted checks and no local check is set, so nothing tests them before they merge.",
    );
    expect(
      noCiText([
        { repo: "a/one", project: "one" },
        { repo: "a/two", project: "two" },
        { repo: "a/three", project: "three" },
      ]),
    ).toMatch(/^No CI on a\/one, a\/two and a\/three: their pull requests/);
  });
});
