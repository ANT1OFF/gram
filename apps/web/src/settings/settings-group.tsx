import { useId, type ReactNode } from "react";

import { cn } from "@/lib/utils";

import { HelpTip } from "./help-tip";
import { SearchScope } from "./search-scope";

/**
 * The card `SettingRow`s sit in, which pads them, with a hairline between rows. Between visible ones: a search hides
 * rows, and the first one it leaves shouldn't carry a line above it.
 */
export const SETTINGS_CARD =
  "flex flex-col rounded-lg border border-border/60 bg-card/40 [&>:not([hidden])~:not([hidden])]:border-t [&>*]:border-border/50 [&>*]:px-3 [&>*]:py-2.5";

/**
 * A named group of settings within a page: a muted caption that explains it on hover or focus,
 * over a card of rows. Settings search finds the whole group by its name or keywords, and otherwise shows it
 * while something inside matches.
 */
export function SettingsGroup({
  label,
  description,
  learnMore,
  keywords,
  action,
  card = true,
  testId,
  children,
}: {
  label: string;
  description?: ReactNode;
  /** What the description leaves out, in the same help. */
  learnMore?: ReactNode;
  /** Extra words Settings search finds the group by. */
  keywords?: readonly string[];
  /** On the caption's right, such as a group-wide Re-check. */
  action?: ReactNode;
  /** Off for a group whose content isn't rows, which then sits on the page itself. */
  card?: boolean;
  /** On the card, for specs to find the group's rows by. */
  testId?: string;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <SearchScope
      as="section"
      label={label}
      {...(keywords ? { keywords } : {})}
      aria-labelledby={titleId}
      className="flex flex-col gap-2"
    >
      <div className="flex min-h-7 items-center gap-1 px-1">
        <h3
          id={titleId}
          className="font-caption text-xs font-medium tracking-wide text-muted-foreground uppercase"
        >
          <HelpTip label={label} help={groupHelp(description, learnMore)}>
            {label}
          </HelpTip>
        </h3>
        <span className="flex-1" />
        {action}
      </div>
      <div data-testid={testId} className={cn(card ? SETTINGS_CARD : "flex flex-col gap-4")}>
        {children}
      </div>
    </SearchScope>
  );
}

function groupHelp(description: ReactNode, learnMore: ReactNode): ReactNode {
  if (learnMore === undefined || learnMore === null) return description;
  return (
    <>
      {description !== undefined && <p>{description}</p>}
      {learnMore}
    </>
  );
}
