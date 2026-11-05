import { Popover } from "@base-ui/react/popover";
import type { Project } from "@gram/contracts";
import { ChevronDown, Folder, FolderSearch } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

import { baseName, tildify } from "./path";
import { ProjectLists } from "./project-shortcuts";
import { useHome } from "./use-folder";

const CHIP =
  "flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-edge bg-card px-2 text-meta outline-none";
const FOCUS = "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

interface FolderPickerProps {
  /** The chosen folder; empty until one resolves. */
  folder: string;
  /** The known projects: the menu lists the bookmarked ones, then the recent ones. */
  projects: readonly Project[];
  onPickFolder: (root: string) => void;
  /** Hands over to the path field and browser for a folder that isn't listed. */
  onBrowse: () => void;
}

/**
 * The folder the new thread runs in: a chip whose menu holds the bookmarked and recent projects,
 * each with its bookmark and (for a recent one) remove control, and the path field and browser
 * behind "Another folder…". Or `inline`, a word in a headline.
 */
export function FolderPicker({
  folder,
  projects,
  onPickFolder,
  onBrowse,
  inline = false,
}: FolderPickerProps & {
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
          <Folder aria-hidden className="size-icon-row shrink-0 text-muted-foreground" />
          <span className="truncate">{folder === "" ? "Choose a folder" : baseName(folder)}</span>
          <ChevronDown aria-hidden className="size-icon-chip shrink-0 text-muted-foreground" />
        </Popover.Trigger>
      )}
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6} className="isolate z-50">
          <Popover.Popup
            data-testid="where-folder-menu"
            data-surface="overlay"
            aria-label="Choose a folder"
            className="flex w-96 origin-(--transform-origin) flex-col rounded-md border border-edge bg-popover p-1 text-reading text-popover-foreground shadow-overlay outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0"
          >
            <div className="max-h-96 overflow-y-auto py-1">
              <ProjectLists
                projects={projects}
                current={folder === "" ? undefined : folder}
                onChoose={(root) => {
                  onPickFolder(root);
                  setOpen(false);
                }}
              />
            </div>
            <button
              type="button"
              className="mt-1 flex items-center gap-2 rounded-sm border-t border-border px-2 py-1.5 text-left text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent"
              onClick={() => {
                setOpen(false);
                onBrowse();
              }}
            >
              <FolderSearch aria-hidden className="size-icon-row" />
              Another folder…
            </button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
