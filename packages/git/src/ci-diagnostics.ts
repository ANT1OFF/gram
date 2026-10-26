// Read-only, on-demand Actions evidence. Deliberately independent of badge/check caches and merge CI.
import {
  actionsJobSelection,
  GitError,
  redactText,
  type CiDiagnosticSelection,
  type CiJobDiagnostic,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { gh, ghApi } from "./exec.ts";

const object = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const string = (v: unknown): string => (typeof v === "string" ? v : "");
const id = (v: unknown): string =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? String(v) : "";
const fail = (message: string) => new GitError({ message });

/** Scrub before truncation, including multiline keys, arbitrary secret assignments and URL credentials. */
export function sanitizeCiText(value: string, limit = 600): string {
  return redactText(
    value
      // Terminal control patterns are intentional: scrub evidence before display.
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(
        // eslint-disable-next-line no-control-regex
        /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g,
        "",
      )
      .replace(
        /-----BEGIN[^\n]*PRIVATE KEY-----[\s\S]*?(?:-----END[^\n]*PRIVATE KEY-----|$)/gi,
        "[redacted private key]",
      )
      // Userinfo ends at the last @ in the authority, not at presentation whitespace/punctuation.
      // Scrub it first, including line breaks; /, ? and # are URL authority boundaries.
      // Run before field redaction can erase a URL prefix while leaving multiline userinfo behind.
      .replace(/(?:\b[a-z][a-z\d+.-]*:)?\/\/[^/?#]*@/gi, "//[redacted userinfo]@")
      // Without a trustworthy token end, conservatively omit the remainder of the URL-bearing line.
      // This also suppresses malformed same-line URLs and adjacent text rather than guessing.
      .replace(/(?:\b[a-z][a-z\d+.-]*:)?\/\/[^\r\n]*/gi, "[redacted URL]")
      .replace(
        /(?:authorization|cookie|set-cookie|credential|password|passphrase|secret|token|api[-_]?key)[^\n]*[:=][^\n]*/gi,
        "[redacted secret field]",
      )
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted JWT]")
      .replace(/\b[A-Za-z0-9_+/=-]{40,}\b/g, "[redacted value]"),
  ).slice(0, limit);
}

/** Only diagnostic lines, never command/env dumps or neighbouring context. */
export function ciLogEvidence(raw: string, truncated = false): string[] {
  // A transport cap can bisect a credential; never show that final incomplete line.
  if (truncated) raw = raw.slice(0, Math.max(0, raw.lastIndexOf("\n")));
  const clean = sanitizeCiText(raw, 128 * 1024);
  let groupDepth = 0;
  const lines: string[] = [];
  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+/, "");
    if (line.includes("##[group]")) {
      groupDepth++;
      continue;
    }
    if (line.includes("##[endgroup]")) {
      groupDepth = Math.max(0, groupDepth - 1);
      continue;
    }
    if (groupDepth > 0 || /(?:##\[command\]|^\s*(?:Run |\$ |env:|shell:))/i.test(line)) continue;
    if (
      /(?:##\[error\]|\b(?:error|failed|failure|SIGKILL|OOM|out of memory|timed? ?out|cancelled|exit code|billing|payment)\b)/i.test(
        line,
      )
    )
      lines.push(line.slice(0, 350));
  }
  return lines.slice(-8);
}

export function explainCiJob(
  status: string,
  conclusion: string,
  evidence: readonly string[],
  failingStep?: string,
): string {
  if (conclusion === "cancelled")
    return "GitHub records this job as cancelled; the cancellation reason is not established.";
  if (status !== "completed")
    return ["queued", "waiting", "pending"].includes(status)
      ? "GitHub records this job as waiting to start."
      : "GitHub records this job as in progress.";
  const text = evidence.join("\n");
  if (/\b(?:SIGKILL|exit code 137|exited with (?:code )?137)\b/i.test(text))
    return "Evidence reports a killed process (SIGKILL/137). This alone does not establish out-of-memory.";
  if (/\b(?:billing|payment|spending limit)\b/i.test(text))
    return "Evidence reports a billing or spending restriction; inspect the linked job for details.";
  if (/\b(?:authentication failed|bad credentials|not authenticated|unauthorized)\b/i.test(text))
    return "Evidence reports an authentication failure; inspect the linked job for details.";
  if (/\b(?:tests? failed|FAIL\s+\S|AssertionError|assertion failed)\b/i.test(text))
    return "Evidence reports a test/assertion failure. Its cause is not established.";
  if (conclusion === "timed_out" || /\b(?:timed? ?out|timeout)\b/i.test(text))
    return "GitHub or the evidence records a timeout. Its cause is not established.";
  if (["startup_failure", "action_required"].includes(conclusion))
    return "GitHub records a startup/action-required failure; inspect the linked job for the setup reason.";
  if (conclusion === "failure" && failingStep === "Set up job")
    return "GitHub records a failure in the Set up job step. The setup cause is not established.";
  if (conclusion === "failure")
    return "GitHub records a failed job. The failing step and available evidence are shown below.";
  return `GitHub records this job as ${conclusion || status}.`;
}

/** Errors deliberately contain no provider output, command, redirect location or credential. */
export const readCiDiagnostic = (
  cwd: string,
  repo: string,
  number: number,
  selection: CiDiagnosticSelection,
) =>
  Effect.gen(function* () {
    if (
      selection.repo.toLowerCase() !== repo.toLowerCase() ||
      selection.number !== number ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo) ||
      !Number.isSafeInteger(number) ||
      number <= 0 ||
      !/^[a-f0-9]{40}$/i.test(selection.headOid) ||
      !/^\d{1,20}$/.test(selection.runId) ||
      !/^\d{1,20}$/.test(selection.jobId) ||
      (selection.attempt !== undefined &&
        (!Number.isSafeInteger(selection.attempt) || selection.attempt < 1)) ||
      (selection.includeLog === true && selection.attempt === undefined)
    )
      return yield* fail("Invalid CI diagnostic selection");
    const api = (path: string) =>
      ghApi(cwd, [path, "--hostname", "github.com"], { maxOutputBytes: 256 * 1024 }).pipe(
        Effect.mapError(() =>
          fail("GitHub CI metadata unavailable. Check gh authentication and repository access."),
        ),
        Effect.flatMap((out) => {
          if (out.status !== 0 || out.truncated)
            return Effect.fail(
              fail("GitHub CI metadata unavailable or exceeds the bounded response."),
            );
          try {
            return Effect.succeed(JSON.parse(out.stdout) as unknown);
          } catch {
            return Effect.fail(fail("GitHub CI metadata is invalid."));
          }
        }),
      );
    const pr = () =>
      gh(
        cwd,
        [
          "pr",
          "view",
          String(number),
          "--repo",
          `https://github.com/${repo}`,
          "--json",
          "headRefOid,statusCheckRollup",
        ],
        { maxOutputBytes: 256 * 1024 },
      ).pipe(
        Effect.mapError(() =>
          fail("GitHub PR metadata unavailable. Check gh authentication and repository access."),
        ),
        Effect.flatMap((out) => {
          try {
            if (out.status !== 0 || out.truncated)
              return Effect.fail(
                fail("GitHub PR metadata unavailable or exceeds the bounded response."),
              );
            const view = object(JSON.parse(out.stdout));
            if (view["headRefOid"] !== selection.headOid)
              return Effect.fail(
                fail("PR head changed. Refresh the pull request before inspecting CI."),
              );
            const checks = view["statusCheckRollup"];
            const found =
              Array.isArray(checks) &&
              checks.some((check) => {
                const job = actionsJobSelection(string(object(check)["detailsUrl"]), repo);
                return job?.runId === selection.runId && job.jobId === selection.jobId;
              });
            return found
              ? Effect.succeed(view)
              : Effect.fail(
                  fail(
                    "Selected job is no longer a check on this PR head. Refresh the pull request.",
                  ),
                );
          } catch {
            return Effect.fail(fail("GitHub PR metadata is invalid."));
          }
        }),
      );
    yield* pr();
    const runPath = `repos/${repo}/actions/runs/${selection.runId}`;
    const run = object(yield* api(runPath));
    const attempt = run["run_attempt"];
    if (
      id(run["id"]) !== selection.runId ||
      run["head_sha"] !== selection.headOid ||
      typeof attempt !== "number" ||
      !Number.isSafeInteger(attempt) ||
      attempt < 1 ||
      (selection.attempt !== undefined && selection.attempt !== attempt)
    )
      return yield* fail("Run head or attempt changed. Refresh the pull request.");
    const jobsBody = object(yield* api(`${runPath}/attempts/${attempt}/jobs?per_page=100`));
    const jobs = jobsBody["jobs"];
    if (
      !Array.isArray(jobs) ||
      !Number.isSafeInteger(jobsBody["total_count"]) ||
      jobsBody["total_count"] !== jobs.length ||
      jobs.length > 100
    )
      return yield* fail("Job list is incomplete or exceeds the bounded response.");
    const job = object(jobs.find((v) => id(object(v)["id"]) === selection.jobId));
    if (id(job["run_id"]) !== selection.runId || job["head_sha"] !== selection.headOid)
      return yield* fail("Selected job does not match this head and run attempt.");
    const link = `https://github.com/${repo}/actions/runs/${selection.runId}/job/${selection.jobId}`;
    const status = string(job["status"]);
    const conclusion = string(job["conclusion"]);
    if (
      !["queued", "waiting", "pending", "in_progress", "completed"].includes(status) ||
      ![
        "",
        "success",
        "failure",
        "cancelled",
        "timed_out",
        "neutral",
        "skipped",
        "stale",
        "action_required",
        "startup_failure",
      ].includes(conclusion)
    )
      return yield* fail("Unknown GitHub job state");
    const evidence: { source: "annotation" | "log"; text: string }[] = [];
    let note: string | undefined;
    const checkUrl = string(job["check_run_url"]);
    const checkPrefix = `https://api.github.com/repos/${repo}/check-runs/`;
    if (
      checkUrl.toLowerCase().startsWith(checkPrefix.toLowerCase()) &&
      /^\d+$/.test(checkUrl.slice(checkPrefix.length))
    ) {
      const checkId = checkUrl.slice(checkPrefix.length);
      const annotationResult = yield* Effect.gen(function* () {
        const check = object(yield* api(`repos/${repo}/check-runs/${checkId}`));
        const checkJob = actionsJobSelection(string(check["details_url"]), repo);
        if (
          id(check["id"]) !== checkId ||
          check["head_sha"] !== selection.headOid ||
          checkJob?.jobId !== selection.jobId ||
          checkJob.runId !== selection.runId
        )
          return yield* fail("Annotation identity mismatch");
        const annotations = yield* api(
          `repos/${repo}/check-runs/${checkId}/annotations?per_page=10`,
        );
        if (!Array.isArray(annotations)) return yield* fail("Invalid annotations");
        return annotations
          .filter((v) => object(v)["annotation_level"] === "failure")
          .slice(0, 4)
          .map((v) => sanitizeCiText(string(object(v)["message"])));
      }).pipe(Effect.option);
      if (annotationResult._tag === "Some") {
        for (const text of annotationResult.value)
          if (text) evidence.push({ source: "annotation", text });
      } else note = "Annotations unavailable; open the job on GitHub for more evidence.";
    }
    if (selection.includeLog === true) {
      if (status !== "completed") note = "Logs are available here only after the job completes.";
      else {
        const out = yield* gh(
          cwd,
          ["api", `repos/${repo}/actions/jobs/${selection.jobId}/logs`, "--hostname", "github.com"],
          {
            maxOutputBytes: 128 * 1024,
            timeoutMs: 10_000,
          },
        ).pipe(Effect.option);
        if (out._tag === "Some" && out.value.status === 0) {
          for (const text of ciLogEvidence(out.value.stdout, out.value.truncated))
            evidence.push({ source: "log", text });
          note = out.value.truncated
            ? "Only the first 128 KiB was inspected; later evidence may be missing."
            : "Only selected diagnostic lines are shown; inspect the job on GitHub for full context.";
        } else
          note =
            "Log excerpt unavailable. Logs may have expired or require additional repository access.";
      }
    }
    // A rerun or force-push during evidence collection must not return stale evidence as current.
    const latest = object(yield* api(runPath));
    if (
      latest["head_sha"] !== selection.headOid ||
      latest["run_attempt"] !== attempt ||
      id(latest["id"]) !== selection.runId
    )
      return yield* fail(
        "Run head or attempt changed while reading evidence. Refresh the pull request.",
      );
    yield* pr();
    const steps = Array.isArray(job["steps"]) ? job["steps"] : [];
    const failingStep = steps
      .map(object)
      .find((step) => ["failure", "timed_out", "cancelled"].includes(string(step["conclusion"])));
    const safe = (v: unknown) => sanitizeCiText(string(v), 160);
    const runner =
      safe(job["runner_name"]) || (id(job["runner_id"]) ? `ID ${id(job["runner_id"])}` : undefined);
    const timestamp = (value: unknown) => {
      const text = string(value);
      const parsed = Date.parse(text);
      return /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(text) &&
        Number.isFinite(parsed)
        ? new Date(parsed).toISOString()
        : undefined;
    };
    const startedAt = timestamp(job["started_at"]);
    const completedAt = timestamp(job["completed_at"]);
    return {
      repo,
      number,
      headOid: selection.headOid,
      runId: selection.runId,
      jobId: selection.jobId,
      attempt,
      name: safe(job["name"]),
      link,
      status,
      ...(conclusion ? { conclusion } : {}),
      ...(runner ? { runner } : {}),
      ...(startedAt ? { startedAt } : {}),
      ...(completedAt ? { completedAt } : {}),
      ...(failingStep ? { failingStep: safe(failingStep["name"]) } : {}),
      explanation: explainCiJob(
        status,
        conclusion,
        evidence.map((e) => e.text),
        failingStep ? safe(failingStep["name"]) : undefined,
      ),
      evidence,
      ...(note ? { note } : {}),
    } satisfies CiJobDiagnostic;
  }).pipe(
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.fail(fail("CI evidence request timed out. Inspect the job on GitHub.")),
    }),
  );
