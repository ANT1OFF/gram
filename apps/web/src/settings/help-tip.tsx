import { CircleHelp } from "lucide-react";
import { useId, type ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * A setting's explanation behind a ? beside its label, so a row stays a label and its control. The
 * words show on hover or focus, and describe the ? for a screen reader.
 */
export function HelpTip({ label, help }: { label: string; help: ReactNode }) {
  const id = useId();
  if (help === undefined || help === null || help === "" || help === false) return null;
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              // Not the label's words, so finding the row's control by its name finds only it.
              aria-label="Help"
              aria-describedby={id}
              data-help-for={label}
              data-testid="setting-help"
              className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          }
        >
          <CircleHelp aria-hidden className="size-3.5" />
        </TooltipTrigger>
        <TooltipContent className="flex-col items-start gap-1 text-start font-normal [&_p]:m-0">
          {help}
        </TooltipContent>
      </Tooltip>
      {typeof help === "string" ? (
        <span id={id} className="hidden" data-long-copy="help">
          {help}
        </span>
      ) : (
        <div id={id} className="hidden" data-long-copy="help">
          {help}
        </div>
      )}
    </>
  );
}
