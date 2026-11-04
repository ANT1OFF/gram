import { Info } from "lucide-react";
import { useId, type ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * More about a setting than its one line of description says, behind a small ⓘ after its name: the
 * words show on hover or focus. The icon is a tab stop and the words describe it for a screen
 * reader. Without help, nothing shows.
 */
export function HelpTip({ label, help }: { label: string; help: ReactNode }) {
  const id = useId();
  if (help === undefined || help === null || help === "" || help === false) return null;
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              // Focusable, so the words reach the keyboard as well as the pointer.
              tabIndex={0}
              role="img"
              aria-label="More info"
              aria-describedby={id}
              data-help-for={label}
              data-testid="setting-help"
              className="inline-flex size-4 shrink-0 cursor-help items-center justify-center rounded-full text-muted-foreground/70 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          }
        >
          <Info aria-hidden className="size-3.5" strokeWidth={1.75} />
        </TooltipTrigger>
        <TooltipContent className="max-w-80 flex-col items-start gap-1 text-start font-normal [&_p]:m-0">
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

/** A setting's or a group's one line of description, shown under its name. */
export function SettingDescription({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p
      id={id}
      data-setting-description=""
      className="text-xs leading-snug text-pretty text-muted-foreground"
    >
      {children}
    </p>
  );
}
