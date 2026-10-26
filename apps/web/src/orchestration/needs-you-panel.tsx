import { AlarmClock, CircleCheck, Hand, MessageCircleQuestion, CircleAlert, X } from "lucide-react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { formatWakeTime } from "@/lib/time";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "@/stores/layout";

import {
  filterCounts,
  filterGroups,
  NEEDS_YOU_FILTERS,
  type NeedsYouFilter,
} from "./needs-you-items";
import { kindOf, NeedsYouRow, NeedsYouUndo, useNeedsYouActions } from "./needs-you-row";
import { useNeedsYouJump, useNeedsYouList, useNeedsYouUi } from "./use-needs-you";

// The Needs you panel (needs-you-home mock, C Hybrid · panel): the whole list beside the thread, by
// workspace, filtered by kind, each row with its answers, Later and Dismiss on hover or focus. It
// stays open while each pick opens its thread beside it. The Later list shows what is put away, with
// when it comes back and Wake.

const FILTER_LABELS: Record<
  NeedsYouFilter,
  { readonly label: string; readonly icon?: typeof Hand }
> = {
  all: { label: "All" },
  asks: { label: "Approvals and questions", icon: MessageCircleQuestion },
  waits: { label: "Waiting on you", icon: Hand },
  failing: { label: "Failing", icon: CircleAlert },
};

export function NeedsYouPanel() {
  const { groups, later } = useNeedsYouList();
  const filter = useNeedsYouUi((s) => s.filter);
  const setFilter = useNeedsYouUi((s) => s.setFilter);
  const showLater = useNeedsYouUi((s) => s.later);
  const setLater = useNeedsYouUi((s) => s.setLater);
  const current = useNeedsYouUi((s) => s.current);
  const jump = useNeedsYouJump();
  const actions = useNeedsYouActions();
  const now = useNow(true, undefined, 60_000);
  const counts = filterCounts(groups);
  const shown = filterGroups(groups, counts[filter] === 0 ? "all" : filter);
  return (
    <section
      aria-label="Needs you"
      data-testid="needs-you-panel"
      className="flex min-h-0 flex-1 flex-col @container"
    >
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5">
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {showLater
            ? `${later.length} for later`
            : counts.all === 0
              ? "Nothing needs you"
              : `${counts.all} need${counts.all === 1 ? "s" : ""} you`}
        </p>
        {!showLater && counts.all > 0 && (
          <ButtonGroup aria-label="Show">
            {NEEDS_YOU_FILTERS.map((each) => {
              const { label, icon: Icon } = FILTER_LABELS[each];
              if (each !== "all" && counts[each] === 0) return null;
              return (
                <Hint
                  key={each}
                  label={label}
                  side="bottom"
                  render={
                    <Button
                      size="xs"
                      variant={filter === each ? "secondary" : "ghost"}
                      aria-pressed={filter === each}
                      aria-label={`${label}, ${counts[each]}`}
                      data-testid="needs-you-filter"
                      data-filter={each}
                      onClick={() => setFilter(each)}
                    />
                  }
                >
                  {Icon === undefined ? "All" : <Icon aria-hidden />}
                  {Icon !== undefined && <span className="tabular-nums">{counts[each]}</span>}
                </Hint>
              );
            })}
          </ButtonGroup>
        )}
        <Hint
          label={showLater ? "Back to what needs you" : "Later"}
          side="bottom"
          render={
            <Button
              size="icon-xs"
              variant={showLater ? "secondary" : "ghost"}
              aria-pressed={showLater}
              aria-label={`Later, ${later.length}`}
              data-testid="needs-you-show-later"
              onClick={() => setLater(!showLater)}
            />
          }
        >
          <AlarmClock aria-hidden />
        </Hint>
        <Hint
          label="Close"
          side="bottom"
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Close Needs you"
              data-testid="needs-you-close"
              onClick={() => useLayoutStore.getState().togglePanel()}
            />
          }
        >
          <X aria-hidden />
        </Hint>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1">
        {showLater ? (
          later.length === 0 ? (
            <Empty title="Nothing for later" text="Later puts an item away for an hour." />
          ) : (
            <ul data-testid="needs-you-later-list" className="flex flex-col">
              {later.map(({ item, wakes }) => {
                const kind = kindOf(item);
                return (
                  <li
                    key={item.key}
                    data-testid="needs-you-later-item"
                    className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-(--radius-md) px-2 py-1 hover:bg-muted/60"
                  >
                    <kind.icon aria-label={kind.label} className="size-4 text-muted-foreground" />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-[13px]">{item.title}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {item.where} · back at {formatWakeTime(wakes, now)}
                      </span>
                    </span>
                    <Button
                      size="xs"
                      variant="ghost"
                      data-testid="needs-you-wake"
                      onClick={() => actions.wake(item)}
                    >
                      Back now
                    </Button>
                  </li>
                );
              })}
            </ul>
          )
        ) : shown.length === 0 ? (
          <Empty
            title="Nothing needs you"
            text="Every workspace is clear."
            more={later.length > 0 ? `${later.length} put away for later` : undefined}
          />
        ) : (
          shown.map((group) => (
            <section
              key={group.key}
              aria-label={group.name}
              data-testid="needs-you-group"
              data-workspace={group.workspaceId}
            >
              <h3 className="flex items-center gap-2 px-2 pt-2 pb-0.5 text-[11px] font-semibold text-muted-foreground">
                <span className="min-w-0 flex-1 truncate">{group.name}</span>
                <span className="font-normal tabular-nums">{group.items.length}</span>
              </h3>
              <ul className="flex flex-col">
                {group.items.map((item) => (
                  <NeedsYouRow
                    key={item.key}
                    item={item}
                    now={now}
                    current={item.key === current}
                    variant="panel"
                    onOpen={jump}
                    actions={actions}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
      <NeedsYouUndo className={cn("border-t border-border py-1")} />
    </section>
  );
}

function Empty({ title, text, more }: { title: string; text: string; more?: string | undefined }) {
  return (
    <div
      data-testid="needs-you-empty"
      className="flex flex-col items-center gap-2 px-5 py-10 text-center text-sm text-muted-foreground"
    >
      <CircleCheck aria-hidden className="size-5 text-success" />
      <p className="font-medium text-foreground">{title}</p>
      <p className="text-xs">{text}</p>
      {more !== undefined && (
        <Button size="xs" variant="ghost" onClick={() => useNeedsYouUi.getState().setLater(true)}>
          <AlarmClock aria-hidden data-icon="inline-start" />
          {more}
        </Button>
      )}
    </div>
  );
}
