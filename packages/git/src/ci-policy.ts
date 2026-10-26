// Shared by Actions and merge launch. Only ordinary, non-executable prose earns the short lane.
// A policy/version change is itself outside this allowlist and must qualify through full CI.
export const DOCUMENTATION_POLICY = "gram-prose-v2";
export type CiKind = "docs" | "full";

// Audited product overview/navigation only. Governance, instructions, qualification and unknown
// names stay full, including CONTRIBUTING and every verification/release record. Adding a path
// requires changing this policy source, which itself always receives full qualification.
const prosePaths = new Set(["README.md", "docs/README.md"]);

/** Complete `git diff --raw -z --no-abbrev` between the actual base and head, not a merge base.
 * Both rename paths and modes matter; malformed, empty or unknown input always selects full. */
export function classifyCiDiff(raw: string): CiKind {
  if (raw === "" || !raw.endsWith("\0")) return "full";
  const fields = raw.slice(0, -1).split("\0");
  for (let i = 0; i < fields.length;) {
    const match = /^:(\d{6}) (\d{6}) [a-f0-9]{40} [a-f0-9]{40} (A|D|M|R\d{1,3})$/.exec(
      fields[i++] ?? "",
    );
    if (match === null) return "full";
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
      return "full";
    if (!prosePaths.has(fields[i++] ?? "")) return "full";
    if (status?.startsWith("R")) {
      if (Number(status.slice(1)) > 100 || !prosePaths.has(fields[i++] ?? "")) return "full";
    }
  }
  return "docs";
}

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

export function qualifiedCiResults(kind: string, results: Record<string, string | undefined>) {
  return (
    results["classify"] === "success" &&
    (kind === "docs"
      ? results["docs"] === "success" &&
        results["check"] === "skipped" &&
        results["e2e"] === "skipped" &&
        results["macos"] === "skipped"
      : kind === "full" &&
        results["docs"] === "skipped" &&
        results["check"] === "success" &&
        results["e2e"] === "success" &&
        results["macos"] === "success")
  );
}
