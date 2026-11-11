import { embeddingOn, type Settings } from "@gram/contracts";
import type { ComponentType } from "react";
import { create } from "zustand";

import type {
  ShellContributions,
  ShellNavigationGroup,
  ShellNavigationPlacement,
  ShellPageProps,
  ShellSlotProps,
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
  /** Mounted by an app in front of Gram on a server with hosted features on. Set once, at mount. */
  readonly hosted: boolean;
  /** The page at `/` in place of Gram's home. Set once, at mount. */
  readonly home: ComponentType<ShellPageProps> | undefined;
}

export const useEmbedShell = create<EmbedShellState>()(() => ({
  navigation: [],
  workspaceSwitcher: undefined,
  titles: {},
  threads: "shown",
  hosted: false,
  home: undefined,
}));

/** What the store holds before anything is added, and again after `unmount`. */
export const EMPTY_SHELL: EmbedShellState = {
  navigation: [],
  workspaceSwitcher: undefined,
  titles: {},
  threads: "shown",
  hosted: false,
  home: undefined,
};

/** Whether an app in front of Gram supplies the home page: Gram's first run is then never shown. */
export const useHostHome = () => useEmbedShell((s) => s.home !== undefined);

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

/** A row's count as drawn: a whole number above 0, or nothing. */
export const shownCount = (count: number | undefined): number | undefined =>
  count !== undefined && Number.isFinite(count) && count >= 1 ? Math.floor(count) : undefined;

/** A destination's name with its group's, where it has one: "Govern: Policies". */
export const itemName = (group: ShellNavigationGroup, label: string): string =>
  group.label === undefined || group.label.trim() === "" ? label : `${group.label}: ${label}`;
