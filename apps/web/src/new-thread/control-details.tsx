import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { FOCUS_RING } from "@/lib/selection";
import { cn } from "@/lib/utils";

/**
 * The New form's quieter controls behind one disclosure: who directs a worker, the workspace's
 * autonomy picker, how permissions and autonomy differ, and what the agent supports. Closed by
 * default; the authority line beside Start says what they are set to, so folding them hides no
 * consequence.
 */
export function ControlDetails({
  label = "Control and approvals",
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  return (
    <Collapsible data-testid="new-control-details">
      <CollapsibleTrigger
        className={cn(
          "group flex items-center gap-1 rounded-sm text-meta text-muted-foreground hover:text-foreground",
          FOCUS_RING,
        )}
      >
        <ChevronRight
          aria-hidden
          className="size-3.5 shrink-0 transition-transform group-data-[panel-open]:rotate-90"
        />
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent className="gram-collapse">
        <div className="flex flex-col gap-3 pt-3 pl-5">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
