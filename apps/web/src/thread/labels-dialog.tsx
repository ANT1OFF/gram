import type { Label, LabelId } from "@gram/contracts";
import { DEFAULT_PALETTE_ID, PRESET_PALETTES, resolvePalette } from "@gram/themes";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { useThemeStore } from "@/theme/store";
import { useSystemPrefs } from "@/theme/system";
import { resolveMode } from "@/theme/theme";

import { Dialog, DialogShell } from "./dialog-shell";
import { useLabels } from "./use-thread-actions";

const SWATCH_SEEDS = [
  ["red", "Red"],
  ["yellow", "Yellow"],
  ["green", "Green"],
  ["cyan", "Cyan"],
  ["accent", "Accent"],
  ["accent2", "Second accent"],
  ["muted", "Grey"],
] as const;

export interface LabelSwatch {
  readonly name: string;
  readonly color: string;
}

/** The colours a new label can take: the active palette's seed hues, so swatches fit the theme. */
function useLabelSwatches(): readonly LabelSwatch[] {
  const paletteId = useThemeStore((s) => s.palette);
  const modePref = useThemeStore((s) => s.mode);
  const customPalettes = useThemeStore((s) => s.customPalettes);
  const { prefersDark } = useSystemPrefs();
  const mode = resolveMode(modePref, prefersDark);
  const palette =
    resolvePalette([...PRESET_PALETTES, ...customPalettes], paletteId, mode) ??
    resolvePalette(PRESET_PALETTES, DEFAULT_PALETTE_ID, mode)!;
  return SWATCH_SEEDS.map(([seed, name]) => ({ name, color: palette.seeds[seed].toLowerCase() }));
}

/** Create, rename, recolour and delete labels. Each change saves as it's made. */
export function LabelsDialog({ onClose }: { onClose: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const labels = useLabels();
  const swatches = useLabelSwatches();
  const [error, setError] = useState<string | undefined>();

  const run = async (action: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      await queryClient.invalidateQueries({ queryKey: ["labels"] });
    }
  };

  const add = () =>
    run(() =>
      api.upsertLabel({
        id: crypto.randomUUID() as LabelId,
        name: `label ${labels.length + 1}`,
        color: swatches[labels.length % swatches.length]!.color,
      }),
    );

  return (
    <DialogShell
      testId="labels-dialog"
      title="Labels"
      description="A thread carries one label; its colour marks the sidebar row."
      onClose={onClose}
    >
      {labels.length === 0 ? (
        <p className="text-sm text-muted-foreground">No labels yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {labels.map((label) => (
            <LabelRow
              key={label.id}
              label={label}
              swatches={swatches}
              onSave={(next) => void run(() => api.upsertLabel(next))}
              onRemove={() => void run(() => api.removeLabel(label.id))}
            />
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-between gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => void add()}>
          <Plus data-icon="inline-start" />
          New label
        </Button>
        <Dialog.Close render={<Button type="button" size="sm" />}>Done</Dialog.Close>
      </div>
    </DialogShell>
  );
}

function LabelRow({
  label,
  swatches,
  onSave,
  onRemove,
}: {
  label: Label;
  swatches: readonly LabelSwatch[];
  onSave: (label: Label) => void;
  onRemove: () => void;
}) {
  const [name, setName] = useState(label.name);
  const commit = () => {
    const next = name.trim();
    if (next !== "" && next !== label.name) onSave({ ...label, name: next });
    else setName(label.name);
  };

  return (
    <li data-testid="label-row" className="flex items-center gap-2">
      <div
        role="radiogroup"
        aria-label={`Colour for ${label.name}`}
        className="flex shrink-0 gap-1"
      >
        {swatches.map((swatch) => (
          <button
            key={swatch.name}
            type="button"
            role="radio"
            aria-checked={label.color.toLowerCase() === swatch.color}
            aria-label={swatch.name}
            onClick={() => onSave({ ...label, color: swatch.color })}
            className="size-4 rounded-full border border-border outline-none focus-visible:ring-2 focus-visible:ring-ring aria-checked:ring-2 aria-checked:ring-ring"
            style={{ backgroundColor: swatch.color }}
          />
        ))}
      </div>
      <input
        aria-label="Label name"
        className="h-7 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring"
        value={name}
        onChange={(event) => setName(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
      />
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={`Delete label ${label.name}`}
        onClick={onRemove}
      >
        <Trash2 />
      </Button>
    </li>
  );
}
