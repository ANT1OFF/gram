/**
 * Gram's What's New: hand-written highlights for people using the app, not a changelog. Each
 * highlight is its own file, `whats-new/<version>/<slug>.ts`, default-exporting a `WhatsNewItem`, so
 * concurrent changes add files instead of editing one shared list. Highlights sort by slug within a
 * version; versions sort newest first by their `MAJOR.MINOR.PATCH` base.
 *
 * Add a highlight in the change that ships a user-visible feature. When a change reworks or removes
 * a feature already listed for the unreleased version, edit or delete that file instead.
 */

export interface WhatsNewItem {
  readonly title: string;
  /** One or two sentences of plain text; `<kbd>…</kbd>` marks a key, and no other markup is read. */
  readonly body: string;
  /** Shown only on this platform; omit for everything cross-platform. */
  readonly platform?: "darwin" | "win32";
  /** Shown only in this app; omit for every app. */
  readonly shell?: WhatsNewShell;
}

/** The app a release fragment is for. */
export type WhatsNewShell = "desktop";

/** Who is reading: their platform and app, each `undefined` when unknown (a browser in dev). */
export interface WhatsNewAudience {
  readonly platform?: string | undefined;
  readonly shell?: WhatsNewShell | undefined;
}

export interface WhatsNewRelease {
  /** `MAJOR.MINOR.PATCH`. */
  readonly version: string;
  readonly highlights: readonly WhatsNewItem[];
}

const FRAGMENT_PATH = /\/(\d+\.\d+\.\d+)\/([^/]+)\.ts$/;

const versionParts = (version: string): number[] =>
  (version.split("-")[0] ?? "").split(".").map((part) => Number.parseInt(part, 10) || 0);

/** Compares release bases, ignoring any `-prerelease` suffix. */
export function compareVersionBase(a: string, b: string): number {
  const [pa, pb] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

/** Groups fragment modules, keyed by import path, into releases, newest first. */
export function assembleReleases(
  modules: Readonly<Record<string, { readonly default: WhatsNewItem }>>,
): WhatsNewRelease[] {
  const byVersion = new Map<string, { slug: string; item: WhatsNewItem }[]>();
  for (const [path, module] of Object.entries(modules)) {
    const match = FRAGMENT_PATH.exec(path);
    if (!match?.[1] || !match[2]) continue;
    const items = byVersion.get(match[1]) ?? [];
    items.push({ slug: match[2], item: module.default });
    byVersion.set(match[1], items);
  }
  return [...byVersion.entries()]
    .map(([version, items]) => ({
      version,
      highlights: items
        .toSorted((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
        .map(({ item }) => item),
    }))
    .toSorted((a, b) => compareVersionBase(b.version, a.version));
}

/** Highlights for `audience`; everything a part of it is unknown for (browser dev). */
export const highlightsFor = (
  release: WhatsNewRelease,
  { platform, shell }: WhatsNewAudience,
): readonly WhatsNewItem[] =>
  release.highlights.filter(
    (item) =>
      (item.platform === undefined || platform === undefined || item.platform === platform) &&
      (item.shell === undefined || shell === undefined || item.shell === shell),
  );

/** Who is reading, from the desktop bridge; everything unknown without one (a browser in dev). */
export const whatsNewAudience = (
  bridge: { readonly platform: string } | undefined,
): WhatsNewAudience => ({
  platform: bridge?.platform,
  shell: bridge === undefined ? undefined : "desktop",
});

export const WHATS_NEW: readonly WhatsNewRelease[] = assembleReleases(
  import.meta.glob<{ default: WhatsNewItem }>("./*/*.ts", { eager: true }),
);
