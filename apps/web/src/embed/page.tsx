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
  children,
}: {
  title: string;
  description?: ReactNode;
  /** At the title's right: the page's one or two actions. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="@container/settings">
      {/* Keyed by its name, so a new page arrives anew: its title, then each part 40 ms after the
          last, under the Motion setting. */}
      <div
        key={title}
        data-slot="page"
        className="gram-stagger settings-column flex flex-col gap-6 px-8 py-6 @max-2xl/settings:p-4"
      >
        <header className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h1 className="font-heading text-heading text-foreground">{title}</h1>
            {description !== undefined && (
              <p className="text-body text-muted-foreground">{description}</p>
            )}
          </div>
          {actions !== undefined && (
            <div className="flex shrink-0 items-center gap-2">{actions}</div>
          )}
        </header>
        <div className={cn("gram-stagger", SETTINGS_STACK)}>{children}</div>
      </div>
    </div>
  );
}
