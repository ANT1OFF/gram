// Shared by Actions and merge launch. Only ordinary, non-executable prose earns the short lane.
// A policy/version change is itself outside this allowlist and must qualify through full CI.
export const DOCUMENTATION_POLICY = "gram-prose-v2";
export type CiKind = "docs" | "full";
/**
 * What a change runs beside `classify`/`qualification`: the static stages and bundle build, the
 * Vitest suite (Linux and macOS), the unsigned macOS package, and the mock-API Playwright suite.
 */
export type CiLane = "static" | "tests" | "package" | "e2e";
export const CI_LANES: ReadonlyArray<CiLane> = ["static", "tests", "package", "e2e"];

/** No `..` or `.` segment, empty segment, or character outside ordinary file names. */
const ordinaryPath = (path: string) =>
  /^[\w@+.-]+(\/[\w@+.-]+)*$/.test(path) &&
  !path.split("/").some((segment) => segment === "." || segment === "..");

/**
 * Prose-shaped paths that tests read, checked before the prose rule: the mock the e2e suite loads
 * (`mock-presentation`, `needs-you`), the mock tokens, and the whole mock-build skill, whose
 * templates `tools/mock-kit/mock-kit.test.mjs` lists by directory. Each is code, with the lanes
 * beyond `static` and `tests` that read it.
 */
const READ_BY_TESTS: ReadonlyArray<readonly [RegExp, ReadonlyArray<CiLane>]> = [
  [/^docs\/design\/mocks\/needs-you-home\//, ["e2e"]],
  [/^docs\/design\/mocks\/tokens\.(config\.json|css)$/, []],
  [/^\.agents\/skills\/mock-build\/kit\//, ["e2e"]],
  [/^\.agents\/skills\/mock-build\//, []],
];

/**
 * Prose nothing builds, bundles or tests: Markdown outside the workspaces and tools, and the docs
 * tree. Markdown inside a workspace or `tools/` stays code (a fixture can be prose-shaped).
 */
const prose = (path: string) =>
  path.startsWith("docs/") || (path.endsWith(".md") && !/^(apps|packages|tools)\//.test(path));

/**
 * The lanes beyond `static` and `tests` one non-prose path can affect, by the workspace dependency
 * graph; `undefined` means every lane. Every non-prose path runs the static stages and Vitest, since
 * tests read sources as text (`catalog-coverage.test.ts` reads the e2e specs, for one). The e2e
 * suite reaches every workspace but `apps/desktop` (web uses contracts, themes and shell, shell
 * uses git, and the specs import agents and server sources), and the package bundles every
 * workspace. `tools/check/ci-lanes.test.mjs` keeps this table honest against the real graph.
 */
const extraLanes = (path: string): ReadonlyArray<CiLane> | undefined => {
  for (const [pattern, lanes] of READ_BY_TESTS) if (pattern.test(path)) return lanes;
  if (/^(apps|packages)\/[\w-]+\/(src|scripts)\/.+\.test\.(ts|tsx|mjs)$/.test(path)) return [];
  if (/^tools\/.+\.test\.mjs$/.test(path)) return [];
  if (path.startsWith("apps/web/e2e/")) return ["e2e"];
  if (/^apps\/web\/(e2e-real|pr-shots)\//.test(path)) return [];
  if (path.startsWith("apps/desktop/")) return ["package"];
  // Release and repository tools: not built into the app, run by their own tests and the static stages.
  if (
    /^tools\/(release-rc|release-stable|mock-kit|dead-code)\//.test(path) ||
    /^tools\/(check-docs|check-public-scaffold|scaffold-boundaries|check-release-please|test-release-please|check-dependency-pins)\.mjs$/.test(
      path,
    )
  )
    return [];
  return undefined;
};

/** `docs` for prose, else the lanes the path can affect; an unordinary name runs every lane. */
const pathLanes = (path: string): "docs" | ReadonlyArray<CiLane> => {
  if (!ordinaryPath(path)) return CI_LANES;
  const extra = extraLanes(path);
  if (extra === undefined) return prose(path) ? "docs" : CI_LANES;
  return ["static", "tests", ...extra];
};

/**
 * Complete `git diff --raw -z --no-abbrev` between the actual base and head, not a merge base:
 * `docs` when every path is prose, else the lanes the paths can affect. Both rename paths and modes
 * matter; malformed, empty or unknown input always selects every lane.
 */
export function ciLanes(raw: string): "docs" | ReadonlySet<CiLane> {
  const all = new Set(CI_LANES);
  if (raw === "" || !raw.endsWith("\0")) return all;
  const fields = raw.slice(0, -1).split("\0");
  const lanes = new Set<CiLane>();
  let docs = true;
  const add = (path: string | undefined) => {
    if (path === undefined || path === "") return false;
    const selected = pathLanes(path);
    if (selected === "docs") return true;
    docs = false;
    for (const lane of selected) lanes.add(lane);
    return true;
  };
  for (let i = 0; i < fields.length;) {
    const match = /^:(\d{6}) (\d{6}) [a-f0-9]{40} [a-f0-9]{40} (A|D|M|R\d{1,3})$/.exec(
      fields[i++] ?? "",
    );
    if (match === null) return all;
    const [, before, after, status] = match;
    // Regular, non-executable files only: a symlink, submodule, mode or type change runs everything.
    if (
      (before !== "100644" && before !== "000000") ||
      (after !== "100644" && after !== "000000") ||
      (status === "A"
        ? before !== "000000" || after !== "100644"
        : status === "D"
          ? before !== "100644" || after !== "000000"
          : before !== "100644" || after !== "100644")
    )
      return all;
    if (!add(fields[i++])) return all;
    if (status?.startsWith("R")) {
      if (Number(status.slice(1)) > 100 || !add(fields[i++])) return all;
    }
  }
  return docs ? "docs" : lanes;
}

/** `docs` when every changed path is prose; anything else, including malformed input, is full. */
export const classifyCiDiff = (raw: string): CiKind => (ciLanes(raw) === "docs" ? "docs" : "full");

/** No relative pathspec, external diff, text conversion, submodule suppression or replace refs. */
export const ciDiffArgs = (base: string, head: string) => [
  "--no-replace-objects",
  "diff",
  "--raw",
  "-z",
  "--no-abbrev",
  "--no-ext-diff",
  "--no-textconv",
  "--no-relative",
  "--ignore-submodules=none",
  "--find-renames",
  base,
  head,
  "--",
];

/**
 * `classify` outputs `kind` (`docs`, or `code` with the `lanes` it selected) and every other job's
 * result, keyed by its lane (`docs` for the docs job). Each job must have succeeded when its lane
 * is selected and been skipped when it isn't: a skip passes only when classification asked for it.
 */
export function qualifiedCiResults(
  kind: string,
  lanes: ReadonlyArray<string>,
  classify: string | undefined,
  jobs: ReadonlyArray<{ readonly lane: string; readonly result: string | undefined }>,
) {
  if (classify !== "success") return false;
  if (kind === "docs" ? lanes.length !== 0 : kind !== "code" || lanes.length === 0) return false;
  if (lanes.some((lane) => !(CI_LANES as ReadonlyArray<string>).includes(lane))) return false;
  if (new Set(lanes).size !== lanes.length) return false;
  const selected = new Set(kind === "docs" ? ["docs"] : lanes);
  const known = new Set(["docs", ...CI_LANES]);
  // Every lane classification selected must have a job; a job of an unknown lane never passes.
  if ([...selected].some((lane) => !jobs.some((job) => job.lane === lane))) return false;
  return jobs.every(
    (job) => known.has(job.lane) && job.result === (selected.has(job.lane) ? "success" : "skipped"),
  );
}
