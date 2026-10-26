import { GRID_SHAPES, type GridPreset } from "@gram/contracts";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { shortcutHint } from "@/keyboard/bindings";
import { useBindingsStore } from "@/keyboard/bindings-store";
import { radioGroupKeyDown } from "@/lib/list-keys";
import { cn } from "@/lib/utils";
import { GRID_PRESETS, PRESET_LABELS, useLayoutStore } from "@/stores/layout";
import { SegmentSlab } from "@/motion";

import { TitlebarPopover } from "./titlebar-popover";

const RADIO =
  "relative flex h-7 items-center gap-2 rounded-(--radius-sm) px-2 text-left text-[13px] text-muted-foreground outline-none transition-colors duration-(--dur-fast) hover:text-foreground hover:not-aria-checked:bg-muted focus-visible:ring-2 focus-visible:ring-ring aria-checked:text-accent-foreground";

/**
 * The pane grid presets behind one title bar button showing the current preset. Its popover lists
 * each preset with its shortcut; the arrows move the choice, and a click or Enter takes it and
 * closes.
 */
export function LayoutPicker({ className }: { className?: string }) {
  const preset = useLayoutStore((s) => s.grid.preset);
  const setPreset = useLayoutStore((s) => s.setPreset);
  const overrides = useBindingsStore((s) => s.overrides);
  const slab = useId();
  const [open, setOpen] = useState(false);
  const label = `Layout: ${PRESET_LABELS[preset]}`;

  return (
    <TitlebarPopover
      open={open}
      onOpenChange={setOpen}
      label="Layout"
      testId="layout-picker"
      className="w-52 p-1"
      onShown={(popup) =>
        popup
          .querySelector<HTMLElement>('[aria-label="Layout"] [role="radio"][aria-checked="true"]')
          ?.focus()
      }
      trigger={
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          title={label}
          data-testid="layout-picker-button"
          className={cn(
            "text-muted-foreground data-popup-open:bg-muted data-popup-open:text-foreground",
            className,
          )}
        >
          <PresetGlyph preset={preset} />
        </Button>
      }
    >
      <div
        role="radiogroup"
        aria-label="Layout"
        className="isolate flex flex-col"
        onKeyDown={(event) => radioGroupKeyDown(event, GRID_PRESETS, preset, setPreset)}
      >
        {GRID_PRESETS.map((value, i) => {
          const hint = shortcutHint(`layout.preset${i + 1}`, overrides);
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={preset === value}
              tabIndex={preset === value ? 0 : -1}
              aria-label={PRESET_LABELS[value]}
              onClick={() => {
                setPreset(value);
                setOpen(false);
              }}
              className={RADIO}
            >
              {preset === value && <SegmentSlab group={slab} className="bg-accent" />}
              <PresetGlyph preset={value} />
              <span className="min-w-0 flex-1 truncate">{PRESET_LABELS[value]}</span>
              {hint && <kbd className="font-sans text-[11px] opacity-70">{hint}</kbd>}
            </button>
          );
        })}
      </div>
    </TitlebarPopover>
  );
}

const GLYPH_SIZE = 14;
const GLYPH_GAP = 1.5;

export function PresetGlyph({ preset }: { preset: GridPreset }) {
  const { cols, rows } = GRID_SHAPES[preset];
  const width = (GLYPH_SIZE - GLYPH_GAP * (cols - 1)) / cols;
  const height = (GLYPH_SIZE - GLYPH_GAP * (rows - 1)) / rows;
  return (
    <svg aria-hidden viewBox={`0 0 ${GLYPH_SIZE} ${GLYPH_SIZE}`} className="size-3.5 shrink-0">
      {Array.from({ length: cols * rows }, (_, i) => (
        <rect
          key={i}
          x={(i % cols) * (width + GLYPH_GAP)}
          y={Math.floor(i / cols) * (height + GLYPH_GAP)}
          width={width}
          height={height}
          rx={1}
          fill="currentColor"
        />
      ))}
    </svg>
  );
}
