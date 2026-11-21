export const DOCUMENTATION_POLICY = "gram-prose-v2";
export type CiKind = "docs" | "full";
/**
 * What a change runs beside `classify`/`qualification`: the static stages and bundle build, the
 * Vitest suite on Linux, the same suite on macOS, the unsigned packages, and the mock-API
 * Playwright suite.
 */
export type CiLane = "static" | "tests" | "macos" | "package" | "e2e";
export const CI_LANES: ReadonlyArray<CiLane> = ["static", "tests", "macos", "package", "e2e"];

const MACOS_SENSITIVE = /^(apps\/desktop|packages\/(agents|git|server|shell))\//;
const MACOS_NEUTRAL = /^(apps\/web|packages\/(contracts|themes))\//;

const ordinaryPath = (path: string) =>
  /^[\w@+.-]+(\/[\w@+.-]+)*$/.test(path) &&
  !path.split("/").some((segment) => segment === "." || segment === "..");

const READ_BY_TESTS: ReadonlyArray<readonly [RegExp, ReadonlyArray<CiLane>]> = [
  [/^docs\/design\/mocks\/needs-you-home\//, ["e2e"]],
  [/^docs\/design\/mocks\/tokens\.(config\.json|css)$/, []],
  [/^\.agents\/skills\/mock-build\/kit\//, ["e2e"]],
  [/^\.agents\/skills\/mock-build\//, []],
];

const prose = (path: string) =>
  path.startsWith("docs/") || (path.endsWith(".md") && !/^(apps|packages|tools)\//.test(path));

const extraLanes = (path: string): ReadonlyArray<CiLane> | undefined => {
  for (const [pattern, lanes] of READ_BY_TESTS) if (pattern.test(path)) return lanes;
  if (/^(apps|packages)\/[\w-]+\/(src|scripts)\/.+\.test\.(ts|tsx|mjs)$/.test(path)) return [];
  if (/^tools\/.+\.test\.mjs$/.test(path)) return [];
  if (path.startsWith("apps/web/e2e/")) return ["e2e"];
  if (/^apps\/web\/(e2e-real|pr-shots)\//.test(path)) return [];
  if (path.startsWith("apps/desktop/")) return ["package"];
  if (
    /^tools\/(release-rc|release-stable|mock-kit|dead-code)\//.test(path) ||
    /^tools\/(check-docs|check-public-scaffold|scaffold-boundaries|check-release-please|test-release-please|check-dependency-pins)\.mjs$/.test(
      path,
    )
  )
    return [];
  return undefined;
};

const pathLanes = (path: string): "docs" | ReadonlyArray<CiLane> => {
  if (!ordinaryPath(path)) return CI_LANES;
  const extra = extraLanes(path);
  if (extra === undefined) {
    if (prose(path)) return "docs";
    return MACOS_NEUTRAL.test(path) ? CI_LANES.filter((lane) => lane !== "macos") : CI_LANES;
  }
  return ["static", "tests", ...(MACOS_SENSITIVE.test(path) ? (["macos"] as const) : []), ...extra];
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
  if ([...selected].some((lane) => !jobs.some((job) => job.lane === lane))) return false;
  return jobs.every(
    (job) => known.has(job.lane) && job.result === (selected.has(job.lane) ? "success" : "skipped"),
  );
}
