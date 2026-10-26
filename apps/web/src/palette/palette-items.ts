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
  run: () => void;
}

/** The second step of a command that needs a choice: its title and the choices. */
export interface PalettePicker {
  title: string;
  items: PaletteItem[];
}

type PaletteSectionId =
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

const LIMITS = { threads: 8, workers: 6, features: 5, prs: 5, projects: 5 };

/** Go to first: threads, workers, features and PRs, then projects; commands behind `>`. */
export function buildSections(raw: string, sources: PaletteSources): PaletteSection[] {
  const { mode, text } = parsePaletteQuery(raw);
  const found = (items: readonly PaletteItem[] | undefined, limit: number) =>
    matchItems(items ?? [], text).slice(0, limit);
  const sections: PaletteSection[] =
    mode === "actions"
      ? [
          { id: "actions", label: "Commands", items: matchItems(sources.actions, text) },
          // Typed, the thread's and workspace's own commands match too; More… lists them whole.
          { id: "scoped", label: "In view", items: text ? found(sources.scoped, Infinity) : [] },
        ]
      : [
          { id: "threads", label: "Threads", items: found(sources.threads, LIMITS.threads) },
          { id: "workers", label: "Workers", items: found(sources.workers, LIMITS.workers) },
          { id: "features", label: "Features", items: found(sources.features, LIMITS.features) },
          { id: "prs", label: "Pull requests", items: found(sources.prs, LIMITS.prs) },
          { id: "projects", label: "Projects", items: found(sources.projects, LIMITS.projects) },
        ];
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
