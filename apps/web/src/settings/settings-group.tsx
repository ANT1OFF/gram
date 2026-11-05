import { useId, type ReactNode } from "react";

import { cn } from "@/lib/utils";

import { HelpTip, SettingDescription } from "./help-tip";
import { SearchScope } from "./search-scope";

/**
 * The card `SettingRow`s sit in, which pads them, with a hairline between rows. Between visible ones: a search hides
 * rows, and the first one it leaves shouldn't carry a line above it.
 */
export const SETTINGS_CARD =
  "flex flex-col rounded-lg border border-border/60 bg-card/40 [&>:not([hidden])~:not([hidden])]:border-t [&>*]:border-border/50 [&>*]:px-4 [&>*]:py-3";

/** A group's title: clearly above a row's name, which is the body size at medium weight. */
export const GROUP_TITLE = "font-heading text-title text-foreground";

/**
 * A named group of settings within a page: its title and one plain sentence on what it is for, an
 * ⓘ for anything more, over a card of rows. Settings search finds the whole group by its name or keywords, and otherwise shows it
 * while something inside matches.
 */
export function SettingsGroup({
  label,
  anchor,
  description,
  learnMore,
  keywords,
  action,
  card = true,
  testId,
  children,
}: {
  label: string;
  /** Its id on the page, which the nav's links under the page scroll to. */
  anchor?: string;
  description?: ReactNode;
  /** What the description leaves out, behind the ⓘ beside the title. */
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
      {...(anchor === undefined ? {} : { id: anchor })}
      className="flex scroll-mt-4 flex-col gap-2"
    >
      <div className="flex items-start gap-3 px-1">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-h-6 items-center gap-1">
            <h3 id={titleId} className={GROUP_TITLE}>
              {label}
            </h3>
            <HelpTip label={label} help={learnMore} />
          </div>
          {description !== undefined && <SettingDescription>{description}</SettingDescription>}
        </div>
        {action !== undefined && <div className="flex shrink-0 items-center">{action}</div>}
      </div>
      <div data-testid={testId} className={cn(card ? SETTINGS_CARD : "flex flex-col gap-4")}>
        {children}
      </div>
    </SearchScope>
  );
}
