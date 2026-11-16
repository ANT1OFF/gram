import { CalendarDays, Network, type LucideIcon } from "lucide-react";

import {
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu";
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
    <Menu>
      <MenuTrigger
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
        <Icon aria-hidden className="size-icon-row" />
      </MenuTrigger>
      <MenuContent data-testid="done-grouping-menu" className="min-w-44">
        <MenuRadioGroup
          aria-label="Group by"
          value={grouping}
          onValueChange={(next: DoneGrouping) => setGrouping(next)}
        >
          {DONE_GROUPINGS.map(({ id, hint }) => {
            const ItemIcon = ICONS[id];
            return (
              <MenuRadioItem key={id} value={id}>
                <ItemIcon aria-hidden className="text-muted-foreground" />
                {hint}
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}
