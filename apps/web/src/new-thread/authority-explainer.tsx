import { GitMerge, SquareTerminal, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The two separate authorities over what agents do, as they read at the autonomy choice: a
 * thread's permission mode governs what runs and changes on this machine, and the workspace's
 * autonomy governs what Gram publishes and merges. Neither widens the other.
 */
const ROWS: readonly { icon: LucideIcon; term: string; line: string }[] = [
  {
    icon: SquareTerminal,
    term: "Agent permissions",
    line: "What agents may run and edit on this machine, set per thread.",
  },
  {
    icon: GitMerge,
    term: "Workspace autonomy",
    line: "What Gram may publish and merge without asking you.",
  },
];

/**
 * A compact two-row key telling a thread's permission mode apart from the workspace's autonomy,
 * each row as a Settings row reads: its name, and one secondary line under it, on one left edge.
 */
export function AuthorityExplainer({ className }: { className?: string }) {
  return (
    <dl
      aria-label="Permissions and autonomy"
      data-testid="authority-explainer"
      className={cn("flex flex-col gap-2", className)}
    >
      {ROWS.map(({ icon: Icon, term, line }) => (
        <div key={term} className="flex items-start gap-2">
          <Icon aria-hidden className="mt-0.5 size-icon-row shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-col">
            <dt className="text-body font-medium text-foreground">{term}</dt>
            <dd className="text-meta text-description">{line}</dd>
          </div>
        </div>
      ))}
    </dl>
  );
}
