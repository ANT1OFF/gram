// @vitest-environment happy-dom
import type { CiJobDiagnostic, ThreadId } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CiCheckDetail } from "./ci-check-detail";
import { renderWithApi } from "./test-utils";

const head = "a".repeat(40);
const T = "synthetic" as ThreadId;
const props = {
  threadId: T,
  prUrl: "https://github.com/example/app/pull/7",
  prNumber: 7,
  headOid: head,
  check: {
    name: "check",
    status: "failing" as const,
    link: "https://github.com/example/app/actions/runs/12/job/34",
  },
};
const diagnostic: CiJobDiagnostic = {
  repo: "example/app",
  number: 7,
  headOid: head,
  runId: "12",
  jobId: "34",
  attempt: 2,
  name: "check",
  link: props.check.link,
  status: "completed",
  conclusion: "failure",
  runner: "synthetic-runner",
  failingStep: "Run tests",
  startedAt: "2026-10-10T18:01:00Z",
  explanation: "Evidence reports a test/assertion failure. Its cause is not established.",
  evidence: [{ source: "annotation", text: "AssertionError: expected 2, received 3" }],
};
afterEach(cleanup);

describe("CI job detail", () => {
  it("fetches only on expansion, exposes exact provenance and opens the existing job", async () => {
    const prCheckDiagnostic = vi.fn(async () => diagnostic);
    const openExternal = vi.fn(async () => {});
    renderWithApi(<CiCheckDetail {...props} />, { prCheckDiagnostic, openExternal });
    expect(prCheckDiagnostic).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Inspect check job" }));
    expect(await screen.findByText(diagnostic.explanation)).toBeTruthy();
    expect(screen.getByText(`Head ${head} · Run 12 · Attempt 2 · Job 34`)).toBeTruthy();
    expect(screen.getByText("Step: Run tests")).toBeTruthy();
    expect(screen.getByText(/Runner synthetic-runner/)).toBeTruthy();
    const timestamp = screen.getByText("Started").querySelector("time")!;
    expect(timestamp.textContent).toMatch(/\d{2}:01:00/);
    expect(timestamp.textContent).not.toMatch(/AM|PM/);
    fireEvent.click(screen.getByRole("link", { name: "Inspect check on GitHub" }));
    expect(openExternal).toHaveBeenCalledWith(props.check.link);
    fireEvent.click(screen.getByRole("button", { name: "Read redacted log excerpt" }));
    await waitFor(() => expect(prCheckDiagnostic).toHaveBeenCalledTimes(2));
    expect(prCheckDiagnostic.mock.calls[1]).toEqual([
      T,
      {
        repo: "example/app",
        number: 7,
        headOid: head,
        runId: "12",
        jobId: "34",
        attempt: 2,
        includeLog: true,
      },
    ]);
  });

  for (const [status, conclusion, explanation] of [
    ["completed", "cancelled", "GitHub records cancellation; reason unknown."],
    ["queued", undefined, "GitHub records this job as waiting to start."],
    ["in_progress", undefined, "GitHub records this job as in progress."],
  ] as const)
    it(`renders ${conclusion ?? status} separately and missing runner honestly`, async () => {
      renderWithApi(<CiCheckDetail {...props} />, {
        prCheckDiagnostic: async () => ({
          ...(Object.fromEntries(
            Object.entries(diagnostic).filter(([key]) => !["runner", "conclusion"].includes(key)),
          ) as CiJobDiagnostic),
          status,
          ...(conclusion === undefined ? {} : { conclusion }),
          explanation,
          evidence: [],
        }),
      });
      fireEvent.click(screen.getByRole("button", { name: "Inspect check job" }));
      expect(await screen.findByText(explanation)).toBeTruthy();
      expect(screen.getByText(/Runner not exposed/)).toBeTruthy();
      if (status !== "completed")
        expect(screen.queryByRole("button", { name: "Read redacted log excerpt" })).toBeNull();
    });

  it("withholds stale-head, wrong-job and wrong-attempt responses", async () => {
    for (const patch of [{ headOid: "b".repeat(40) }, { jobId: "99" }, { attempt: 3 }]) {
      const api = vi
        .fn()
        .mockResolvedValueOnce(diagnostic)
        .mockResolvedValueOnce({
          ...diagnostic,
          ...patch,
          evidence: [{ source: "log", text: "WRONG EVIDENCE" }],
        });
      renderWithApi(<CiCheckDetail {...props} />, { prCheckDiagnostic: api });
      fireEvent.click(screen.getByRole("button", { name: "Inspect check job" }));
      await screen.findByText(diagnostic.explanation);
      fireEvent.click(screen.getByRole("button", { name: "Read redacted log excerpt" }));
      expect(await screen.findByRole("alert")).toBeTruthy();
      expect(screen.queryByText("WRONG EVIDENCE")).toBeNull();
      cleanup();
    }
  });

  it("shows a bounded unavailable state without rendering error credentials or retrying", async () => {
    const api = vi.fn(async () => {
      throw new Error(
        "Connection failed postgresql://sample-user:do-not-render@db.example.test/private",
      );
    });
    renderWithApi(<CiCheckDetail {...props} />, { prCheckDiagnostic: api });
    fireEvent.click(screen.getByRole("button", { name: "Inspect check job" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(document.body.textContent).not.toContain("do-not-render");
    expect(document.body.textContent).not.toContain("sample-user");
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("does not offer inspection for untrusted providers or an unpinned head", () => {
    const api = vi.fn();
    renderWithApi(<CiCheckDetail {...props} headOid={undefined} />, { prCheckDiagnostic: api });
    renderWithApi(
      <CiCheckDetail
        {...props}
        check={{ ...props.check, link: "https://evil.test/actions/runs/12/job/34" }}
      />,
      { prCheckDiagnostic: api },
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(api).not.toHaveBeenCalled();
  });
});
