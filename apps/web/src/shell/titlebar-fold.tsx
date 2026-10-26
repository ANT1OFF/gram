import { Menu } from "@base-ui/react/menu";
import type { GridPreset, WorkspaceState } from "@gram/contracts";
import type { ReactNode } from "react";
import {
  BroomSparkles,
  CheckIcon,
  ChevronRightIcon,
  Ellipsis,
  Focus,
  Moon,
  PanelTop,
  Users,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useShortcutHint } from "@/keyboard/use-shortcut-hint";
import { cn } from "@/lib/utils";
import { useTidyUp } from "@/orchestration/use-board-actions";
import { useWorkersListStore } from "@/orchestration/workers-list";
import { GRID_PRESETS, PRESET_LABELS, useLayoutStore } from "@/stores/layout";
import { useViewStore } from "@/views/view-store";
import { useViewWorkspace } from "@/views/view-workspace";

import { PresetGlyph } from "./layout-picker";
import { FOLD_ALL, useTitlebarSlot, type TitlebarFold } from "./titlebar-slot";

// A narrow title bar folds its lesser buttons into "…": the thread's menu when the bar carries a
// thread, else a "…" of its own. Each item does what its button did.

const POPUP =
  "z-50 min-w-48 origin-(--transform-origin) rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0";
const ITEM =
  "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground [&_svg]:size-3.5 [&_svg]:shrink-0";

/**
 * What a narrow bar folds into "…", at `level`, its fold (see `TitlebarFold`). Folded it stays laid
 * out, unseen, inert and hidden from the accessibility tree, out of the row: the bar measures it
 * there to know when it fits back, whatever it holds by then. `gap` is the room its row leaves
 * before it.
 */
export function Foldable({
  level,
  gap,
  className,
  children,
}: {
  level: Exclude<TitlebarFold, 0>;
  gap: number;
  className?: string;
  children: ReactNode;
}) {
  const folded = useTitlebarSlot((s) => s.fold >= level);
  return (
    <span
      data-titlebar-fold={gap}
      data-titlebar-fold-level={level}
      aria-hidden={folded || undefined}
      inert={folded}
      className={cn(
        "flex shrink-0 items-center",
        // At the row's end, where it can't widen what it overhangs.
        folded && "pointer-events-none invisible absolute top-0 right-0",
        className,
      )}
    >
      {children}
    </span>
  );
}

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
 * The title bar's folded buttons as menu items: Workers (once it has folded) and Tidy up (with
 * `orchestration`), Quiet, Focus mode and the layout presets.
 */
function FoldedTitlebarItems({
  orchestration,
  itemClassName = ITEM,
}: {
  /** The bar shows the workspace's orchestration buttons, so Workers and Tidy up are folded too. */
  orchestration: boolean;
  itemClassName?: string;
}) {
  const state = useViewWorkspace();
  const preset = useLayoutStore((s) => s.grid.preset);
  const focusMode = useLayoutStore((s) => s.focusMode);
  const workers = useTitlebarSlot((s) => s.fold >= FOLD_ALL);
  return (
    <div data-testid="titlebar-folded" role="group" aria-label="Title bar">
      {orchestration && state !== undefined && (
        <>
          {workers && (
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
          <TidyItem key={state.workspace.id} state={state} className={itemClassName} />
        </>
      )}
      <Menu.Item
        data-testid="folded-quiet"
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
        aria-label="Layout"
        value={preset}
        onValueChange={(next: GridPreset) => useLayoutStore.getState().setPreset(next)}
      >
        {GRID_PRESETS.map((value) => (
          <Menu.RadioItem key={value} value={value} closeOnClick className={itemClassName}>
            <span className="flex size-3.5 items-center justify-center">
              <Menu.RadioItemIndicator>
                <CheckIcon aria-hidden />
              </Menu.RadioItemIndicator>
            </span>
            <PresetGlyph preset={value} />
            {PRESET_LABELS[value]}
          </Menu.RadioItem>
        ))}
      </Menu.RadioGroup>
    </div>
  );
}

/**
 * The Thread menu's one item for a narrow title bar's folded buttons, so the menu stays within its
 * cap: a "Title bar" submenu with `children` (a worker's own folded actions) first.
 */
export function FoldedTitlebarSubmenu({
  orchestration,
  itemClassName,
  children,
}: {
  orchestration: boolean;
  itemClassName: string;
  children?: ReactNode;
}) {
  return (
    <Menu.SubmenuRoot>
      <Menu.SubmenuTrigger
        data-testid="folded-submenu"
        className={cn(itemClassName, "data-[popup-open]:bg-accent")}
      >
        <PanelTop aria-hidden className="size-3.5" />
        Title bar
        <ChevronRightIcon aria-hidden className="ml-auto size-3.5" />
      </Menu.SubmenuTrigger>
      <Menu.Portal>
        <Menu.Positioner side="left" alignOffset={-4} className="isolate z-50">
          <Menu.Popup data-surface="overlay" aria-label="Title bar" className={POPUP}>
            {children}
            <FoldedTitlebarItems orchestration={orchestration} itemClassName={itemClassName} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.SubmenuRoot>
  );
}

/** The bar's own "…" for its folded buttons, while no thread's menu is in the bar to have them. */
export function TitlebarOverflow({
  orchestration,
  className,
}: {
  orchestration: boolean;
  className?: string;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        data-testid="titlebar-overflow"
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="More window controls"
            title="More window controls"
            className={cn("text-muted-foreground", className)}
          />
        }
      >
        <Ellipsis />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={4} className="isolate z-50 outline-none">
          <Menu.Popup data-testid="titlebar-overflow-menu" className={POPUP}>
            <FoldedTitlebarItems orchestration={orchestration} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
