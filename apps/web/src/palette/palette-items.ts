import type { Thread } from "@gram/contracts";

import type { PaletteScope } from "@/stores/layout";

export interface PaletteItem {
  id: string;
  label: string;
  /** Where a go-to row points (project, status, repo). Commands carry none: the label says it. */
  hint?: string;
  /** A command's key, shown at the row's end. */
  shortcut?: string;
  /** Extra text matched but not shown (branch, path, …). */
  keywords?: string;
  /** A second line with matched ranges marked, e.g. a message search hit. */
  snippet?: { text: string; highlights?: readonly { start: number; end: number }[] | undefined };
  /** What Tab on the row scopes the palette to: the thread's or workspace's own commands. */
  scope?: PaletteScope;
  /** A choice to make in the palette before anything runs: a layout, a label, a pane. */
  opens?: () => PalettePicker;
  /**
   * Why the command can't run now. It stays listed, dimmed, so the reason can be read: on hover,
   * and as a notice when it is picked.
   */
  unavailable?: string;
  /** Runs without closing the palette: it shows a next step, or another scope. */
  stay?: boolean;
  /** A capped group's last row, which lists the rest of the group in place. */
  more?: boolean;
  run: () => void;
}

/** The second step of a command that needs a choice: its title and the choices. */
export interface PalettePicker {
  title: string;
  items: PaletteItem[];
}

export type PaletteSectionId =
  | "destinations"
  | "filtered"
  | "threads"
  | "workers"
  | "features"
  | "prs"
  | "projects"
  | "messages"
  | "actions"
  | "scoped"
  | "thread"
  | "window"
  | "branch"
  | "pr"
  | "workspace"
  | "pick";

export interface PaletteSection {
  id: PaletteSectionId;
  label: string;
  items: PaletteItem[];
}

export interface PaletteSources {
  /** The places the window goes: the Inbox, Workers, Memory, Quiet, History, Usage, Settings… */
  destinations?: readonly PaletteItem[];
  threads: readonly PaletteItem[];
  /** Threads an orchestrator spawned. */
  workers?: readonly PaletteItem[];
  /** Each workspace's features, by name. */
  features?: readonly PaletteItem[];
  /** Pull requests threads follow. */
  prs?: readonly PaletteItem[];
  projects: readonly PaletteItem[];
  actions: readonly PaletteItem[];
  /** The commands of the thread and workspace in view, matched once something is typed after `>`. */
  scoped?: readonly PaletteItem[];
}

/** What a thread's commands are scoped to: an orchestrator stands for its workspace. */
export const threadScope = (thread: Thread): PaletteScope =>
  thread.role === "orchestrator" && thread.workspaceId !== undefined
    ? { kind: "workspace", workspaceId: thread.workspaceId }
    : { kind: "thread", threadId: thread.id };

/** A leading `>` switches the palette to actions. */
export function parsePaletteQuery(raw: string): { mode: "search" | "actions"; text: string } {
  return raw.startsWith(">")
    ? { mode: "actions", text: raw.slice(1).trim() }
    : { mode: "search", text: raw.trim() };
}

/** Case-insensitive: label prefix, then label substring, then hint/keyword substring. */
export function matchItems(items: readonly PaletteItem[], text: string): PaletteItem[] {
  const q = text.toLowerCase();
  if (!q) return [...items];
  return items
    .flatMap((item, index) => {
      const label = item.label.toLowerCase();
      const extra = `${item.hint ?? ""} ${item.keywords ?? ""}`.toLowerCase();
      const score = label.startsWith(q) ? 0 : label.includes(q) ? 1 : extra.includes(q) ? 2 : -1;
      return score === -1 ? [] : [{ item, score, index }];
    })
    .toSorted((a, b) => a.score - b.score || a.index - b.index)
    .map((m) => m.item);
}

/** What the palette lists, by the filter under its field; a leading `>` is Actions too. */
export type PaletteKind = "all" | "threads" | "workers" | "actions";

/** The filters under the field, in order. */
export const PALETTE_KINDS: readonly { kind: PaletteKind; label: string }[] = [
  { kind: "all", label: "All" },
  { kind: "threads", label: "Threads" },
  { kind: "workers", label: "Workers" },
  { kind: "actions", label: "Actions" },
];

/** The filter in effect: a leading `>` lists actions whatever is picked. */
export const effectiveKind = (raw: string, kind: PaletteKind): PaletteKind =>
  raw.startsWith(">") ? "actions" : kind;

export interface PaletteView {
  kind: PaletteKind;
  /** Destination ids, the most recently gone to first. */
  recent: readonly string[];
  /** The groups the user opened in full with Show more. */
  expanded: ReadonlySet<string>;
  /** Opens a group in full, from its Show more row. */
  expand: (section: PaletteSectionId) => void;
}

const ALL_VIEW: PaletteView = { kind: "all", recent: [], expanded: new Set(), expand: () => {} };

/**
 * How many rows each group shows before its Show more. Unfiltered, the palette opens short enough to
 * fit a 1440 × 900 window: destinations, recent ones first, and the latest threads and workers;
 * typed, more of each kind; one kind picked, a longer list of it.
 */
export const PALETTE_CAPS = {
  idle: { destinations: 4, threads: 3, workers: 3, commands: 8 },
  typed: { destinations: 4, threads: 6, workers: 5, features: 4, prs: 4, projects: 4 },
  kind: 12,
} as const;

/**
 * Destinations in recent-first order: those gone to lately, marked Recent, then the rest, the
 * suggested ones, as given.
 */
export const byRecent = (
  items: readonly PaletteItem[],
  recent: readonly string[],
): PaletteItem[] => {
  const rank = (item: PaletteItem) => {
    const at = recent.indexOf(item.id);
    return at === -1 ? recent.length : at;
  };
  return items
    .map((item, index) => ({ item, index }))
    .toSorted((a, b) => rank(a.item) - rank(b.item) || a.index - b.index)
    .map(({ item }) => (recent.includes(item.id) ? { ...item, hint: "Recent" } : item));
};

/**
 * Go to first, commands behind `>` or the Actions filter. Unfiltered: destinations, the recent ones
 * first and then the suggested (Workers, Memory, Quiet…), then the latest threads and workers, each
 * group capped with a Show more row that lists the rest in place. Typed: destinations, threads, workers,
 * features, PRs and projects that match, capped the same way.
 */
export function buildSections(
  raw: string,
  sources: PaletteSources,
  view: PaletteView = ALL_VIEW,
): PaletteSection[] {
  const { text } = parsePaletteQuery(raw);
  const kind = effectiveKind(raw, view.kind);
  const capped = (id: PaletteSectionId, label: string, items: PaletteItem[], cap: number) => {
    const section: PaletteSection = { id, label, items };
    if (view.expanded.has(id) || items.length <= cap + 1) return section;
    const rest = items.length - cap;
    return {
      ...section,
      items: [
        ...items.slice(0, cap),
        {
          id: `more:${id}`,
          label: `Show ${rest} more`,
          more: true,
          stay: true,
          run: () => view.expand(id),
        },
      ],
    };
  };
  const found = (items: readonly PaletteItem[] | undefined) => matchItems(items ?? [], text);
  const destinations = byRecent(sources.destinations ?? [], view.recent);
  let sections: PaletteSection[];
  if (kind === "actions") {
    sections = [
      { id: "destinations", label: "Go to", items: found(destinations) },
      capped(
        "actions",
        "Commands",
        found(sources.actions),
        text ? Infinity : PALETTE_CAPS.idle.commands,
      ),
      // Typed, the thread's and workspace's own commands match too; More… lists them whole.
      { id: "scoped", label: "In view", items: text ? found(sources.scoped) : [] },
    ];
  } else if (kind === "threads") {
    sections = [capped("threads", "Threads", found(sources.threads), PALETTE_CAPS.kind)];
  } else if (kind === "workers") {
    sections = [capped("workers", "Workers", found(sources.workers), PALETTE_CAPS.kind)];
  } else if (!text) {
    const idle = PALETTE_CAPS.idle;
    sections = [
      capped("destinations", "Go to", destinations, idle.destinations),
      capped("threads", "Threads", [...(sources.threads ?? [])], idle.threads),
      capped("workers", "Workers", [...(sources.workers ?? [])], idle.workers),
    ];
  } else {
    const typed = PALETTE_CAPS.typed;
    sections = [
      capped("destinations", "Go to", found(destinations), typed.destinations),
      capped("threads", "Threads", found(sources.threads), typed.threads),
      capped("workers", "Workers", found(sources.workers), typed.workers),
      capped("features", "Features", found(sources.features), typed.features),
      capped("prs", "Pull requests", found(sources.prs), typed.prs),
      capped("projects", "Projects", found(sources.projects), typed.projects),
    ];
  }
  return sections.filter((s) => s.items.length > 0);
}

/** A scoped palette: the scope's own sections, filtered by what is typed, `>` or not. */
export function buildScopedSections(
  raw: string,
  sections: readonly PaletteSection[],
): PaletteSection[] {
  const text = raw.replace(/^>/, "").trim();
  return sections
    .map((section) => ({ ...section, items: matchItems(section.items, text) }))
    .filter((s) => s.items.length > 0);
}

export const flattenSections = (sections: readonly PaletteSection[]): PaletteItem[] =>
  sections.flatMap((s) => s.items);
