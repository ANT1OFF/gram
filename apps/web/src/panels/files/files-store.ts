import type { ThreadId } from "@gram/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { useLayoutStore } from "@/stores/layout";

interface ThreadFiles {
  expanded: readonly string[];
  selected: string | undefined;
  /** The files open as tabs, in the order they were opened; `selected` is the one shown. */
  open?: readonly string[] | undefined;
  /** The line the preview highlights, when a search result or a file link opened the file. */
  line: number | undefined;
  /** With `line`, the last line of the highlighted range. */
  end?: number | undefined;
  /** Bumped by every open at a line, so opening the same line again scrolls back to it. */
  reveals?: number | undefined;
}

/** How the Files panel finds files: filtering the tree by name, or searching their contents. */
type FilesMode = "names" | "contents";

export interface FilesSearch {
  readonly query: string;
  readonly regex: boolean;
  readonly caseSensitive: boolean;
}

const EMPTY_SEARCH: FilesSearch = { query: "", regex: false, caseSensitive: false };

/** The file tree's part of the Files panel's height while a file is previewed. */
export const TREE_SHARE = { min: 0.15, max: 0.85, default: 0.4 } as const;

/** Threads whose tree size is kept; the least recently resized go first. */
const SHARE_LIMIT = 100;

/** Open tabs per thread; past it the oldest closes. */
export const OPEN_LIMIT = 12;

/** `open` with `path` added last, unless it's there already; the oldest go past the limit. */
const withOpen = (open: readonly string[] | undefined, path: string | undefined) => {
  const current = open ?? [];
  if (path === undefined || current.includes(path)) return current;
  return [...current, path].slice(-OPEN_LIMIT);
};

export const clampShare = (share: number): number =>
  Number.isFinite(share)
    ? Math.round(Math.min(TREE_SHARE.max, Math.max(TREE_SHARE.min, share)) * 1000) / 1000
    : TREE_SHARE.default;

interface FilesState {
  byThread: Readonly<Record<string, ThreadFiles>>;
  /** Per thread, when resized; others use `TREE_SHARE.default`. */
  treeShare: Readonly<Record<string, number>>;
  showHidden: boolean;
  filter: string;
  mode: FilesMode;
  search: FilesSearch;
  toggle: (threadId: string, path: string) => void;
  select: (threadId: string, path: string | undefined) => void;
  /** Closes `path`'s tab; the tab beside it is shown, or nothing once the last one closes. */
  closeFile: (threadId: string, path: string) => void;
  /** Previews `path` with `line` highlighted. */
  openAt: (threadId: string, path: string, line: number) => void;
  setTreeShare: (threadId: string, share: number) => void;
  setShowHidden: (showHidden: boolean) => void;
  setFilter: (filter: string) => void;
  setMode: (mode: FilesMode) => void;
  setSearch: (patch: Partial<FilesSearch>) => void;
}

const EMPTY: ThreadFiles = { expanded: [], selected: undefined, line: undefined };

/** Persisted tree sizes, clamped, keeping the most recently resized threads. */
const sanitizeShares = (raw: unknown): Record<string, number> => {
  const entries = Object.entries((raw ?? {}) as Record<string, unknown>).flatMap(
    ([threadId, share]) =>
      typeof share === "number" ? [[threadId, clampShare(share)] as const] : [],
  );
  return Object.fromEntries(entries.slice(-SHARE_LIMIT));
};

export const useFilesStore = create<FilesState>()(
  persist(
    (set) => ({
      byThread: {},
      treeShare: {},
      showHidden: false,
      filter: "",
      mode: "names",
      search: EMPTY_SEARCH,
      toggle: (threadId, path) =>
        set((s) => {
          const current = s.byThread[threadId] ?? EMPTY;
          const expanded = current.expanded.includes(path)
            ? current.expanded.filter((p) => p !== path)
            : [...current.expanded, path];
          return { byThread: { ...s.byThread, [threadId]: { ...current, expanded } } };
        }),
      select: (threadId, selected) =>
        set((s) => ({
          byThread: {
            ...s.byThread,
            [threadId]: {
              ...(s.byThread[threadId] ?? EMPTY),
              selected,
              open: withOpen(s.byThread[threadId]?.open, selected),
              line: undefined,
              end: undefined,
            },
          },
        })),
      closeFile: (threadId, path) =>
        set((s) => {
          const current = s.byThread[threadId] ?? EMPTY;
          const open = current.open ?? (current.selected === undefined ? [] : [current.selected]);
          const index = open.indexOf(path);
          const rest = open.filter((p) => p !== path);
          const selected =
            current.selected !== path
              ? current.selected
              : (rest[Math.min(Math.max(index, 0), rest.length - 1)] ?? undefined);
          return {
            byThread: {
              ...s.byThread,
              [threadId]: {
                ...current,
                open: rest,
                selected,
                ...(selected === current.selected ? {} : { line: undefined, end: undefined }),
              },
            },
          };
        }),
      openAt: (threadId, path, line) =>
        set((s) => {
          const current = s.byThread[threadId] ?? EMPTY;
          const reveals = (current.reveals ?? 0) + 1;
          return {
            byThread: {
              ...s.byThread,
              [threadId]: {
                ...current,
                selected: path,
                open: withOpen(current.open, path),
                line,
                end: undefined,
                reveals,
              },
            },
          };
        }),
      setTreeShare: (threadId, share) =>
        set((s) => {
          const { [threadId]: _previous, ...others } = s.treeShare;
          const next = clampShare(share);
          // The default isn't stored, so a reset forgets the thread; re-adding moves it last.
          return {
            treeShare:
              next === TREE_SHARE.default
                ? others
                : sanitizeShares({ ...others, [threadId]: next }),
          };
        }),
      setShowHidden: (showHidden) => set({ showHidden }),
      setFilter: (filter) => set({ filter }),
      setMode: (mode) => set({ mode }),
      setSearch: (patch) => set((s) => ({ search: { ...s.search, ...patch } })),
    }),
    {
      name: "gram.files",
      version: 1,
      // `window`, not `globalThis`: under Node, reading `globalThis.localStorage` warns that it has no
      // backing file, while a missing `window` throws, which zustand takes as no storage.
      storage: createJSONStorage(() => window.localStorage),
      partialize: ({ treeShare }) => ({ treeShare }),
      merge: (persisted, current) => ({
        ...current,
        treeShare: sanitizeShares((persisted as { treeShare?: unknown } | undefined)?.treeShare),
      }),
    },
  ),
);

/**
 * Shows `path` in the Files panel: expands its folders below `root`, selects it and switches the
 * right panel to Files. For links from other panels (e.g. a diff file).
 */
export function revealInFiles(threadId: string, root: string, path: string) {
  const relative = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : undefined;
  if (relative === undefined) return;
  const folders = relative
    .split("/")
    .slice(0, -1)
    .map((_, i, parts) => `${root}/${parts.slice(0, i + 1).join("/")}`);
  useFilesStore.setState((s) => {
    const current = s.byThread[threadId] ?? EMPTY;
    const expanded = [...new Set([...current.expanded, ...folders])];
    return {
      byThread: {
        ...s.byThread,
        [threadId]: {
          expanded,
          selected: path,
          open: withOpen(current.open, path),
          line: undefined,
        },
      },
    };
  });
  useLayoutStore.getState().setPanelTab("files");
}

/**
 * Previews `path`, a file in one of the thread's checkout `roots`, with `line` to `end` highlighted
 * and scrolled to, and brings the right panel up on Files. For a file link in the transcript; a file
 * in the first root has its folders expanded in the tree.
 */
export function showFileAt(
  threadId: ThreadId,
  roots: readonly string[],
  path: string,
  lines: { readonly line?: number | undefined; readonly end?: number | undefined } = {},
) {
  const root = roots[0];
  const relative =
    root !== undefined && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : undefined;
  const folders = (relative ?? "")
    .split("/")
    .slice(0, -1)
    .map((_, i, parts) => `${root}/${parts.slice(0, i + 1).join("/")}`);
  useFilesStore.setState((s) => {
    const current = s.byThread[threadId] ?? EMPTY;
    return {
      byThread: {
        ...s.byThread,
        [threadId]: {
          ...current,
          expanded: [...new Set([...current.expanded, ...folders])],
          selected: path,
          open: withOpen(current.open, path),
          line: lines.line,
          end: lines.line === undefined ? undefined : lines.end,
          reveals: (current.reveals ?? 0) + 1,
        },
      },
    };
  });
  useLayoutStore.getState().requestPanel({ threadId, panel: "files" }, threadId);
}

/**
 * `target` relative to the checkout `root`: a relative path as is (minus a leading `./`), an
 * absolute path only when it's inside `root`. Anything else, including `..` segments, is `undefined`.
 */
export function checkoutRelative(target: string, root: string | undefined): string | undefined {
  const path = target.replaceAll("\\", "/");
  if (root !== undefined) {
    const base = root.replaceAll("\\", "/").replace(/\/+$/, "");
    if (path.startsWith(`${base}/`)) return safeRelative(path.slice(base.length + 1));
  }
  if (path.startsWith("/") || /^[A-Za-z]:\//.test(path)) return undefined;
  return safeRelative(path.replace(/^(\.\/)+/, ""));
}

const safeRelative = (path: string) =>
  path === "" || path.split("/").includes("..") ? undefined : path;

export const resetFilesStore = () =>
  useFilesStore.setState({
    byThread: {},
    treeShare: {},
    showHidden: false,
    filter: "",
    mode: "names",
    search: EMPTY_SEARCH,
  });
