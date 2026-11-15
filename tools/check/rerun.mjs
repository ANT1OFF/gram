import { relative } from "node:path";

// A CI test shard that fails on a few files runs those files once more, alone, before it fails.
// A file that passes there is a flake: the shard passes, and each flaky test is named as a GitHub
// warning and in the job summary, so flakes are counted and fixed instead of costing a rerun of
// the whole suite. More failed files than `RERUN_LIMIT` reads as a real break and is not rerun.

/** At most this many failed files are run again; more is a break, not a flake. */
export const RERUN_LIMIT = 5;

/**
 * The files of a Vitest JSON report that failed, and their failed tests' full names, with
 * checkout-relative paths. A file that failed outside any test (an import or hook error) has none.
 */
export function failedFiles(report, root) {
  return report.testResults
    .filter((file) => file.status === "failed")
    .map((file) => ({
      path: file.name,
      file: relative(root, file.name).split("\\").join("/"),
      tests: (file.assertionResults ?? [])
        .filter((test) => test.status === "failed")
        .map((test) => test.fullName ?? test.title),
    }));
}

/** Whether a run with these failed files gets its one rerun. */
export const shouldRerun = (failed) => failed.length > 0 && failed.length <= RERUN_LIMIT;

/** Escapes a workflow command's message, and its properties further. */
const escape = (text) =>
  text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
const property = (text) => escape(text).replaceAll(":", "%3A").replaceAll(",", "%2C");

/** GitHub workflow commands naming each flaky test, and the job summary's Markdown. */
export function flakyReport(failed) {
  const lines = failed.flatMap(({ file, tests }) =>
    (tests.length === 0 ? ["(the file itself)"] : tests).map(
      (test) =>
        `::warning file=${property(file)},title=${property("Flaky test")}::` +
        escape(`${test} failed, then passed when its file ran again`),
    ),
  );
  const summary = [
    "### Flaky tests",
    "",
    "These failed in the shard and passed when their files ran again, so the shard passed. Fix them:",
    "",
    ...failed.flatMap(({ file, tests }) =>
      (tests.length === 0 ? ["(the file itself)"] : tests).map((test) => `- \`${file}\` › ${test}`),
    ),
    "",
  ].join("\n");
  return { lines, summary };
}
