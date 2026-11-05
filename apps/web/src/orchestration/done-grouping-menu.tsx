import { Menu } from "@base-ui/react/menu";
import { CalendarDays, CheckIcon, Network, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { useLayoutStore, type DoneGrouping } from "@/stores/layout";

import { DONE_GROUPINGS } from "./done-model";

// History's grouping control: by date or by orchestrator. An icon that says the current
// choice on its hover and offers both in a menu; the choice is the user's, kept in the layout store
// for History.

const ICONS: Readonly<Record<DoneGrouping, LucideIcon>> = {
  date: CalendarDays,
  orchestrator: Network,
};

const POPUP =
  "z-50 min-w-44 origin-(--transform-origin) rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0";
const ITEM =
  "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-[highlighted]:row-cursor [&_svg]:size-3.5 [&_svg]:shrink-0";

/** The grouping's icon button and its menu. `stop` marks it a stop for the overview's arrow keys. */
export function DoneGroupingMenu({
  className,
  stop,
}: {
  className?: string;
  stop?: Record<string, string>;
}) {
  const grouping = useLayoutStore((s) => s.doneGrouping);
  const setGrouping = useLayoutStore((s) => s.setDoneGrouping);
  const current = DONE_GROUPINGS.find((each) => each.id === grouping) ?? DONE_GROUPINGS[0]!;
  const Icon = ICONS[current.id];
  return (
    <Menu.Root>
      <Menu.Trigger
        {...stop}
        data-testid="done-grouping"
        data-grouping={current.id}
        aria-label={`${current.hint}. Change grouping`}
        title={current.hint}
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-(--radius-sm) text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:text-foreground",
          className,
        )}
      >
        <Icon aria-hidden className="size-3.5" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={4} className="isolate z-50 outline-none">
          <Menu.Popup data-testid="done-grouping-menu" data-surface="overlay" className={POPUP}>
            <Menu.RadioGroup
              aria-label="Group by"
              value={grouping}
              onValueChange={(next: DoneGrouping) => setGrouping(next)}
            >
              {DONE_GROUPINGS.map(({ id, hint }) => {
                const ItemIcon = ICONS[id];
                return (
                  <Menu.RadioItem key={id} value={id} closeOnClick className={ITEM}>
                    <span className="flex size-3.5 items-center justify-center">
                      <Menu.RadioItemIndicator>
                        <CheckIcon aria-hidden />
                      </Menu.RadioItemIndicator>
                    </span>
                    <ItemIcon aria-hidden className="text-muted-foreground" />
                    {hint}
                  </Menu.RadioItem>
                );
              })}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
