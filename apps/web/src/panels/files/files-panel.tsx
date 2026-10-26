import { effectiveCheckout, type ThreadId } from "@gram/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { folderAccessDenial } from "@/api/folder-access";
import { FolderAccessRecovery } from "@/components/folder-access-recovery";
import { Button } from "@/components/ui/button";
import { focusIfConnected, focusLost } from "@/lib/use-return-focus";
import { cn } from "@/lib/utils";
import { PanelMessage } from "@/panels/panel-message";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { isAbsoluteRef, mayBeInRoots } from "@/thread/file-refs";

import { FilePreview } from "./file-preview";
import { FileTabs } from "./file-tabs";
import { FileTree, filesQueryKey } from "./file-tree";
import { FilesSearchResults } from "./files-search";
import {
  checkoutRelative,
  revealInFiles,
  showFileAt,
  TREE_SHARE,
  useFilesStore,
} from "./files-store";
import { filesProblem } from "./files-problem";
import { SplitHandle } from "./split-handle";

const inputCls =
  "h-7 w-full rounded-md border border-input bg-transparent ps-7 pe-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** Typed first in the find box, it searches the files' contents instead of filtering by name. */
const CONTENTS_PREFIX = "?";

/** From this width the tree sits beside the preview instead of above it. */
export const SIDE_BY_SIDE_MIN = 720;

/**
 * An element's width as it resizes, and the ref that names the element: a callback, since the
 * panel's body only mounts once the thread has loaded.
 */
function useWidth<T extends HTMLElement>(ref: RefObject<T | null>) {
  const [element, setElement] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  const attach = useCallback(
    (node: T | null) => {
      ref.current = node;
      setElement(node);
    },
    [ref],
  );
  return [width, attach] as const;
}

/**
 * The thread checkout's files and a preview of the open ones, as tabs: the tree above the preview,
 * or beside it once the panel is wide. One box filters the tree by name, or with a leading `?`
 * searches contents and opens the file at the matching line. An agent's files target is revealed
 * and previewed.
 */
export function FilesPanel({
  threadId,
  root: rootOverride,
}: {
  threadId: ThreadId;
  root?: string;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const thread = useThreadsStore((s) => s.byId[threadId]?.thread);
  const threadRoot = thread === undefined ? undefined : effectiveCheckout(thread).path;
  const root = rootOverride ?? threadRoot;
  const extraRoots = useThreadsStore((s) => s.byId[threadId]?.thread.extraCheckouts);
  const showHidden = useFilesStore((s) => s.showHidden);
  const filter = useFilesStore((s) => s.filter);
  const mode = useFilesStore((s) => s.mode);
  const search = useFilesStore((s) => s.search);
  const selected = useFilesStore((s) => s.byThread[threadId]?.selected);
  const line = useFilesStore((s) => s.byThread[threadId]?.line);
  const end = useFilesStore((s) => s.byThread[threadId]?.end);
  const reveals = useFilesStore((s) => s.byThread[threadId]?.reveals);
  const setShowHidden = useFilesStore((s) => s.setShowHidden);
  const setFilter = useFilesStore((s) => s.setFilter);
  const setMode = useFilesStore((s) => s.setMode);
  const setSearch = useFilesStore((s) => s.setSearch);
  const open = useFilesStore((s) => s.byThread[threadId]?.open);
  const select = useFilesStore((s) => s.select);
  const closeFile = useFilesStore((s) => s.closeFile);
  const openAt = useFilesStore((s) => s.openAt);
  const share = useFilesStore((s) => s.treeShare[threadId] ?? TREE_SHARE.default);
  const setTreeShare = useFilesStore((s) => s.setTreeShare);
  const bodyRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [bodyWidth, attachBody] = useWidth(bodyRef);
  const wide = bodyWidth >= SIDE_BY_SIDE_MIN;
  const rootQuery = useQuery({
    queryKey: filesQueryKey(threadId, root ?? "", showHidden),
    queryFn: () => api.fsList(root!, { threadId, showHidden }),
    enabled: root !== undefined,
    retry: false,
  });
  const request = useLayoutStore((s) => s.panelTargets.files);
  const consumePanelTarget = useLayoutStore((s) => s.consumePanelTarget);

  useEffect(() => {
    if (!request || request.threadId !== threadId || root === undefined) return;
    const relative = checkoutRelative(request.target, root);
    if (relative !== undefined) revealInFiles(threadId, root, `${root}/${relative}`);
    // A file elsewhere, such as a report in a temp folder, previews on its own; the server decides
    // whether the thread may see it.
    else if (isAbsoluteRef(request.target)) showFileAt(threadId, [root], request.target);
    consumePanelTarget("files", request.id);
  }, [request, threadId, root, consumePanelTarget]);

  if (root === undefined) return <PanelMessage loading>Loading the thread…</PanelMessage>;
  const previewRoot =
    selected === undefined
      ? root
      : (extraRoots?.find((extra) => selected.startsWith(`${extra.path}/`))?.path ?? root);
  const contents = mode === "contents";
  const rootDenial = rootQuery.status === "error" ? folderAccessDenial(rootQuery.error) : undefined;

  const tabs =
    selected === undefined || open?.includes(selected) ? (open ?? []) : [...(open ?? []), selected];
  const side = wide && selected !== undefined;

  const onFind = (value: string) => {
    if (value.startsWith(CONTENTS_PREFIX)) {
      if (!contents) setMode("contents");
      setSearch({ query: value.slice(CONTENTS_PREFIX.length) });
      return;
    }
    if (contents) {
      setMode("names");
      setSearch({ query: "" });
    }
    setFilter(value);
  };

  const closeTab = (path: string) => {
    closeFile(threadId, path);
    if (tabs.some((tab) => tab !== path)) return;
    // The last tab closed: back to the file's row, where the preview was opened from.
    setTimeout(() => {
      if (!focusLost()) return;
      const items = bodyRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]');
      focusIfConnected([...(items ?? [])].find((item) => item.dataset["path"] === path));
    }, 0);
  };

  return (
    <div data-testid="files-panel" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-border p-1.5">
        <label className="relative min-w-0 flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute inset-y-0 start-2 my-auto size-3.5 text-muted-foreground"
          />
          <input
            ref={searchRef}
            aria-label={contents ? "Search in files" : "Filter files"}
            placeholder={`Filter, or ${CONTENTS_PREFIX} to search in files`}
            spellCheck={false}
            value={contents ? `${CONTENTS_PREFIX}${search.query}` : filter}
            onChange={(event) => onFind(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && (contents || filter)) {
                event.preventDefault();
                event.stopPropagation();
                onFind("");
                return;
              }
              if (event.key !== "ArrowDown") return;
              const first = contents
                ? bodyRef.current?.querySelector<HTMLElement>("[data-search-result][tabindex='0']")
                : (bodyRef.current?.querySelector<HTMLElement>(
                    '[role="tree"] [role="treeitem"][tabindex="0"]',
                  ) ??
                  bodyRef.current?.querySelector<HTMLElement>('[role="tree"] [role="treeitem"]'));
              if (!first) return;
              event.preventDefault();
              first.focus();
            }}
            className={cn(inputCls, contents && "font-mono")}
          />
        </label>
        {contents && (
          <>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-pressed={search.regex}
              aria-label="Regular expression"
              title="Regular expression"
              className="font-mono aria-pressed:bg-muted"
              onClick={() => setSearch({ regex: !search.regex })}
            >
              .*
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-pressed={search.caseSensitive}
              aria-label="Match case"
              title="Match case"
              className="aria-pressed:bg-muted"
              onClick={() => setSearch({ caseSensitive: !search.caseSensitive })}
            >
              Aa
            </Button>
          </>
        )}
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-pressed={showHidden}
          aria-label="Show hidden & ignored"
          title={showHidden ? "Hide hidden & ignored files" : "Show hidden & ignored files"}
          className="aria-pressed:bg-muted"
          onClick={() => setShowHidden(!showHidden)}
        >
          {showHidden ? <Eye /> : <EyeOff />}
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Refresh files"
          title="Refresh files"
          onClick={() => {
            void queryClient.invalidateQueries({ queryKey: ["fs.list", threadId] });
            void queryClient.invalidateQueries({ queryKey: ["fs.search", threadId] });
          }}
        >
          <RefreshCw />
        </Button>
      </div>

      <div ref={attachBody} className={cn("flex min-h-0 flex-1", side ? "flex-row" : "flex-col")}>
        {rootDenial ? (
          <FolderAccessRecovery
            denial={rootDenial}
            message={errorMessage(rootQuery.error)}
            retrying={rootQuery.isFetching}
            onRetry={() => void rootQuery.refetch()}
          />
        ) : rootQuery.status === "error" ? (
          <PanelMessage>{filesProblem(rootQuery.error)}</PanelMessage>
        ) : (
          <div
            data-testid="files-tree-pane"
            className={cn("min-h-0 overflow-y-auto", selected ? "shrink-0" : "flex-1")}
            style={
              selected === undefined
                ? undefined
                : side
                  ? { width: `${share * 100}%` }
                  : { height: `${share * 100}%` }
            }
          >
            {contents ? (
              <FilesSearchResults
                threadId={threadId}
                search={search}
                onOpen={(match) => openAt(threadId, match.path, match.line)}
                onExit={() => searchRef.current?.focus()}
              />
            ) : (
              <FileTree threadId={threadId} root={root} />
            )}
          </div>
        )}

        {selected && (
          <>
            <SplitHandle
              share={share}
              orientation={side ? "vertical" : "horizontal"}
              container={() => bodyRef.current}
              onResize={(next) => setTreeShare(threadId, next)}
            />
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <FileTabs
                open={tabs}
                selected={selected}
                root={root}
                onSelect={(path) => select(threadId, path)}
                onClose={closeTab}
              />
              <FilePreview
                key={selected}
                threadId={threadId}
                // A file link can open a file in a multi-repo worker's other worktree, or one
                // elsewhere on disk.
                root={previewRoot}
                elsewhere={!mayBeInRoots(selected, [previewRoot])}
                path={selected}
                line={line}
                end={end}
                reveals={reveals}
                onClose={() => closeTab(selected)}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
