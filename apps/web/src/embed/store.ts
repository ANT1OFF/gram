import { embeddingOn, type Settings } from "@gram/contracts";
import type { ComponentType } from "react";
import { create } from "zustand";

import type {
  ShellAttention,
  ShellContributions,
  ShellDocument,
  ShellNavigationGroup,
  ShellNavigationItem,
  ShellNavigationPlacement,
  ShellNewEntry,
  ShellPageProps,
  ShellPanel,
  ShellRepositories,
  ShellSidebar,
  ShellSlotProps,
  ShellMachines,
  ShellModels,
  ShellThreadsPage,
  ShellToolCard,
  ShellToolCardProps,
} from "./contract";

/**
 * What an app in front of Gram added to the shell (`mountGram`). Empty on Gram's own: every slot
 * that reads it then draws nothing, and the app is as it is without this.
 */
export interface EmbedShellState {
  readonly navigation: readonly ShellNavigationGroup[];
  readonly workspaceSwitcher: ComponentType<ShellSlotProps> | undefined;
  /** The added pages' names, by their path as the router has it. Set once, at mount. */
  readonly titles: Readonly<Record<string, string>>;
  /** Whether the sidebar lists Gram's workspaces and threads. */
  readonly threads: "shown" | "hidden";
  /** Where the right panel and its toggle are offered: everywhere, on Gram's own. */
  readonly panel: ShellPanel;
  /** What needs someone, as the embedding app counts it; Gram's own count while undefined. */
  readonly attention: ShellAttention | undefined;
  /** The page of every thread, as the embedding app words it; Gram's own words while empty. */
  readonly threadsPage: ShellThreadsPage;
  readonly machines: ShellMachines;
  /** The prompt box's model list as the embedding app narrows it; every model while empty. */
  readonly models: ShellModels;
  /** What New starts in place of Gram's menu; the menu while undefined. */
  readonly newEntry: ShellNewEntry | undefined;
  /** Mounted by an app in front of Gram on a server with hosted features on. Set once, at mount. */
  readonly hosted: boolean;
  /** The page at `/` in place of Gram's home. Set once, at mount. */
  readonly home: ComponentType<ShellPageProps> | undefined;
  /** The open sidebar's look, its head and its account. */
  readonly sidebar: ShellSidebar;
  /** The embedding app's cards under its own tools' calls. Set once, at mount. */
  readonly toolCards: readonly ShellToolCard[];
  /** The browser tab's title; Gram's own while empty. */
  readonly document: ShellDocument;
  /** Where "Add repository" lists repositories; the server's `gh` listing while undefined. */
  readonly repositories: ShellRepositories | undefined;
}

export const useEmbedShell = create<EmbedShellState>()(() => ({
  navigation: [],
  workspaceSwitcher: undefined,
  titles: {},
  threads: "shown",
  panel: "shown",
  hosted: false,
  attention: undefined,
  threadsPage: {},
  machines: {},
  models: {},
  newEntry: undefined,
  home: undefined,
  sidebar: {},
  toolCards: [],
  document: {},
  repositories: undefined,
}));

/** What the store holds before anything is added, and again after `unmount`. */
export const EMPTY_SHELL: EmbedShellState = {
  navigation: [],
  workspaceSwitcher: undefined,
  titles: {},
  threads: "shown",
  panel: "shown",
  hosted: false,
  attention: undefined,
  threadsPage: {},
  machines: {},
  models: {},
  newEntry: undefined,
  home: undefined,
  sidebar: {},
  toolCards: [],
  document: {},
  repositories: undefined,
};

/** Whether the open sidebar is drawn in the embedding app's `roomy` look: never on Gram's own. */
export const useRoomySidebar = () => useEmbedShell((s) => s.sidebar.look === "roomy");

/** Whether an app in front of Gram supplies the home page: Gram's first run is then never shown. */
export const useHostHome = () => useEmbedShell((s) => s.home !== undefined);

/**
 * Whether the right panel is offered on a page: everywhere on Gram's own; under `panel: "code"`,
 * only on a thread in view that works in a git repository.
 */
export const panelOffered = (
  panel: ShellPanel,
  page: { readonly threadInView: boolean; readonly threadInRepo: boolean },
): boolean => panel === "shown" || (page.threadInView && page.threadInRepo);

/** Whether `name` is one of the tools `pattern` is for: `*` stands for any run of characters. */
export const toolMatches = (pattern: string, name: string): boolean => {
  if (!pattern.includes("*")) return pattern === name;
  const parts = pattern.split("*");
  let at = 0;
  for (const [index, part] of parts.entries()) {
    if (index === 0) {
      if (!name.startsWith(part)) return false;
      at = part.length;
    } else if (index === parts.length - 1) {
      return name.length - part.length >= at && name.endsWith(part);
    } else {
      const found = name.indexOf(part, at);
      if (found === -1) return false;
      at = found + part.length;
    }
  }
  return true;
};

/** The embedding app's card for a tool, the first that matches its name; none on Gram's own. */
export const toolCardFor = (
  cards: readonly ShellToolCard[],
  name: string,
): ComponentType<ShellToolCardProps> | undefined =>
  cards.find((card) => toolMatches(card.tool, name))?.component;

export const useHostToolCard = (name: string) =>
  useEmbedShell((s) => toolCardFor(s.toolCards, name));

/** The name of the page of every thread: "Threads", unless the embedding app gave another. */
export const useThreadsTitle = () => useEmbedShell((s) => s.threadsPage.title ?? "Threads");
/**
 * The embedding app's word for a thread in no workspace, wherever one is named: the page of every
 * thread, the New form's choice and a thread's header. Undefined on Gram's own, which says Solo
 * and, in the New form, Chat.
 */
export const useSoloWord = () => useEmbedShell((s) => s.threadsPage.kinds?.solo);

/** The New form's Who does it as the embedding app narrows and words it: undefined on Gram's own. */
export const useNewForm = () => useEmbedShell((s) => s.threadsPage.newForm);

/** Whether the sidebar lists Gram's own workspaces and threads: always, on Gram's own. */
export const useThreadsListed = () => useEmbedShell((s) => s.threads === "shown");

/**
 * What a mount takes of `shell`: all of it from a server whose hosted features are on, and nothing
 * from any other, where the app stays exactly as it is on its own.
 */
export const shellFor = (settings: Settings, shell: ShellContributions | undefined) =>
  embeddingOn(settings) ? (shell ?? {}) : {};

/** The first segment of each path Gram has itself: an added page may not take one. */
const OWN = new Set([
  "",
  "t",
  "w",
  "new",
  "new-task",
  "new-workspace",
  "settings",
  "threads",
  "usage",
]);

/**
 * Why `path` can't be an added page's, or undefined when it can: it must be a path of its own,
 * outside Gram's, and no two pages may share one.
 */
export const routeProblem = (path: string, taken: ReadonlySet<string>): string | undefined => {
  if (!path.startsWith("/") || path.startsWith("//") || /[?#\s]/.test(path))
    return `"${path}" is not a path under the app`;
  const first = path.split("/")[1] ?? "";
  if (OWN.has(first)) return `"${path}" is one of Gram's own paths`;
  if (taken.has(path)) return `"${path}" is added twice`;
  return undefined;
};

/** Whether the window at `pathname` is at `to` or on a page under it. */
export const navigationCurrent = (pathname: string, to: string): boolean =>
  pathname === to || (to !== "/" && pathname.startsWith(`${to}/`));

/**
 * The destination the window is at, among `items`: the one whose `to` it is at or under, or else
 * the first that lists where it is in `alsoAt`. Its `to`, or undefined at none.
 */
export const currentDestination = (
  pathname: string,
  items: readonly Pick<ShellNavigationItem, "to" | "alsoAt">[],
): string | undefined =>
  (
    items.find((item) => navigationCurrent(pathname, item.to)) ??
    items.find((item) => item.alsoAt?.some((path) => navigationCurrent(pathname, path)))
  )?.to;

/** The groups worth showing: each with a destination, ids told apart, empty ones left out. */
export const shownNavigation = (
  groups: readonly ShellNavigationGroup[],
): readonly ShellNavigationGroup[] => {
  const seen = new Set<string>();
  return groups.flatMap((group) => {
    if (seen.has(group.id) || group.items.length === 0) return [];
    seen.add(group.id);
    const ids = new Set<string>();
    const items = group.items.filter((item) => {
      if (ids.has(item.id) || !item.to.startsWith("/")) return false;
      ids.add(item.id);
      return true;
    });
    return items.length === 0 ? [] : [{ ...group, items }];
  });
};

/** The shown groups listed at `placement` in the sidebar; a group that names none is at the foot. */
export const navigationAt = (
  groups: readonly ShellNavigationGroup[],
  placement: ShellNavigationPlacement,
): readonly ShellNavigationGroup[] =>
  shownNavigation(groups).filter((group) => (group.placement ?? "foot") === placement);

/** Whether a group's heading opens and closes its rows: asked for, and with a heading to do it. */
export const foldable = (group: ShellNavigationGroup): boolean =>
  group.collapsible === true && group.label !== undefined && group.label.trim() !== "";

/**
 * Whether a group's rows are open: always, unless it folds; then as the person last left it, or
 * as the embedding app starts it.
 */
export const groupOpen = (group: ShellNavigationGroup, kept: boolean | undefined): boolean =>
  !foldable(group) || (kept ?? group.collapsed !== true);

/**
 * The rows a group shows: all of them while open; closed, only the row the window is at, so the
 * place stays in sight.
 */
export const shownRows = (
  group: ShellNavigationGroup,
  open: boolean,
  at: string | undefined,
): readonly ShellNavigationItem[] =>
  open ? group.items : group.items.filter((item) => item.to === at);

/** What a closed group's heading counts: the sum of its hidden rows' counts, or nothing. */
export const hiddenCount = (
  group: ShellNavigationGroup,
  open: boolean,
  at: string | undefined,
): number | undefined =>
  open
    ? undefined
    : shownCount(
        group.items
          .filter((item) => item.to !== at)
          .reduce((sum, item) => sum + (shownCount(item.count) ?? 0), 0),
      );

/** A row's count as drawn: a whole number above 0, or nothing. */
export const shownCount = (count: number | undefined): number | undefined =>
  count !== undefined && Number.isFinite(count) && count >= 1 ? Math.floor(count) : undefined;

/** A destination's name with its group's, where it has one: "Govern: Policies". */
export const itemName = (group: ShellNavigationGroup, label: string): string =>
  group.label === undefined || group.label.trim() === "" ? label : `${group.label}: ${label}`;

/** What a machine started on demand is called here: the embedding app's word, or "machine". */
export const useMachineNoun = () =>
  useEmbedShell((s) => {
    const noun = s.machines.noun?.trim().toLowerCase();
    return noun !== undefined && /^[a-z][a-z -]{0,30}$/.test(noun) ? noun : "machine";
  });

/** Whether a machine started on demand reaches every repository of the person's, unasked. */
export const useMachineReachesTheirs = () =>
  useEmbedShell((s) => s.machines.repositories === "theirs");

/** The deployment's lines about a machine started on demand, at most five, each kept short. */
export const useMachineFacts = () =>
  useEmbedShell((s) => s.machines.facts)
    ?.slice(0, 5)
    .filter((each) => each.length <= 120) ?? [];
