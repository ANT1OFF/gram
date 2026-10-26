import { useQuery } from "@tanstack/react-query";

import { useFeature } from "./use-diagnostics";

/** Offered for the interface font when there's no desktop bridge to list installed fonts. */
const CURATED_UI_FONTS: readonly string[] = [
  "Geist",
  "Helvetica Neue",
  "IBM Plex Sans",
  "Inter",
  "Segoe UI",
  "system-ui",
];

/** Offered for the monospace font when there's no desktop bridge to list installed fonts. */
export const CURATED_MONO_FONTS: readonly string[] = [
  "Cascadia Code",
  "Consolas",
  "Fira Code",
  "Geist Mono",
  "IBM Plex Mono",
  "JetBrains Mono",
  "Menlo",
  "SF Mono",
];

export interface FontSuggestions {
  readonly ui: readonly string[];
  readonly mono: readonly string[];
  /** The suggestions are this computer's installed families rather than the curated lists. */
  readonly installed: boolean;
}

/** Font families for the font fields: every installed family in the desktop app, a curated list otherwise. */
export function useInstalledFonts(): FontSuggestions {
  const canList = useFeature("fontList");
  const { data } = useQuery({
    queryKey: ["installed-fonts"],
    queryFn: async () => [...((await window.gram?.listFonts?.()) ?? [])],
    enabled: canList,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  return data !== undefined && data.length > 0
    ? { ui: data, mono: data, installed: true }
    : { ui: CURATED_UI_FONTS, mono: CURATED_MONO_FONTS, installed: false };
}
