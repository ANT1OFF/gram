import type { GramUIMessage, PrCheckRun, PrDetail, WorkerPr } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { prRefText } from "@/components/pr-marks-model";

import { detailFor, ledgerPrOf, prPeekOf, workerPeekOf } from "./peek-model";

const pr = (more: Partial<WorkerPr> = {}): WorkerPr => ({
  repo: "example/api",
  number: 212,
  state: "open",
  url: "https://github.com/example/api/pull/212",
  ...more,
});

const run = (name: string, status: PrCheckRun["status"]): PrCheckRun => ({
  name,
  status,
  link: "",
  startedAt: "2026-10-16T09:00:00Z",
  completedAt: "2026-10-16T09:03:10Z",
});

const detail = (more: Partial<PrDetail> = {}): PrDetail => ({
  number: 212,
  state: "OPEN",
  url: "https://github.com/example/api/pull/212",
  title: "Mail trigger endpoint",
  body: "",
  isDraft: false,
  author: "dev",
  baseRefName: "main",
  headRefName: "feat/mail-trigger",
  additions: 412,
  deletions: 38,
  changedFiles: 9,
  commits: 3,
  reviewDecision: "REVIEW_REQUIRED",
  checks: "passing",
  checksPassed: 5,
  checksTotal: 5,
  checkRuns: [
    run("lint", "passing"),
    run("test (ubuntu)", "passing"),
    run("test (macos)", "passing"),
    run("build", "passing"),
    run("types", "passing"),
  ],
  commitList: [],
  conversation: [],
  files: [],
  ...more,
});

const text = (role: "user" | "assistant", words: string): GramUIMessage =>
  ({ id: words, role, parts: [{ type: "text", text: words }] }) as GramUIMessage;

const tool = (name: string, input: unknown, running = false): GramUIMessage =>
  ({
    id: `${name}-${JSON.stringify(input)}`,
    role: "assistant",
    parts: [
      {
        type: `tool-${name}`,
        toolCallId: name,
        state: running ? "input-available" : "output-available",
        input,
        ...(running ? {} : { output: "" }),
      },
    ],
  }) as GramUIMessage;

const edit = (path: string) =>
  tool("Edit", { file_path: path, old_string: "a", new_string: "b\nc" });

describe("the PR peek", () => {
  it("names a PR by its repo's short name and finds it among the worker's", () => {
    expect(prRefText({ repo: "example/web", number: 88 }, { compact: true })).toBe("web#88");
    const other = pr({ repo: "example/web", number: 88 });
    const entry = { pr: pr(), alsoIn: [{ pr: other }] } as never;
    expect(ledgerPrOf(entry, { repo: "Example/Web", number: 88 })).toBe(other);
    expect(ledgerPrOf(entry, { repo: "example/web", number: 89 })).toBeUndefined();
    expect(ledgerPrOf(undefined, { repo: "example/api", number: 212 })).toBeUndefined();
  });

  it("takes the thread's detail only for the PR asked about", () => {
    const own = detail();
    expect(detailFor(own, { repo: "example/api", number: 212 })).toBe(own);
    expect(detailFor(own, { repo: "example/web", number: 212 })).toBeUndefined();
    expect(detailFor(own, { repo: "example/api", number: 213 })).toBeUndefined();
  });

  it("says only what the ledger knows when there is no detail", () => {
    const peek = prPeekOf(
      pr({
        checks: "passing",
        reviewDecision: "REVIEW_REQUIRED",
        mergeState: "BLOCKED",
        dependsOn: [
          { repo: "example/web", number: 88, state: "open", setBy: "orchestrator" },
          { repo: "example/api", number: 209, state: "merged", setBy: "orchestrator" },
        ],
      }),
      undefined,
    );
    expect(peek.checks).toEqual({ text: "Passing", tone: "success" });
    expect(peek.review).toBe("Waiting on an approving review");
    expect(peek.waitsOn).toBe("web#88");
    expect(peek.change).toBeUndefined();
    expect(peek.title).toBeUndefined();
    expect(peek.runs).toEqual([]);
    // Its dependency line already says what the merge waits on.
    expect(peek.note).toBeUndefined();
    expect(peek.url).toBe("https://github.com/example/api/pull/212");
  });

  it("counts checks, names the change and the first checks from the detail, failing first", () => {
    const failing = detail({
      checksPassed: 4,
      checkRuns: [...detail().checkRuns.slice(0, 4), run("e2e", "failing")],
    });
    const peek = prPeekOf(pr(), failing);
    expect(peek.title).toBe("Mail trigger endpoint");
    expect(peek.checks).toEqual({ text: "1 of 5 failing", tone: "danger" });
    expect(peek.change).toEqual({ additions: 412, deletions: 38, files: 9 });
    expect(peek.runs.map((each) => each.name)).toEqual(["e2e", "lint", "test (ubuntu)"]);
    expect(peek.moreRuns).toBe(2);
    expect(prPeekOf(pr(), detail()).checks).toEqual({ text: "5 of 5 passed", tone: "success" });
  });

  it("names who a review is asked of, and who asked for changes, in the review mark's words", () => {
    const asked = pr({
      reviewDecision: "REVIEW_REQUIRED",
      reviewRequests: [{ kind: "user", name: "ana" }],
    });
    expect(prPeekOf(asked, undefined).review).toBe("Waiting on ana");
    const changes = pr({ reviewDecision: "CHANGES_REQUESTED", changesRequestedBy: ["bo"] });
    expect(prPeekOf(changes, undefined).review).toBe("Changes requested by bo");
    expect(prPeekOf(pr({ reviewDecision: "APPROVED" }), undefined).review).toBe("Approved");
    expect(prPeekOf(pr(), undefined).review).toBeUndefined();
  });

  it("says what an open merge waits on, and nothing once merged", () => {
    const blocked = pr({ checks: "failing" });
    expect(prPeekOf(blocked, undefined).note).toMatch(/failed checks on #212/);
    const merged = prPeekOf(pr({ state: "merged", checks: "failing" }), undefined);
    expect(merged.state).toBe("merged");
    expect(merged.note).toBeUndefined();
  });

  it("reads its state as the PR vocabulary does, a draft and its wait included", () => {
    const draft = prPeekOf(pr({ mergeState: "DRAFT" }), detail({ isDraft: true }));
    expect(draft.state).toBe("draft");
    expect(draft.note).toMatch(/still a draft/);
    expect(prPeekOf(pr(), detail({ state: "CLOSED", isDraft: true })).state).toBe("closed");
  });
});

describe("the worker peek", () => {
  const messages = [
    text("user", "Retry on 5xx with backoff; dead-letter after 5 tries."),
    text("assistant", "Reading the consumer."),
    edit("queue/consumer.py"),
    edit("queue/consumer.py"),
    edit("queue/backoff.py"),
    edit("tests/queue/test_retry.py"),
    edit("README.md"),
    tool("Bash", { command: "ruff check" }),
    tool("Bash", { command: "uv run pytest tests/queue" }, true),
  ];

  it("shows its brief, the files its edits changed, its last command and its report", () => {
    const peek = workerPeekOf(messages, false, {
      changedFiles: 4,
      lastReport: { summary: "Backoff is in." } as never,
    });
    expect(peek.brief).toBe("Retry on 5xx with backoff; dead-letter after 5 tries.");
    expect(peek.files.map((file) => file.path)).toEqual([
      "queue/consumer.py",
      "queue/backoff.py",
      "tests/queue/test_retry.py",
    ]);
    expect(peek.files[0]).toMatchObject({ additions: 4, deletions: 2 });
    expect(peek.moreFiles).toBe(1);
    expect(peek.changedFiles).toBeUndefined();
    expect(peek.command).toEqual({ command: "uv run pytest tests/queue", running: true });
    expect(peek.report).toBe("Backoff is in.");
  });

  it("leaves out the brief and the file list when older history isn't loaded", () => {
    const peek = workerPeekOf(messages.slice(1), true, { changedFiles: 4 });
    expect(peek.brief).toBeUndefined();
    expect(peek.files).toEqual([]);
    expect(peek.changedFiles).toBe(4);
    expect(workerPeekOf([], true, { changedFiles: 0 }).changedFiles).toBeUndefined();
  });

  it("is empty where nothing is known", () => {
    expect(workerPeekOf([], false, undefined)).toEqual({
      brief: undefined,
      files: [],
      moreFiles: 0,
      changedFiles: undefined,
      command: undefined,
      report: undefined,
    });
  });
});
