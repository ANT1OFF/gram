import { Menu } from "@base-ui/react/menu";
import type { GridPreset, WorkspaceState } from "@gram/contracts";
import {
  BroomSparkles,
  CheckIcon,
  Columns3,
  Ellipsis,
  Focus,
  Moon,
  Rows3,
  Users,
} from "lucide-react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { useShortcutHint } from "@/keyboard/use-shortcut-hint";
import { cn } from "@/lib/utils";
import { useTidyUp } from "@/orchestration/use-board-actions";
import { WorkerMenuItems } from "@/orchestration/worker-header";
import { RunScriptMenuItems } from "@/scripts/run-script-menu";
import { useWorkersListStore } from "@/orchestration/workers-list";
import { GRID_PRESETS, PRESET_LABELS, useLayoutStore, type BoardLayout } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { useViewStore } from "@/views/view-store";
import { useViewWorkspace } from "@/views/view-workspace";

import { PresetGlyph } from "./preset-glyph";
import { FOLD_ALL, useTitlebarSlot, useTitlebarThread } from "./titlebar-slot";

// The title bar's "…" holds the window's rarer toggles, and a narrow bar folds its lesser buttons
// into it too. Each item does what its button did.

const POPUP =
  "z-50 min-w-48 origin-(--transform-origin) rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0";
const ITEM =
  "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground [&_svg]:size-3.5 [&_svg]:shrink-0";

/** A folded button's shortcut, right-aligned as the palette shows it. */
function Keys({ id }: { id: string }) {
  const hint = useShortcutHint(id);
  return hint ? <span className="ml-auto pl-4 text-xs text-muted-foreground">{hint}</span> : null;
}

function TidyItem({ state, className }: { state: WorkspaceState; className: string }) {
  const tidy = useTidyUp(state);
  return (
    <Menu.Item
      data-testid="folded-tidy"
      disabled={tidy.blocked !== undefined || tidy.resting}
      title={tidy.blocked}
      className={className}
      onClick={() => void tidy.send()}
    >
      <BroomSparkles aria-hidden />
      {tidy.sent === undefined ? "Tidy up" : "Asked to tidy up"}
    </Menu.Item>
  );
}

/**
 * The title bar's "…" menu: what a narrow bar folded first (a worker's Keep beside and Take over,
 * Workers, Tidy up), then the window's rarer toggles, Quiet and Focus mode, and the layout presets,
 * each with its shortcut.
 */
function TitlebarMenuItems({
  orchestration,
  itemClassName = ITEM,
}: {
  /** The bar shows the workspace's orchestration buttons, so Workers and Tidy up can fold. */
  orchestration: boolean;
  itemClassName?: string;
}) {
  const state = useViewWorkspace();
  const preset = useLayoutStore((s) => s.grid.preset);
  const focusMode = useLayoutStore((s) => s.focusMode);
  const fold = useTitlebarSlot((s) => s.fold);
  const all = fold >= FOLD_ALL;
  // The Board's Grid or Lanes, folded out of its header with the lesser buttons.
  const board = useViewStore((s) => s.view === "board") && state !== undefined && fold > 0;
  const boardLayout = useLayoutStore((s) => s.boardLayout);
  // A worker in the bar folded all the way: its own actions are this menu's.
  const carried = useTitlebarThread();
  const worker = useThreadsStore((s) =>
    all && carried !== undefined ? s.byId[carried]?.thread : undefined,
  );
  const tidy = orchestration && state !== undefined && fold > 0;
  // The thread in the bar, folded at all: its header's Run script is this menu's.
  const scripted = useThreadsStore((s) => {
    const thread = fold > 0 && carried !== undefined ? s.byId[carried]?.thread : undefined;
    return thread !== undefined && thread.role !== "orchestrator" ? thread : undefined;
  });
  return (
    <div data-testid="titlebar-folded" role="group" aria-label="Title bar">
      {scripted !== undefined && (
        <RunScriptMenuItems
          threadId={scripted.id}
          projectId={scripted.projectId}
          itemClassName={itemClassName}
        />
      )}
      {worker?.spawnedBy !== undefined && (
        <WorkerMenuItems thread={worker} itemClassName={itemClassName} />
      )}
      {orchestration && state !== undefined && all && (
        <Menu.Item
          data-testid="folded-workers"
          className={itemClassName}
          onClick={() => useWorkersListStore.getState().toggle()}
        >
          <Users aria-hidden />
          Workers
          <Keys id="workers.open" />
        </Menu.Item>
      )}
      {tidy && <TidyItem key={state.workspace.id} state={state} className={itemClassName} />}
      {(tidy || (orchestration && state !== undefined && all)) && (
        <div role="separator" className="-mx-1 my-1 h-px bg-border" />
      )}
      {board && (
        <>
          <Menu.RadioGroup
            data-testid="folded-board-layout"
            value={boardLayout}
            onValueChange={(next: BoardLayout) => useLayoutStore.getState().setBoardLayout(next)}
          >
            <Menu.GroupLabel className="px-2 pt-1 pb-0.5 text-[11px] font-medium text-muted-foreground">
              Board
            </Menu.GroupLabel>
            {(
              [
                ["grid", "Grid", Rows3],
                ["lanes", "Lanes", Columns3],
              ] as const
            ).map(([value, label, Icon]) => (
              <Menu.RadioItem key={value} value={value} closeOnClick className={itemClassName}>
                <span className="flex size-3.5 items-center justify-center">
                  <Menu.RadioItemIndicator>
                    <CheckIcon aria-hidden />
                  </Menu.RadioItemIndicator>
                </span>
                <Icon aria-hidden />
                {label}
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
          <div role="separator" className="-mx-1 my-1 h-px bg-border" />
        </>
      )}
      <Menu.Item
        data-testid="folded-quiet"
        title="Show only what needs you, one card at a time"
        className={itemClassName}
        onClick={() => useViewStore.getState().setQuiet(true)}
      >
        <Moon aria-hidden />
        Quiet
        <Keys id="view.quiet" />
      </Menu.Item>
      <Menu.Item
        data-testid="folded-focus"
        className={itemClassName}
        onClick={() => useLayoutStore.getState().toggleFocusMode()}
      >
        <Focus aria-hidden />
        {focusMode ? "Leave focus mode" : "Focus mode"}
        <Keys id="focus.toggle" />
      </Menu.Item>
      <div role="separator" className="-mx-1 my-1 h-px bg-border" />
      <Menu.RadioGroup
        data-testid="folded-layout"
        value={preset}
        onValueChange={(next: GridPreset) => useLayoutStore.getState().setPreset(next)}
      >
        <Menu.GroupLabel className="px-2 pt-1 pb-0.5 text-[11px] font-medium text-muted-foreground">
          Layout
        </Menu.GroupLabel>
        {GRID_PRESETS.map((value, i) => (
          <Menu.RadioItem
            key={value}
            value={value}
            aria-label={PRESET_LABELS[value]}
            closeOnClick
            className={itemClassName}
          >
            <span className="flex size-3.5 items-center justify-center">
              <Menu.RadioItemIndicator>
                <CheckIcon aria-hidden />
              </Menu.RadioItemIndicator>
            </span>
            <PresetGlyph preset={value} />
            {PRESET_LABELS[value]}
            <Keys id={`layout.preset${i + 1}`} />
          </Menu.RadioItem>
        ))}
      </Menu.RadioGroup>
    </div>
  );
}

/**
 * The bar's "…", always at the start of its view controls: the window's rarer toggles, and what a
 * narrow bar folds away.
 */
export function TitlebarOverflow({
  orchestration,
  className,
}: {
  orchestration: boolean;
  className?: string;
}) {
  return (
    <Menu.Root>
      <Hint
        label={"More window controls\nQuiet, focus mode and layout"}
        side="bottom"
        render={
          <Menu.Trigger
            data-testid="titlebar-overflow"
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="More window controls"
                className={cn(
                  "text-muted-foreground data-popup-open:bg-muted data-popup-open:text-foreground",
                  className,
                )}
              />
            }
          />
        }
      >
        <Ellipsis />
      </Hint>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={4} className="isolate z-50 outline-none">
          <Menu.Popup data-testid="titlebar-overflow-menu" className={POPUP}>
            <TitlebarMenuItems orchestration={orchestration} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
