import {
  TRANSCRIPT_TEXT_SIZE,
  transcriptTextSizeOf,
  transcriptWidthOf,
  type Settings,
  type TranscriptWidth,
} from "@gram/contracts";

import { useServerSettings } from "@/settings-sync/store";

/**
 * The transcript column's widest line for each Transcript width choice. Comfortable is the 48rem
 * column threads always had; Full fills the pane.
 */
export const TRANSCRIPT_MAX_WIDTH: Readonly<Record<TranscriptWidth, string>> = {
  narrow: "40rem",
  comfortable: "48rem",
  wide: "64rem",
  full: "100%",
};

export type ReadingVar = "--transcript-text-size" | "--transcript-scale" | "--transcript-max-width";

/**
 * The CSS variables Settings → Appearance → Reading sets: the transcript's text size, its ratio to
 * the original 14px (which headings and code scale by), and the column's widest line.
 * `undefined` leaves the stylesheet's default, so an unset setting is the original look.
 */
export const readingVars = (reading: {
  readonly textSize?: number | undefined;
  readonly width?: TranscriptWidth | undefined;
}): Readonly<Record<ReadingVar, string | undefined>> => {
  const size = reading.textSize;
  const width = reading.width;
  return {
    "--transcript-text-size": size === undefined ? undefined : `${size}px`,
    "--transcript-scale":
      size === undefined ? undefined : String(size / TRANSCRIPT_TEXT_SIZE.default),
    "--transcript-max-width": width === undefined ? undefined : TRANSCRIPT_MAX_WIDTH[width],
  };
};

/** The reading settings as stored, with their defaults dropped so the stylesheet's apply. */
export const readingOf = (settings: Settings | undefined) => {
  if (settings === undefined) return {};
  const size = transcriptTextSizeOf(settings);
  const width = transcriptWidthOf(settings);
  return {
    ...(size === TRANSCRIPT_TEXT_SIZE.default ? {} : { textSize: size }),
    ...(width === "comfortable" ? {} : { width }),
  };
};

/**
 * Keeps `root`'s inline reading variables in step with the settings, so a change in Settings
 * applies to every open transcript without a reload.
 */
export function startReadingPrefs(root: Pick<HTMLElement, "style">): () => void {
  const apply = () => {
    const vars = readingVars(readingOf(useServerSettings.getState().settings));
    for (const [name, value] of Object.entries(vars)) {
      if (value === undefined) root.style.removeProperty(name);
      else root.style.setProperty(name, value);
    }
  };
  apply();
  return useServerSettings.subscribe(apply);
}
