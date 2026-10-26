import { describe, expect, it } from "@effect/vitest";
import { actionsJobSelection, type CiDiagnosticSelection } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { ciLogEvidence, explainCiJob, readCiDiagnostic, sanitizeCiText } from "./ci-diagnostics.ts";
import { Proc, type ProcOutput, type RunOptions } from "./proc.ts";

const head = "a".repeat(40);
const selection: CiDiagnosticSelection = {
  repo: "example/app",
  number: 7,
  headOid: head,
  runId: "12",
  jobId: "34",
};
const link = "https://github.com/example/app/actions/runs/12/job/34";
const run = { id: 12, head_sha: head, run_attempt: 2 };
const job = {
  id: 34,
  run_id: 12,
  head_sha: head,
  name: "check",
  status: "completed",
  conclusion: "failure",
  runner_name: "runner-1",
  steps: [{ name: "Run tests", conclusion: "failure" }],
  check_run_url: "https://api.github.com/repos/example/app/check-runs/56",
};
const view = { headRefOid: head, statusCheckRollup: [{ detailsUrl: link }] };
const ok = (v: unknown): ProcOutput => ({
  status: 0,
  stdout: JSON.stringify(v),
  stderr: "",
  truncated: false,
});

/** A wholly synthetic authenticated-gh surface; any unexpected command is a test failure. */
export function diagnosticGh(
  options: { answer?: (path: string, visit: number) => ProcOutput | undefined } = {},
) {
  const calls: { args: readonly string[]; options: RunOptions }[] = [];
  const visits = new Map<string, number>();
  const proc = {
    run: (bin: string, args: readonly string[], runOptions: RunOptions) =>
      Effect.sync(() => {
        expect(bin).toBe("gh");
        calls.push({ args, options: runOptions });
        const path = args[0] === "pr" ? "pr" : args[1]!;
        const visit = (visits.get(path) ?? 0) + 1;
        visits.set(path, visit);
        const override = options.answer?.(path, visit);
        if (override) return override;
        if (path === "pr") return ok(view);
        if (path === "repos/example/app/actions/runs/12") return ok(run);
        if (path === "repos/example/app/actions/runs/12/attempts/2/jobs?per_page=100")
          return ok({ total_count: 1, jobs: [job] });
        if (path === "repos/example/app/check-runs/56")
          return ok({ id: 56, head_sha: head, details_url: link });
        if (path === "repos/example/app/check-runs/56/annotations?per_page=10")
          return ok([
            {
              annotation_level: "failure",
              message:
                "AssertionError: test failed\ntoken=" +
                ["ghp", "invented_secret_value_123456789"].join("_"),
            },
          ]);
        if (path === "repos/example/app/actions/jobs/34/logs")
          return {
            ...ok(null),
            stdout: "env: TOKEN=abcdef\n##[error]Process completed with exit code 137.\n",
          };
        throw new Error(`Unexpected synthetic call: ${path}`);
      }),
  };
  return {
    proc,
    calls,
    read: (input = selection) =>
      readCiDiagnostic("/synthetic", "example/app", 7, input).pipe(
        Effect.provideService(Proc, proc),
      ),
  };
}

describe("CI job diagnostics", () => {
  it.effect("pins job/head/attempt and reads annotations first without logs, cache or writes", () =>
    Effect.gen(function* () {
      const gh = diagnosticGh();
      const result = yield* gh.read();
      expect(result).toMatchObject({
        headOid: head,
        runId: "12",
        jobId: "34",
        attempt: 2,
        runner: "runner-1",
        failingStep: "Run tests",
      });
      expect(result.explanation).toContain("test/assertion failure");
      expect(JSON.stringify(result)).not.toContain("ghp_invented");
      expect(gh.calls.some((c) => c.args.some((a) => a.endsWith("/logs")))).toBe(false);
      yield* gh.read();
      expect(gh.calls.filter((c) => c.args[0] === "pr")).toHaveLength(4);
      expect(
        gh.calls.every(
          (c) => c.args[0] === "pr" || (c.args[0] === "api" && !c.args.includes("--method")),
        ),
      ).toBe(true);
    }),
  );

  it.effect("fetches only a selected job's bounded log on explicit attempt-pinned request", () =>
    Effect.gen(function* () {
      const gh = diagnosticGh();
      const result = yield* gh.read({ ...selection, includeLog: true, attempt: 2 });
      expect(result.explanation).toContain("does not establish out-of-memory");
      expect(result.evidence.filter((e) => e.source === "log")).toEqual([
        { source: "log", text: "##[error]Process completed with exit code 137." },
      ]);
      const logs = gh.calls.filter((c) => c.args[1]?.endsWith("/logs"));
      expect(logs).toHaveLength(1);
      expect(logs[0]!.options).toMatchObject({ maxOutputBytes: 128 * 1024, timeoutMs: 10000 });
    }),
  );

  for (const [label, path, body] of [
    ["wrong PR head", "pr", { ...view, headRefOid: "b".repeat(40) }],
    [
      "foreign job link",
      "pr",
      { ...view, statusCheckRollup: [{ detailsUrl: link.replace("example/app", "other/app") }] },
    ],
    ["wrong run head", "repos/example/app/actions/runs/12", { ...run, head_sha: "b".repeat(40) }],
    [
      "previous attempt job",
      "repos/example/app/actions/runs/12/attempts/2/jobs?per_page=100",
      { total_count: 1, jobs: [{ ...job, id: 99 }] },
    ],
    [
      "wrong job head",
      "repos/example/app/actions/runs/12/attempts/2/jobs?per_page=100",
      { total_count: 1, jobs: [{ ...job, head_sha: "b".repeat(40) }] },
    ],
    [
      "truncated job list",
      "repos/example/app/actions/runs/12/attempts/2/jobs?per_page=100",
      { total_count: 101, jobs: [job] },
    ],
  ] as const)
    it.effect(`refuses ${label} before fetching a log`, () =>
      Effect.gen(function* () {
        const gh = diagnosticGh({ answer: (p) => (p === path ? ok(body) : undefined) });
        const result = yield* Effect.result(
          gh.read({ ...selection, attempt: 2, includeLog: true }),
        );
        expect(result._tag).toBe("Failure");
        expect(gh.calls.some((c) => c.args[1]?.endsWith("/logs"))).toBe(false);
      }),
    );

  it.effect("rejects rerun and head drift during evidence collection", () =>
    Effect.gen(function* () {
      for (const drift of ["attempt", "head"]) {
        const gh = diagnosticGh({
          answer: (p, visit) =>
            visit === 2
              ? p === "pr" && drift === "head"
                ? ok({ ...view, headRefOid: "b".repeat(40) })
                : p.endsWith("runs/12") && drift === "attempt"
                  ? ok({ ...run, run_attempt: 3 })
                  : undefined
              : undefined,
        });
        expect(
          (yield* Effect.result(gh.read({ ...selection, attempt: 2, includeLog: true })))._tag,
        ).toBe("Failure");
      }
    }),
  );

  it.effect("does not expose provider stderr, authentication credentials or expired logs", () =>
    Effect.gen(function* () {
      const gh = diagnosticGh({
        answer: (p) =>
          p.endsWith("/logs")
            ? {
                status: 1,
                stdout: "",
                stderr:
                  "Authorization: Bearer invented-secret\npostgresql://sample-user:invented-url-password@db.example.test/private",
                truncated: false,
              }
            : undefined,
      });
      const result = yield* gh.read({ ...selection, attempt: 2, includeLog: true });
      expect(result.note).toContain("expired");
      expect(JSON.stringify(result)).not.toContain("invented-secret");
      expect(JSON.stringify(result)).not.toContain("invented-url-password");
      expect(JSON.stringify(result)).not.toContain("sample-user");
      const unavailable = diagnosticGh({
        answer: () => ({
          status: 1,
          stdout: "",
          stderr:
            "token=invented-secret\npostgresql://sample-user:invented-url-password@db.example.test/private",
          truncated: false,
        }),
      });
      const error = yield* unavailable.read().pipe(Effect.flip);
      expect(error.message).not.toContain("invented-secret");
      expect(error.message).not.toContain("invented-url-password");
      expect(error.message).not.toContain("sample-user");
    }),
  );

  it.effect("refuses mismatched annotations without returning their evidence", () =>
    Effect.gen(function* () {
      const gh = diagnosticGh({
        answer: (p) =>
          p.endsWith("check-runs/56")
            ? ok({ id: 56, head_sha: "b".repeat(40), details_url: link })
            : undefined,
      });
      expect((yield* gh.read()).evidence).toEqual([]);
      expect(gh.calls.some((c) => c.args[1]?.includes("/annotations"))).toBe(false);
    }),
  );

  it.effect("reports cancellation and waiting separately without invented causes", () =>
    Effect.gen(function* () {
      for (const [status, conclusion, explanation] of [
        ["completed", "cancelled", "cancelled"],
        ["queued", "", "waiting to start"],
        ["in_progress", "", "in progress"],
      ]) {
        const gh = diagnosticGh({
          answer: (p) =>
            p.includes("/jobs?")
              ? ok({ total_count: 1, jobs: [{ ...job, status, conclusion, runner_name: "" }] })
              : undefined,
        });
        const result = yield* gh.read();
        expect(result.explanation).toContain(explanation);
        expect(result.runner).toBeUndefined();
      }
    }),
  );
});

describe("evidence sanitation and explanation", () => {
  it("redacts multiline private keys, controls, headers, assignments, token shapes and URL userinfo/query", () => {
    const text = sanitizeCiText(
      ["-----BEGIN", "PRIVATE KEY-----"].join(" ") +
        "\nabc\n-----END PRIVATE KEY-----\n\x1b[31mTOKEN=opaque value\nAuthorization: Bearer my-auth-value\nCookie: session=opaque\nhttps://user:pass@example.test/error?credential=private#secret\n" +
        ["ghp", "abcdefghijklmnopqrstuvwxyz1234"].join("_") +
        "\n" +
        "X".repeat(60),
      5000,
    );
    for (const secret of [
      "abc",
      "opaque",
      "my-auth-value",
      "session=",
      "user:pass",
      "credential=private",
      "#secret",
      "ghp_",
      "X".repeat(60),
    ])
      expect(text).not.toContain(secret);
    expect(text).toContain("[redacted");
    expect(sanitizeCiText("abc ".repeat(1000))).toHaveLength(600);
  });
  it("drops the incomplete transport-capped line before redaction and reports only complete evidence", () => {
    expect(ciLogEvidence("##[error]Tests failed\n##[error]ghp_short", true)).toEqual([
      "##[error]Tests failed",
    ]);
    expect(ciLogEvidence("##[error]ghp_short", true)).toEqual([]);
  });
  it("drops timestamped command/env groups even when they contain error words", () => {
    const logs = [
      "2026-10-10T18:00:00.000Z ##[group]Run echo error",
      "2026-10-10T18:00:00.001Z error private-value",
      "2026-10-10T18:00:00.002Z ##[endgroup]",
      "2026-10-10T18:00:00.003Z ##[command]echo error private-value",
      "2026-10-10T18:00:00.004Z ##[error]Tests failed",
    ].join("\n");
    expect(ciLogEvidence(logs)).toEqual(["##[error]Tests failed"]);
  });
  it("keeps command groups excluded when ambiguous URL redaction spans neighbouring text", () => {
    const logs = [
      "##[error]Connection failed postgresql://db.example.test",
      "##[group]Run tests",
      "error hidden@invented.test",
      "error do-not-display",
      "##[endgroup]",
      "##[error]Tests failed",
    ].join("\n");
    expect(ciLogEvidence(logs)).toEqual([
      "##[error]Connection failed [redacted URL]",
      "##[error]Tests failed",
    ]);
  });
  it("omits ambiguous URL line tails while retaining subsequent bounded diagnostic lines", () => {
    for (const userinfo of [
      "invented / tail-value",
      "invented?tail-value",
      "invented#tail-value",
    ]) {
      const first = `##[error]Connection failed postgresql://sample-user:${userinfo}@db.example.test/private adjacent text`;
      expect(ciLogEvidence(first + "\n##[error]Tests failed")).toEqual([
        "##[error]Connection failed [redacted URL]",
        "##[error]Tests failed",
      ]);
    }
    const raw = `##[error]Connection failed postgresql://sample-user:invented ${"x ".repeat(1000)}tail-value@db.example.test/private`;
    expect(sanitizeCiText(raw)).toBe("##[error]Connection failed [redacted URL]");
    expect(ciLogEvidence(raw.repeat(30))).toEqual(["##[error]Connection failed [redacted URL]"]);
  });
  it("bounds diagnostic lines and never returns neighbouring environment dumps", () => {
    const evidence = ciLogEvidence(
      "env: SECRET=private\n" +
        Array.from({ length: 30 }, (_, i) => `##[error] test failed ${i} ${"a ".repeat(400)}`).join(
          "\n",
        ),
    );
    expect(evidence).toHaveLength(8);
    expect(evidence.every((s) => s.length <= 350)).toBe(true);
    expect(evidence.join("\n")).not.toContain("private");
  });
  it("does not label all timeouts environmental and distinguishes setup/auth/billing/test evidence", () => {
    expect(explainCiJob("completed", "failure", ["test timed out"])).toContain(
      "cause is not established",
    );
    expect(explainCiJob("completed", "failure", ["Authentication failed"])).toContain(
      "authentication",
    );
    expect(explainCiJob("completed", "failure", ["billing spending limit"])).toContain("billing");
    expect(explainCiJob("completed", "startup_failure", [])).toContain("startup");
    expect(explainCiJob("completed", "failure", [], "Set up job")).toContain("setup cause");
    expect(explainCiJob("completed", "cancelled", ["SIGKILL"])).toContain("cancelled");
  });
  it("only selects exact, safe repository job links", () => {
    expect(actionsJobSelection(link, "example/app")).toEqual({ runId: "12", jobId: "34" });
    for (const unsafe of [
      link + "?token=x",
      link + "#x",
      link.replace("github.com", "github.com.evil"),
      link.replace("https://", "https://user:password@"),
      link.replace("example/app", "other/app"),
    ])
      expect(actionsJobSelection(unsafe, "example/app")).toBeUndefined();
  });
});

it.effect("redacts recognizable URL credentials in returned annotations and explicit logs", () =>
  Effect.gen(function* () {
    for (const url of [
      "postgresql://sample-user:invented-short-value@db.example.test/private",
      "postgres://sample-user:invented-short-value@db.example.test/private",
      "postgres://sample-user:invented'quote-value@db.example.test/private",
      "redis://sample-user:invented-short-value@db.example.test/private",
      "ftp://sample-user:invented-short-value@db.example.test/private",
      "ssh://sample-user:invented-short-value@db.example.test/private",
      "mongodb+srv://sample-user:invented-short-value@db.example.test/private",
      "jdbc:postgresql://sample-user:invented-short-value@db.example.test/private",
      "//sample-user:invented-short-value@db.example.test/private",
      "postgresql://sample%2Duser:invented%2Dshort%2Dvalue@db.example.test/private?access=private-query#private-fragment",
    ]) {
      const raw = `##[error]Connection failed ${url}`;
      const gh = diagnosticGh({
        answer: (path) =>
          path.includes("/annotations?")
            ? ok([{ annotation_level: "failure", message: raw }])
            : path.endsWith("/logs")
              ? { ...ok(null), stdout: raw }
              : undefined,
      });
      const annotations = yield* gh.read();
      expect(annotations.evidence).toHaveLength(1);
      expect(annotations.evidence[0]!.source).toBe("annotation");
      expect(gh.calls.some((c) => c.args[1]?.endsWith("/logs"))).toBe(false);
      const logs = yield* gh.read({ ...selection, attempt: 2, includeLog: true });
      expect(logs.evidence.some((e) => e.source === "log")).toBe(true);
      for (const text of [
        sanitizeCiText(raw),
        ciLogEvidence(raw).join("\n"),
        JSON.stringify(annotations),
        JSON.stringify(logs),
      ]) {
        for (const secret of [
          "sample-user",
          "invented-short-value",
          "invented'quote-value",
          "quote-value",
          "sample%2Duser",
          "invented%2Dshort%2Dvalue",
          "private-query",
          "private-fragment",
        ])
          expect(text).not.toContain(secret);
        expect(text).toContain("[redacted URL]");
      }
    }
  }),
);

for (const angle of ["<", ">"])
  for (const includeLog of [false, true])
    it.effect(
      `redacts raw ${angle} in URL userinfo from ${includeLog ? "explicit logs" : "annotations"}`,
      () =>
        Effect.gen(function* () {
          for (const prefix of ["postgresql:", "ssh:", ""]) {
            const url = `${prefix}//sample-user:invented${angle}tail-value@db.example.test/private`;
            const raw = `##[error]Connection failed ${url}`;
            const gh = diagnosticGh({
              answer: (path) =>
                path.includes("/annotations?")
                  ? ok([{ annotation_level: "failure", message: raw }])
                  : path.endsWith("/logs")
                    ? { ...ok(null), stdout: raw }
                    : undefined,
            });
            const result = yield* gh.read({
              ...selection,
              ...(includeLog ? { attempt: 2, includeLog: true } : {}),
            });
            const source = includeLog ? "log" : "annotation";
            expect(result.evidence.filter((e) => e.source === source)).toEqual([
              { source, text: "##[error]Connection failed [redacted URL]" },
            ]);
            expect(gh.calls.filter((c) => c.args[1]?.endsWith("/logs"))).toHaveLength(
              includeLog ? 1 : 0,
            );
            for (const text of [
              sanitizeCiText(raw),
              ciLogEvidence(raw).join("\n"),
              JSON.stringify(result),
            ]) {
              expect(text).not.toContain("sample-user");
              expect(text).not.toContain("tail-value");
              expect(text).not.toContain("db.example.test");
              expect(text).toContain("[redacted URL]");
            }
          }
        }),
    );

for (const [label, boundary] of [
  ["space", " "],
  ["tab", "\t"],
  ["newline", "\n"],
  ["carriage return/newline", "\r\n"],
  ["nonbreaking space", "\u00a0"],
  ["line separator", "\u2028"],
  ["mixed whitespace/angles/quotes", " < ' \" > "],
  ["repeated authority at-sign", "@"],
  ["encoded space", "%20"],
  ["encoded tab", "%09"],
] as const)
  for (const includeLog of [false, true])
    it.effect(
      `redacts complete ${label} URL userinfo in ${includeLog ? "explicit logs" : "annotations"}`,
      () =>
        Effect.gen(function* () {
          for (const prefix of ["postgresql:", "ssh:", ""]) {
            const url = `${prefix}//sample-user:invented${boundary}tail-value@db.example.test/private`;
            if (prefix !== "") expect(new URL(url).password).toContain("tail-value");
            const raw = `##[error]Connection failed ${url} adjacent diagnostic text`;
            const gh = diagnosticGh({
              answer: (path) =>
                path.includes("/annotations?")
                  ? ok([{ annotation_level: "failure", message: raw }])
                  : path.endsWith("/logs")
                    ? { ...ok(null), stdout: raw }
                    : undefined,
            });
            const result = yield* gh.read({
              ...selection,
              ...(includeLog ? { attempt: 2, includeLog: true } : {}),
            });
            const source = includeLog ? "log" : "annotation";
            expect(result.evidence.filter((e) => e.source === source)).toEqual([
              { source, text: "##[error]Connection failed [redacted URL]" },
            ]);
            expect(gh.calls.filter((c) => c.args[1]?.endsWith("/logs"))).toHaveLength(
              includeLog ? 1 : 0,
            );
            for (const text of [
              sanitizeCiText(raw),
              ciLogEvidence(raw).join("\n"),
              JSON.stringify(result),
            ]) {
              expect(text).not.toContain("sample-user");
              expect(text).not.toContain("tail-value");
              expect(text).not.toContain("db.example.test");
              expect(text).not.toContain("adjacent diagnostic text");
              expect(text).toContain("[redacted URL]");
            }
          }
        }),
    );

for (const includeLog of [false, true])
  it.effect(
    `redacts multiline URL userinfo before secret fields in ${includeLog ? "explicit logs" : "annotations"}`,
    () =>
      Effect.gen(function* () {
        for (const raw of [
          "##[error]credential=postgresql://sample-user:invented\n tail-value@db.example.test/private",
          "##[error]token+postgresql://sample-user:invented\n tail-value@db.example.test/private",
        ]) {
          const gh = diagnosticGh({
            answer: (path) =>
              path.includes("/annotations?")
                ? ok([{ annotation_level: "failure", message: raw }])
                : path.endsWith("/logs")
                  ? { ...ok(null), stdout: raw }
                  : undefined,
          });
          const result = yield* gh.read({
            ...selection,
            ...(includeLog ? { attempt: 2, includeLog: true } : {}),
          });
          expect(
            result.evidence.some((e) => e.source === (includeLog ? "log" : "annotation")),
          ).toBe(true);
          for (const text of [
            sanitizeCiText(raw),
            ciLogEvidence(raw).join("\n"),
            JSON.stringify(result),
          ]) {
            expect(text).not.toContain("sample-user");
            expect(text).not.toContain("tail-value");
            expect(text).not.toContain("db.example.test");
            expect(text).toContain("[redacted");
          }
        }
      }),
  );
