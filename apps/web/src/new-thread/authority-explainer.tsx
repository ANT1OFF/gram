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
    line: "what agents may run and edit locally (set per thread).",
  },
  {
    icon: GitMerge,
    term: "Workspace autonomy",
    line: "what Gram may publish and merge without asking.",
  },
];

/** A compact two-row key telling a thread's permission mode apart from the workspace's autonomy. */
export function AuthorityExplainer({ className }: { className?: string }) {
  return (
    <dl
      aria-label="Permissions and autonomy"
      data-testid="authority-explainer"
      className={cn(
        "grid grid-cols-[auto_1fr] items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground",
        className,
      )}
    >
      {ROWS.map(({ icon: Icon, term, line }) => (
        <div key={term} className="contents">
          <dt className="flex items-center gap-1.5 font-medium whitespace-nowrap text-foreground">
            <Icon aria-hidden className="size-3.5 shrink-0 self-center text-muted-foreground" />
            {term}:
          </dt>
          <dd>{line}</dd>
        </div>
      ))}
    </dl>
  );
}
