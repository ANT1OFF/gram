import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { SETTINGS_STACK } from "@/settings/settings-group";

/**
 * A page's column, as Settings' pages have it: the page's name, one line on what it is for, what
 * acts on the whole page at the name's right, then its groups one above the next. The column keeps
 * Settings' width and its lean into a wide window, so a page of `SettingsGroup`s here reads as one
 * of Gram's.
 */
export function Page({
  title,
  description,
  actions,
  above,
  headingLevel = 1,
  hideTitleOnPhone = false,
  wide = false,
  children,
}: {
  title: string;
  description?: ReactNode;
  /** At the title's right: the page's one or two actions. */
  actions?: ReactNode;
  /** Over the title: where the page sits (a back link, a context line) or the tabs it belongs to. */
  above?: ReactNode;
  /**
   * The title's heading level: 2 where the page sits under a heading of the app's own, so the
   * outline has one `h1`. The look is the same.
   */
  headingLevel?: 1 | 2;
  /**
   * On a phone, the title is left to the app's own bar, which names the page already: still the
   * page's heading for a screen reader, but not drawn, and the actions go under the line. Wider
   * windows show it.
   */
  hideTitleOnPhone?: boolean;
  /**
   * The pane's whole width rather than Settings' reading column: for a page laid out beside a
   * tree or a list of its own.
   */
  wide?: boolean;
  children: ReactNode;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h1";
  const header = (
    <header className="flex flex-wrap items-start gap-x-3 gap-y-2">
      {/* With the title left to the phone's bar, the line takes the row there and the actions
          go under it, rather than beside it in half the width. */}
      <div
        data-slot="page-heading"
        className={cn("flex min-w-0 flex-1 flex-col gap-1", hideTitleOnPhone && "phone:basis-full")}
      >
        <Heading
          className={cn(
            "font-heading text-heading text-foreground",
            hideTitleOnPhone && "phone:sr-only",
          )}
        >
          {title}
        </Heading>
        {description !== undefined && (
          <p className="text-body text-muted-foreground">{description}</p>
        )}
      </div>
      {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
  return (
    <div className="@container/settings">
      {/* Keyed by its name, so a new page arrives anew: its title, then each part 40 ms after the
          last, under the Motion setting. */}
      <div
        key={title}
        data-slot="page"
        className={cn(
          "gram-stagger flex flex-col gap-6 px-8 py-6 @max-2xl/settings:p-4",
          wide ? "w-full" : "settings-column",
        )}
      >
        {above === undefined ? (
          header
        ) : (
          <div className="flex flex-col gap-3">
            <div data-slot="page-above">{above}</div>
            {header}
          </div>
        )}
        <div className={cn("gram-stagger", SETTINGS_STACK)}>{children}</div>
      </div>
    </div>
  );
}
