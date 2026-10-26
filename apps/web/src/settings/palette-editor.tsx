import {
  SEED_TOKEN_KEYS,
  normalizeHex,
  paletteCss,
  PRESET_PALETTES,
  DEFAULT_PALETTE_ID,
  type SeedTokenKey,
  type SeedTokens,
} from "@gram/themes";
import { TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import { useStore } from "zustand";

import { Button } from "@/components/ui/button";
import { themeStore, type ThemeStore } from "@/theme/store";

import { WhyDisabled } from "./fields";
import {
  buildPalette,
  contrastWarnings,
  customPaletteId,
  findPalette,
  isHex,
  nameProblem,
  TOKEN_LABELS,
} from "./palette-editor-model";

const PREVIEW_ID = "gram-palette-preview";

/**
 * Settings → Appearance: edit the active palette's 10 seed colours, preview them in the current
 * look, and save them as a custom palette. Custom palettes persist through settings sync.
 */
export function PaletteEditor({ store = themeStore }: { store?: ThemeStore }) {
  const activeId = useStore(store, (s) => s.palette);
  const custom = useStore(store, (s) => s.customPalettes);
  const palettes = [...PRESET_PALETTES, ...custom];
  const active = findPalette(palettes, activeId);
  const nameId = useId();

  const [base, setBase] = useState(active?.id);
  const [seeds, setSeeds] = useState<SeedTokens | undefined>(active && { ...active.seeds });
  const [name, setName] = useState("");
  const [showProblem, setShowProblem] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Choosing another palette in the picker restarts the draft from it.
  if (active && base !== active.id) {
    setBase(active.id);
    setSeeds({ ...active.seeds });
    setConfirmDelete(false);
  }
  if (!active || !seeds) return null;

  const editable = custom.some((p) => p.id === active.id);
  const dirty = SEED_TOKEN_KEYS.some((key) => seeds[key] !== active.seeds[key]);
  const problem = nameProblem(name, palettes);
  const warnings = contrastWarnings(seeds);
  const setSeed = (key: SeedTokenKey, hex: string) => setSeeds({ ...seeds, [key]: hex });

  const saveAs = () => {
    if (problem) {
      setShowProblem(true);
      return;
    }
    const id = customPaletteId(name, new Set(palettes.map((p) => p.id)));
    store.getState().setCustomPalettes([...custom, buildPalette(id, name, seeds)]);
    store.getState().setTheme({ palette: id });
    setName("");
    setShowProblem(false);
  };
  const saveChanges = () =>
    store
      .getState()
      .setCustomPalettes(
        custom.map((p) => (p.id === active.id ? buildPalette(p.id, p.name, seeds) : p)),
      );
  const remove = () => {
    store.getState().setCustomPalettes(custom.filter((p) => p.id !== active.id));
    store.getState().setTheme({ palette: DEFAULT_PALETTE_ID });
  };

  return (
    <section aria-labelledby={`${nameId}-heading`} className="flex flex-col gap-3">
      <h3
        id={`${nameId}-heading`}
        className="font-caption text-xs font-medium tracking-wide text-muted-foreground uppercase"
      >
        Custom palette
      </h3>
      <p className="text-xs text-muted-foreground">
        Starting from {active.name}
        {editable ? "." : " (built in: save your changes as a new palette)."}
      </p>

      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
        <div className="grid content-start gap-2 sm:grid-cols-2">
          {SEED_TOKEN_KEYS.map((key) => (
            <SeedField
              key={key}
              token={key}
              value={seeds[key]}
              onChange={(hex) => setSeed(key, hex)}
            />
          ))}
        </div>

        <div className="flex flex-col gap-3">
          <style>{paletteCss(buildPalette(PREVIEW_ID, "Preview", seeds))}</style>
          <div
            data-palette={PREVIEW_ID}
            data-testid="palette-preview"
            className="flex flex-col gap-2 rounded-lg border border-border bg-background p-3 text-foreground"
          >
            <div className="rounded-md border border-border bg-card p-2">
              <p className="text-sm font-medium">fix-flaky-test</p>
              <p className="text-xs text-muted-foreground">api · fix/flaky · 2 files changed</p>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Button size="xs" tabIndex={-1}>
                Allow
              </Button>
              <span className="text-status-needs">Needs you</span>
              <span className="text-status-working">Working</span>
              <span className="text-success-text">+12</span>
              <span className="text-danger-text">−3</span>
            </div>
            <code className="rounded-md bg-surface-2 p-1.5 font-mono text-xs text-muted-foreground">
              pnpm test retry
            </code>
          </div>

          {warnings.length > 0 && (
            <ul
              aria-label="Contrast warnings"
              className="flex flex-col gap-1 text-xs text-warning-text"
            >
              {warnings.map((w) => (
                <li key={w.label} className="flex items-center gap-1.5">
                  <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
                  {w.label} is {w.ratio.toFixed(1)}:1, below {w.target}:1
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap gap-1.5">
            {editable && (
              <WhyDisabled reason={dirty ? undefined : "Nothing to save: no changes yet."}>
                <Button size="sm" disabled={!dirty} onClick={saveChanges}>
                  Save changes
                </Button>
              </WhyDisabled>
            )}
            <WhyDisabled reason={dirty ? undefined : "Nothing to reset: no changes yet."}>
              <Button
                size="sm"
                variant="ghost"
                disabled={!dirty}
                onClick={() => setSeeds({ ...active.seeds })}
              >
                Reset
              </Button>
            </WhyDisabled>
            {editable &&
              (confirmDelete ? (
                <>
                  <Button size="sm" variant="destructive" onClick={remove}>
                    Confirm delete
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
                  Delete
                </Button>
              ))}
          </div>

          <form
            className="flex flex-col gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              saveAs();
            }}
          >
            <label htmlFor={nameId} className="text-xs text-muted-foreground">
              New palette name
            </label>
            <div className="flex gap-1.5">
              <input
                id={nameId}
                value={name}
                aria-invalid={showProblem && problem !== undefined}
                onChange={(event) => {
                  setName(event.target.value);
                  setShowProblem(false);
                }}
                className="h-8 min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-danger"
              />
              <Button size="sm" variant="outline" type="submit">
                Save as…
              </Button>
            </div>
            {showProblem && problem && (
              <p role="alert" className="text-xs text-danger-text">
                {problem}
              </p>
            )}
          </form>
        </div>
      </div>
    </section>
  );
}

function SeedField({
  token,
  value,
  onChange,
}: {
  token: SeedTokenKey;
  value: string;
  onChange: (hex: string) => void;
}) {
  const id = useId();
  const [text, setText] = useState(value);
  const [shown, setShown] = useState(value);
  // A swatch pick or reset replaces whatever was typed.
  if (shown !== value) {
    setShown(value);
    setText(value);
  }
  const { label, hint } = TOKEN_LABELS[token];

  return (
    <div className="flex items-center gap-2" title={hint}>
      <input
        type="color"
        aria-label={`${label} swatch`}
        value={value}
        onChange={(event) => onChange(normalizeHex(event.target.value))}
        className="size-7 shrink-0 cursor-pointer rounded-md border border-border bg-transparent p-0.5"
      />
      <label htmlFor={id} className="w-20 shrink-0 text-xs">
        {label}
      </label>
      <input
        id={id}
        value={text}
        spellCheck={false}
        aria-invalid={!isHex(text)}
        onChange={(event) => {
          setText(event.target.value);
          if (isHex(event.target.value)) onChange(normalizeHex(event.target.value));
        }}
        className="h-7 min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 font-mono text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-danger"
      />
    </div>
  );
}
