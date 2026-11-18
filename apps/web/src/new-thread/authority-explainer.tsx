import { SquareTerminal, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The other authority over what agents do, beside the autonomy choice it is shown with: a
 * thread's permission mode governs what runs and changes where the agent works. The autonomy
 * choice says what its own levels allow, so it isn't said again here. Neither widens the other.
 * Its words hold wherever an agent works (this machine, or an embedding app's sandbox).
 */
const ROWS: readonly { icon: LucideIcon; term: string; line: string }[] = [
  {
    icon: SquareTerminal,
    term: "Agent permissions",
    line: "What agents may run and edit, set per thread.",
  },
];

/**
 * A compact key telling a thread's permission mode apart from the workspace's autonomy beside it,
 * as a Settings row reads: its name, and one secondary line under it, on one left edge.
 */
export function AuthorityExplainer({ className }: { className?: string }) {
  return (
    <dl
      aria-label="Agent permissions"
      data-testid="authority-explainer"
      className={cn("flex flex-col gap-2", className)}
    >
      {ROWS.map(({ icon: Icon, term, line }) => (
        // The term and its line are the row's own children, as a list of terms is read.
        <div key={term} className="relative flex min-w-0 flex-col pl-6">
          <Icon
            aria-hidden
            className="absolute top-0.5 left-0 size-icon-row shrink-0 text-muted-foreground"
          />
          <dt className="text-body font-medium text-foreground">{term}</dt>
          <dd className="text-meta text-description">{line}</dd>
        </div>
      ))}
    </dl>
  );
}
