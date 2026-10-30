import { useId, type ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * A setting's name that explains itself, so a row stays a label and its control. With help, the
 * name takes a dotted underline and the words show on hover or focus: the name is a tab stop, and
 * the words describe it for a screen reader. Without help, it is just the name.
 */
export function HelpTip({
  label,
  help,
  children,
}: {
  label: string;
  help: ReactNode;
  /** The name as it shows: a label, a heading's words. */
  children: ReactNode;
}) {
  const id = useId();
  if (help === undefined || help === null || help === "" || help === false) return children;
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              // Focusable, so the words reach the keyboard as well as the pointer.
              tabIndex={0}
              aria-describedby={id}
              data-help-for={label}
              data-testid="setting-help"
              className="cursor-help rounded-sm underline decoration-muted-foreground/50 decoration-dotted underline-offset-4 outline-none hover:decoration-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          }
        >
          {children}
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
