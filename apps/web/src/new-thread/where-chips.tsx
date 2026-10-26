import { Popover } from "@base-ui/react/popover";
import type { Project } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Folder, FolderSearch, GitBranch } from "lucide-react";
import { useState } from "react";

import { useApi } from "@/api/context";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DEFAULT_BASE } from "@/composer/worktree-fields";
import { cn } from "@/lib/utils";

import { baseName, tildify } from "./path";
import { useHome } from "./use-folder";

const CHIP =
  "flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-border bg-card px-2 text-xs outline-none";
const FOCUS = "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export interface WhereChipsProps {
  /** The chosen folder; empty until one resolves. */
  folder: string;
  /** Recent and bookmarked projects, most useful first. */
  projects: readonly Project[];
  onPickFolder: (root: string) => void;
  /** Hands over to the full project picker for a folder that isn't a recent one. */
  onBrowse: () => void;
  /** The repository worktrees branch from; empty when the folder isn't one. */
  repoPath: string;
  /** The thread gets a worktree (new or existing) instead of running in the folder itself. */
  worktree: boolean;
  onWorktree: (next: boolean) => void;
  /** The base a new worktree starts from, or `undefined` when an existing worktree is chosen. */
  base: string | undefined;
  onBase: (next: string) => void;
  /** Whether the folder chip leads the row; the hero `/new` puts it in its headline instead. */
  showFolder?: boolean;
}

/**
 * Where the new thread runs, as a row of chips above the prompt: the folder with the recent
 * projects one click away, the branch a new worktree starts from, and whether it gets a worktree at
 * all. The Project and Checkout sections below stay the full controls; these drive the same state.
 */
export function WhereChips({
  folder,
  projects,
  onPickFolder,
  onBrowse,
  repoPath,
  worktree,
  onWorktree,
  base,
  onBase,
  showFolder = true,
}: WhereChipsProps) {
  const api = useApi();
  const { data: branches } = useQuery({
    queryKey: ["branches", repoPath],
    queryFn: () => api.branches(repoPath),
    enabled: repoPath !== "",
  });
  const defaultLabel = branches?.default ?? "default branch";
  const isRepo = repoPath !== "";

  return (
    <div data-testid="where-chips" className="flex flex-wrap items-center gap-1.5">
      {showFolder && (
        <FolderPicker
          folder={folder}
          projects={projects}
          onPickFolder={onPickFolder}
          onBrowse={onBrowse}
        />
      )}

      {isRepo && (
        <div className={cn(CHIP, "gap-0 p-0")}>
          {worktree && base !== undefined && (
            <Select
              value={base}
              items={[
                { value: DEFAULT_BASE, label: defaultLabel },
                ...(branches?.branches ?? []).map((name) => ({ value: name, label: name })),
              ]}
              onValueChange={(next) => {
                if (next !== null) onBase(next);
              }}
            >
              <SelectTrigger
                aria-label="Start from"
                className="h-full gap-1.5 rounded-r-none border-0 border-r border-border bg-transparent px-2 font-mono text-xs shadow-none"
              >
                <GitBranch aria-hidden className="size-3.5 text-muted-foreground" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_BASE}>{defaultLabel}</SelectItem>
                {(branches?.branches ?? []).map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <label className="flex h-full cursor-pointer items-center gap-1.5 px-2">
            <input
              type="checkbox"
              className="size-3.5 accent-primary"
              checked={worktree}
              onChange={(event) => onWorktree(event.target.checked)}
            />
            worktree
          </label>
        </div>
      )}
    </div>
  );
}

/**
 * The folder the new thread runs in, with the recent projects one click away and the full picker
 * behind "Another folder…". A chip in the row, or `inline`, a word in the hero's headline.
 */
export function FolderPicker({
  folder,
  projects,
  onPickFolder,
  onBrowse,
  inline = false,
}: Pick<WhereChipsProps, "folder" | "projects" | "onPickFolder" | "onBrowse"> & {
  inline?: boolean;
}) {
  const home = useHome();
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      {inline ? (
        // Read as part of the headline ("…build in api?"), so its name is the folder's.
        <Popover.Trigger
          data-testid="where-folder"
          aria-description="Folder"
          title={folder === "" ? "Choose a folder" : `${tildify(folder, home)} · choose another`}
          className="rounded-sm underline decoration-muted-foreground/60 decoration-dotted decoration-2 underline-offset-[0.2em] outline-none hover:decoration-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {folder === "" ? "a folder" : baseName(folder)}
        </Popover.Trigger>
      ) : (
        <Popover.Trigger
          data-testid="where-folder"
          aria-label="Folder"
          className={cn(CHIP, FOCUS, "max-w-64 hover:bg-accent")}
        >
          <Folder aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{folder === "" ? "Choose a folder" : baseName(folder)}</span>
          <ChevronDown aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        </Popover.Trigger>
      )}
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6} className="isolate z-50">
          <Popover.Popup
            data-testid="where-folder-menu"
            data-surface="overlay"
            aria-label="Recent projects"
            className="flex w-80 origin-(--transform-origin) flex-col rounded-md border border-border bg-popover p-1 text-sm text-popover-foreground shadow-md outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0"
          >
            <ul aria-label="Recent projects" className="flex max-h-64 flex-col overflow-y-auto">
              {projects.map((project) => (
                <li key={project.root}>
                  <button
                    type="button"
                    aria-current={project.root === folder ? "true" : undefined}
                    className="flex w-full min-w-0 items-baseline gap-2 rounded-sm px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:bg-accent aria-[current]:bg-accent/60"
                    onClick={() => {
                      onPickFolder(project.root);
                      setOpen(false);
                    }}
                  >
                    <span className="shrink-0 font-medium">{baseName(project.root)}</span>
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {tildify(project.root, home)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="flex items-center gap-2 rounded-sm border-t border-border px-2 py-1.5 text-left text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent"
              onClick={() => {
                setOpen(false);
                onBrowse();
              }}
            >
              <FolderSearch aria-hidden className="size-3.5" />
              Another folder…
            </button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
