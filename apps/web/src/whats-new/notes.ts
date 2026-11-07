import { assembleReleases, type WhatsNewItem, type WhatsNewRelease } from "./index";

/** Every release's highlights, newest first: each `<version>/<slug>.ts` fragment. */
export const WHATS_NEW: readonly WhatsNewRelease[] = assembleReleases(
  import.meta.glob<{ default: WhatsNewItem }>("./*/*.ts", { eager: true }),
);
