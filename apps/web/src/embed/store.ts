import { embeddingOn, type Settings } from "@gram/contracts";
import type { ComponentType } from "react";
import { create } from "zustand";

import type { ShellContributions, ShellNavigationGroup, ShellSlotProps } from "./contract";

/**
 * What an app in front of Gram added to the shell (`mountGram`). Empty on Gram's own: every slot
 * that reads it then draws nothing, and the app is as it is without this.
 */
export interface EmbedShellState {
  readonly navigation: readonly ShellNavigationGroup[];
  readonly workspaceSwitcher: ComponentType<ShellSlotProps> | undefined;
  /** The added pages' names, by their path as the router has it. Set once, at mount. */
  readonly titles: Readonly<Record<string, string>>;
}

export const useEmbedShell = create<EmbedShellState>()(() => ({
  navigation: [],
  workspaceSwitcher: undefined,
  titles: {},
}));

/**
 * What a mount takes of `shell`: all of it from a server whose hosted features are on, and nothing
 * from any other, where the app stays exactly as it is on its own.
 */
export const shellFor = (settings: Settings, shell: ShellContributions | undefined) =>
  embeddingOn(settings) ? (shell ?? {}) : {};

/** The first segment of each path Gram has itself: an added page may not take one. */
const OWN = new Set(["", "t", "w", "new", "new-task", "new-workspace", "settings", "usage"]);

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
