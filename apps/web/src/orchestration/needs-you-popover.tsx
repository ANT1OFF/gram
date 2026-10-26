import { Popover } from "@base-ui/react/popover";
import { CircleCheck, PanelRight } from "lucide-react";
import type { ReactElement } from "react";

import { Button } from "@/components/ui/button";
import { useShortcutHint } from "@/keyboard/use-shortcut-hint";
import { formatWakeTime } from "@/lib/time";
import { useNow } from "@/lib/use-now";

import type { NeedsYouGroup } from "./needs-you-items";
import { NeedsYouRow, NeedsYouUndo, useNeedsYouActions } from "./needs-you-row";
import {
  openNeedsYouPanel,
  useNeedsYouJump,
  useNeedsYouList,
  useNeedsYouUi,
  type NeedsYouAnchor,
} from "./use-needs-you";

// The Needs you popover (needs-you-home mock, C Hybrid · popover): the newest few items across every
// workspace, by workspace, each a click from its thread at the turn that asked and answerable in
// place; See all opens the whole list as the right panel. The pill it hangs from is its trigger.

/** How many rows the popover shows before See all. */
const POPOVER_ROWS = 6;

/**
 * At most `rows` items, shared out a row at a time across the groups so every workspace that has
 * something shows it, each group's newest first; and how many are left out.
 */
export const firstRows = (
  groups: readonly NeedsYouGroup[],
  rows: number,
): { readonly groups: readonly NeedsYouGroup[]; readonly more: number } => {
  const taken = groups.map(() => 0);
  const total = groups.reduce((n, group) => n + group.items.length, 0);
  // One row to each group in turn that has one left, until the rows or the items run out.
  for (let given = 0; given < Math.min(rows, total);) {
    for (const [index, group] of groups.entries()) {
      if (given < rows && taken[index]! < group.items.length) {
        taken[index]! += 1;
        given += 1;
      }
    }
  }
  const shown = groups
    .map((group, index) => ({ ...group, items: group.items.slice(0, taken[index]) }))
    .filter((group) => group.items.length > 0);
  return { groups: shown, more: total - Math.min(rows, total) };
};

export function NeedsYouPopover({
  anchor,
  trigger,
}: {
  anchor: NeedsYouAnchor;
  /** The pill, which opens and closes it. */
  trigger: ReactElement;
}) {
  const open = useNeedsYouUi((s) => s.popover === anchor);
  const setPopover = useNeedsYouUi((s) => s.setPopover);
  return (
    <Popover.Root open={open} onOpenChange={(next) => setPopover(next ? anchor : undefined)}>
      <Popover.Trigger render={trigger} />
      <Popover.Portal>
        <Popover.Positioner
          side={anchor === "rail" ? "right" : "bottom"}
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="isolate z-50"
        >
          <Popover.Popup
            data-testid="needs-you-popover"
            data-surface="overlay"
            className="flex max-h-[min(32rem,var(--available-height))] w-[min(24rem,calc(100vw-1rem),calc(var(--available-width)-0.5rem))] origin-(--transform-origin) flex-col rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0"
          >
            <PopoverBody />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function PopoverBody() {
  const { groups, later } = useNeedsYouList();
  const current = useNeedsYouUi((s) => s.current);
  const jump = useNeedsYouJump();
  const actions = useNeedsYouActions();
  const now = useNow(true, undefined, 60_000);
  const next = useShortcutHint("thread.nextNeedsYou");
  const shown = firstRows(groups, POPOVER_ROWS);
  const total = groups.reduce((n, group) => n + group.items.length, 0);
  return (
    <>
      <div className="flex items-center gap-2 px-2 pt-1.5 pb-1">
        <Popover.Title className="text-[13px] font-semibold">Needs you</Popover.Title>
        {total > 0 && next !== undefined && (
          <span className="ml-auto text-[11px] text-muted-foreground">{next} next</span>
        )}
      </div>
      {total === 0 ? (
        <p
          data-testid="needs-you-empty"
          className="flex items-center gap-2 px-2 py-2.5 text-[13px] text-muted-foreground"
        >
          <CircleCheck aria-hidden className="size-4 text-success" />
          Nothing needs you
        </p>
      ) : (
        <div className="min-h-0 overflow-y-auto">
          {shown.groups.map((group) => (
            <section key={group.key} aria-label={group.name}>
              <h3 className="px-2 pt-1.5 pb-0.5 text-[11px] font-semibold text-muted-foreground">
                {group.name}
              </h3>
              <ul className="flex flex-col">
                {group.items.map((item) => (
                  <NeedsYouRow
                    key={item.key}
                    item={item}
                    now={now}
                    current={item.key === current}
                    variant="popover"
                    onOpen={jump}
                    actions={actions}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      <NeedsYouUndo className="pt-1" />
      {(total > 0 || later.length > 0) && (
        <div className="mt-1 flex items-center gap-2 border-t border-border px-2 pt-1 text-[11px] text-muted-foreground">
          <span data-testid="needs-you-popover-foot" className="min-w-0 flex-1 truncate">
            {[
              shown.more > 0 ? `${shown.more} more` : undefined,
              later[0] !== undefined
                ? `Later ${later.length}, back at ${formatWakeTime(later[0].wakes, now)}`
                : undefined,
            ]
              .filter((part) => part !== undefined)
              .join(" · ")}
          </span>
          <Button
            size="xs"
            variant="ghost"
            data-testid="needs-you-see-all"
            onClick={openNeedsYouPanel}
          >
            {total > 0 ? `See all ${total}` : "Show Later"}
            <PanelRight aria-hidden data-icon="inline-end" />
          </Button>
        </div>
      )}
    </>
  );
}
