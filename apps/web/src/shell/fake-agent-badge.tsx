import { FlaskConical } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useDiagnostics } from "@/settings/use-diagnostics";

export const FAKE_AGENT_HINT = "Replies are echoes. Start with GRAM_FAKE_AGENT=0 for real Claude";

/** Marks a server running the echo fake agent; renders nothing with real agents. */
export function FakeAgentBadge({ className }: { className?: string }) {
  const { data } = useDiagnostics();
  if (!data?.fakeAgent) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span tabIndex={0} />}
        data-testid="fake-agent-badge"
        aria-label={`Fake agent. ${FAKE_AGENT_HINT}`}
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-sm border border-status-needs/60 px-1.5 text-xs text-status-needs",
          className,
        )}
      >
        <FlaskConical aria-hidden className="size-3" />
        Fake agent
      </TooltipTrigger>
      <TooltipContent>{FAKE_AGENT_HINT}</TooltipContent>
    </Tooltip>
  );
}
