import type { Settings } from "@gram/contracts";

import { useServerSettings } from "@/settings-sync/store";

const UI_FALLBACK = "ui-sans-serif, system-ui, sans-serif";
const MONO_FALLBACK = 'ui-monospace, "SF Mono", Menlo, monospace';

/** A single family name is quoted; a list the user typed (with commas or quotes) is kept as is. */
const family = (value: string | undefined, fallback: string): string | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return /[,"']/.test(trimmed) ? trimmed : `"${trimmed}", ${fallback}`;
};

/** The `--font-ui` / `--font-mono` overrides for the fonts setting; `undefined` keeps the look's font. */
export const fontOverrides = (
  fonts: Settings["fonts"] | undefined,
): Readonly<Record<"--font-ui" | "--font-mono", string | undefined>> => ({
  "--font-ui": family(fonts?.ui, UI_FALLBACK),
  "--font-mono": family(fonts?.mono, MONO_FALLBACK),
});

/** Keeps `root`'s inline font variables in step with the fonts setting, over the look's fonts. */
export function startFontOverrides(root: Pick<HTMLElement, "style">): () => void {
  const apply = () => {
    for (const [name, value] of Object.entries(
      fontOverrides(useServerSettings.getState().settings?.fonts),
    )) {
      if (value === undefined) root.style.removeProperty(name);
      else root.style.setProperty(name, value);
    }
  };
  apply();
  return useServerSettings.subscribe(apply);
}
