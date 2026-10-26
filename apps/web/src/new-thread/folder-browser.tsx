import type { FolderEntry } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { ArrowUp, ChevronRight, CircleAlert, Folder, FolderGit2 } from "lucide-react";
import * as m from "motion/react-m";
import { Fragment, useEffect, useId, useState, type KeyboardEvent } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { folderAccessDenial } from "@/api/folder-access";
import { FolderAccessRecovery } from "@/components/folder-access-recovery";
import { Button } from "@/components/ui/button";
import { Shimmer, usePresetTransition } from "@/motion";

import { folderProblem } from "./fs-errors";
import { GitBadge } from "./git-badge";
import { breadcrumbs, tildify } from "./path";
import { useProjectPickerStore } from "./store";
import { useHome, useIsGitRepo, withTrailingSlash } from "./use-folder";

/**
 * Navigates folders from the picker's `browsePath`: parent, breadcrumb, a keyboard-driven folder
 * list (⏎ or double-click enters, ⌫ goes up), and "Choose this folder".
 */
export function FolderBrowser({ onChoose }: { onChoose: (path: string) => void }) {
  const api = useApi();
  const home = useHome();
  const browsePath = withTrailingSlash(useProjectPickerStore((s) => s.browsePath));
  const browseTo = useProjectPickerStore((s) => s.browseTo);
  const query = useQuery({
    queryKey: ["fs.browse", browsePath],
    queryFn: () => api.browse(browsePath),
    retry: false,
    placeholderData: (previous) => previous,
  });
  const folder = query.status === "error" ? undefined : query.data;
  const denial = query.status === "error" ? folderAccessDenial(query.error) : undefined;
  const isGitRepo = useIsGitRepo(folder);
  const up = () => {
    if (folder?.parent) browseTo(folder.parent);
  };

  return (
    <div className="flex flex-col" data-testid="folder-browser">
      <div className="flex items-center gap-1 border-b border-border p-1.5">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Parent folder"
          disabled={!folder?.parent}
          onClick={up}
        >
          <ArrowUp />
        </Button>
        <nav
          aria-label="Breadcrumb"
          className="flex min-w-0 flex-1 items-center overflow-x-auto text-xs"
        >
          {folder &&
            breadcrumbs(folder.path, home).map((crumb, i, crumbs) => (
              <Fragment key={crumb.path}>
                {i > 0 && <ChevronRight aria-hidden className="size-3 shrink-0 text-subtle" />}
                <button
                  type="button"
                  aria-current={i === crumbs.length - 1 ? "location" : undefined}
                  onClick={() => browseTo(crumb.path)}
                  className="shrink-0 rounded-sm px-1 py-0.5 font-mono text-muted-foreground outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 aria-[current=location]:text-foreground"
                >
                  {crumb.label}
                </button>
              </Fragment>
            ))}
        </nav>
      </div>

      {denial ? (
        <FolderAccessRecovery
          denial={denial}
          message={errorMessage(query.error)}
          retrying={query.isFetching}
          onRetry={() => void query.refetch()}
        />
      ) : query.status === "error" ? (
        <div className="flex items-center gap-2 p-3 text-xs">
          <p role="alert" className="flex items-center gap-1.5 text-danger-text">
            <CircleAlert aria-hidden className="size-3.5 shrink-0" />
            {folderProblem(query.error).message}
          </p>
          <Button type="button" size="xs" variant="ghost" onClick={() => browseTo("~")}>
            Go home
          </Button>
        </div>
      ) : folder ? (
        <FolderList
          key={folder.path}
          folders={folder.entries}
          truncated={folder.truncated}
          onEnter={(entry) => browseTo(entry.path)}
          onUp={up}
        />
      ) : (
        <p className="p-3 text-xs text-muted-foreground">
          <Shimmer>Loading folders…</Shimmer>
        </p>
      )}

      <div className="flex items-center gap-2 border-t border-border p-1.5">
        {folder && (
          <>
            <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
              {tildify(folder.path, home)}
            </span>
            {isGitRepo && <GitBadge />}
          </>
        )}
        <Button
          type="button"
          size="xs"
          className="ml-auto"
          disabled={!folder}
          onClick={() => folder && onChoose(tildify(folder.path, home))}
        >
          Choose this folder
        </Button>
      </div>
    </div>
  );
}

function FolderList({
  folders,
  truncated,
  onEnter,
  onUp,
}: {
  folders: readonly FolderEntry[];
  truncated: boolean;
  onEnter: (entry: FolderEntry) => void;
  onUp: () => void;
}) {
  const listId = useId();
  const [active, setActive] = useState(0);
  const transition = usePresetTransition("gentle");

  useEffect(() => {
    document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, listId]);

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const last = folders.length - 1;
    const moves: Record<string, () => number> = {
      ArrowDown: () => Math.min(active + 1, last),
      ArrowUp: () => Math.max(active - 1, 0),
      Home: () => 0,
      End: () => last,
    };
    const move = moves[event.key];
    if (move && !event.altKey) {
      event.preventDefault();
      if (folders.length > 0) setActive(move());
    } else if (event.key === "Enter") {
      event.preventDefault();
      const entry = folders[active];
      if (entry) onEnter(entry);
    } else if (event.key === "Backspace" || (event.key === "ArrowUp" && event.altKey)) {
      event.preventDefault();
      onUp();
    }
  };

  return (
    <m.ul
      role="listbox"
      aria-label="Folders"
      tabIndex={0}
      aria-activedescendant={folders[active] ? `${listId}-${active}` : undefined}
      initial={{ opacity: 0, x: 8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={transition}
      onKeyDown={onKeyDown}
      className="max-h-72 min-h-24 overflow-y-auto p-1 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
    >
      {folders.length === 0 && (
        <li className="px-2 py-3 text-xs text-muted-foreground">
          No subfolders. Choose this folder or go up.
        </li>
      )}
      {folders.map((entry, i) => (
        <li
          key={entry.path}
          id={`${listId}-${i}`}
          role="option"
          aria-selected={i === active}
          onClick={() => setActive(i)}
          onDoubleClick={() => onEnter(entry)}
          className="flex h-(--space-row) cursor-default items-center gap-2 rounded-md px-2 text-sm aria-selected:bg-accent"
        >
          {entry.isGitRepo ? (
            <FolderGit2 aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <Folder aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
          {entry.isGitRepo && <GitBadge />}
        </li>
      ))}
      {truncated && (
        <li className="px-2 py-1.5 text-xs text-muted-foreground">
          Showing the first {folders.length} folders. Type a name to narrow it down.
        </li>
      )}
    </m.ul>
  );
}
