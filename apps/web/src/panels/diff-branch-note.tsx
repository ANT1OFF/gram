/** Why the Diff shows the branch alone: `clean`, nothing is uncommitted; `push`, to review a push. */
export type BranchShownBecause = "clean" | "push";

/** The line above a branch diff that says why it shows the branch and against what. */
export function DiffBranchNote({
  because,
  base,
}: {
  because: BranchShownBecause;
  base: string | undefined;
}) {
  return (
    <p data-testid="diff-fallback" className="shrink-0 px-3 pb-2 text-meta text-muted-foreground">
      {because === "clean"
        ? "No uncommitted changes. Showing branch vs "
        : "What a push sends: its commits on this branch vs "}
      {(base ?? "its base").replace(/^origin\//, "")}
    </p>
  );
}
