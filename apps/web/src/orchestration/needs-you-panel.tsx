import { AlarmClock, CircleCheck, X } from "lucide-react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { formatWakeTime } from "@/lib/time";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "@/stores/layout";

import { sectionsIn } from "./needs-you-items";
import {
  kindOf,
  NeedsYouRow,
  NeedsYouUndo,
  SectionHead,
  useNeedsYouActions,
} from "./needs-you-row";
import { NeedsYouStrip } from "./needs-you-strip";
import { useNeedsYouJump, useNeedsYouList, useNeedsYouUi } from "./use-needs-you";

// The Needs you panel (needs-you-home mock, C Hybrid · panel): the whole list beside the thread, by
// kind, each row saying its workspace, filtered by the category strip the popover shares, each row with its answers, Later and Dismiss on hover or focus. It
// stays open while each pick opens its thread beside it. The Later list shows what is put away, with
// when it comes back and Wake.

export function NeedsYouPanel() {
  const { sections, later } = useNeedsYouList();
  const category = useNeedsYouUi((s) => s.category);
  const setCategory = useNeedsYouUi((s) => s.setCategory);
  const showLater = useNeedsYouUi((s) => s.later);
  const setLater = useNeedsYouUi((s) => s.setLater);
  const current = useNeedsYouUi((s) => s.current);
  const jump = useNeedsYouJump();
  const actions = useNeedsYouActions();
  const now = useNow(true, undefined, 60_000);
  const total = sections.reduce((n, section) => n + section.items.length, 0);
  const shown = sectionsIn(sections, category);
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
            : total === 0
              ? "Nothing needs you"
              : `${total} need${total === 1 ? "s" : ""} you`}
        </p>
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
      {/* Every category with its count, above the list rather than in it: the one the popover
          picked is kept, and nothing sits below the fold unseen. */}
      {!showLater && sections.length > 1 && (
        <NeedsYouStrip
          sections={sections}
          category={category}
          onPick={setCategory}
          className="border-b border-border px-1.5 py-1"
        />
      )}
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
                    className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-x-2 rounded-(--radius-md) px-2 py-1.5 hover:bg-muted/60"
                  >
                    <kind.icon
                      aria-label={kind.label}
                      className="mt-0.5 size-4 text-muted-foreground"
                    />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="line-clamp-2 text-[13px] break-words">{item.title}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {[item.workspace, item.where].filter(Boolean).join(" · ")} · back at{" "}
                        {formatWakeTime(wakes, now)}
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
          shown.map((section) => (
            <section
              key={section.key}
              aria-label={section.label}
              data-testid="needs-you-section"
              data-section={section.key}
            >
              <SectionHead label={section.label} count={section.items.length} />
              <ul className="flex flex-col">
                {section.items.map((item) => (
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
