import { Popover } from "@base-ui/react/popover";
import { HostId, hostOf, type Project } from "@gram/contracts";
import {
  Check,
  ChevronDown,
  CircleAlert,
  Folder,
  FolderGit2,
  FolderSearch,
  House,
} from "lucide-react";
import { useId, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Expand, Shimmer } from "@/motion";
import type { JoinedMachine } from "@/settings/machines-api";
import { useThreadsStore } from "@/stores/threads";

import { FolderBrowser } from "./folder-browser";
import { GitBadge } from "./git-badge";
import { baseName, tildify } from "./path";
import { PathField } from "./path-field";
import { useHome, type MachineFolderStatus } from "./use-folder";

const CHIP =
  "flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-edge bg-card px-2 text-meta outline-none";
const FOCUS = "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";
const ROW =
  "flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:bg-accent";

/** How many of a machine's recent folders, and of this Mac's repositories, its menu lists. */
const LISTED = 5;

/**
 * The folders the one-off threads on `hostId` ran in, the latest first: what its Folder menu offers
 * before Another folder.
 */
export function useMachineRecents(hostId: string | undefined): readonly string[] {
  return useThreadsStore(
    useShallow((s) => {
      if (hostId === undefined) return [];
      const seen = new Set<string>();
      for (const { thread } of Object.values(s.byId).toSorted(
        (a, b) => b.thread.lastActivityAt - a.thread.lastActivityAt,
      )) {
        if (hostOf(thread.checkout) !== hostId || thread.checkout.kind !== "main") continue;
        seen.add(thread.checkout.path);
        if (seen.size === LISTED) break;
      }
      return [...seen];
    }),
  );
}

/**
 * The Folder chip while a joined machine is picked: a folder there, home by default, from its
 * recent folders or Another folder (the path field and browser below, through its host). A
 * repository on this Mac is still offered, as a new worktree of the machine's own clone.
 */
export function MachineFolderChip({
  machine,
  folder,
  repo,
  repos,
  onPickFolder,
  onPickRepo,
  onBrowse,
}: {
  machine: JoinedMachine;
  /** The folder typed or picked there; `undefined` while a repository of this Mac is picked. */
  folder: string | undefined;
  /** The repository of this Mac picked for a new worktree there, while `folder` is absent. */
  repo: string | undefined;
  /** This Mac's repositories, the recent ones first. */
  repos: readonly Project[];
  onPickFolder: (path: string) => void;
  onPickRepo: (root: string) => void;
  /** Hands over to the path field and browser of the machine's folders. */
  onBrowse: () => void;
}) {
  const hostId = HostId.make(machine.id);
  const home = useHome(hostId);
  const recents = useMachineRecents(machine.id);
  const [open, setOpen] = useState(false);
  const shown = folder === undefined ? undefined : tildify(folder.trim(), home);
  const listed = ["~", ...recents.map((path) => tildify(path, home)).filter((p) => p !== "~")];
  const pick = (run: () => void) => {
    run();
    setOpen(false);
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        data-testid="where-folder"
        aria-label={`Folder on ${machine.name}`}
        title={
          folder === undefined
            ? `${repo ?? ""} · a new worktree on ${machine.name}`
            : `${shown} on ${machine.name}`
        }
        className={cn(CHIP, FOCUS, "max-w-64 hover:bg-accent")}
      >
        {folder === undefined ? (
          <FolderGit2 aria-hidden className="size-icon-row shrink-0 text-muted-foreground" />
        ) : (
          <Folder aria-hidden className="size-icon-row shrink-0 text-muted-foreground" />
        )}
        <span className={cn("truncate", folder !== undefined && "font-mono")}>
          {folder === undefined ? baseName(repo ?? "") : shown || "~"}
        </span>
        <ChevronDown aria-hidden className="size-icon-chip shrink-0 text-muted-foreground" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6} className="isolate z-50">
          <Popover.Popup
            data-testid="where-folder-menu"
            data-surface="overlay"
            aria-label={`Choose a folder on ${machine.name}`}
            className="flex w-96 origin-(--transform-origin) flex-col rounded-md border border-edge bg-popover p-1 text-reading text-popover-foreground shadow-overlay outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0"
          >
            <div className="max-h-96 overflow-y-auto py-1">
              <p className="px-2 pt-1 pb-0.5 text-meta font-medium text-muted-foreground">
                On {machine.name}
              </p>
              {listed.map((path) => {
                const current = shown === path;
                return (
                  <button
                    key={path}
                    type="button"
                    aria-pressed={current}
                    className={cn(ROW, "aria-pressed:bg-accent")}
                    onClick={() => pick(() => onPickFolder(path))}
                  >
                    {path === "~" ? (
                      <House aria-hidden className="size-icon-row shrink-0 text-muted-foreground" />
                    ) : (
                      <Folder
                        aria-hidden
                        className="size-icon-row shrink-0 text-muted-foreground"
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate font-mono text-meta">{path}</span>
                    {path === "~" && <span className="text-meta text-muted-foreground">Home</span>}
                    {current && <Check aria-hidden className="size-icon-chip shrink-0" />}
                  </button>
                );
              })}
              {repos.length > 0 && (
                <>
                  <p
                    className="px-2 pt-2 pb-0.5 text-meta font-medium text-muted-foreground"
                    title={`A new worktree of ${machine.name}'s own clone of the repository's origin`}
                  >
                    New worktree on {machine.name}, from
                  </p>
                  {repos.slice(0, LISTED).map((project) => (
                    <button
                      key={project.id}
                      type="button"
                      aria-pressed={folder === undefined && repo === project.root}
                      title={project.root}
                      className={cn(ROW, "aria-pressed:bg-accent")}
                      onClick={() => pick(() => onPickRepo(project.root))}
                    >
                      <FolderGit2
                        aria-hidden
                        className="size-icon-row shrink-0 text-muted-foreground"
                      />
                      <span className="min-w-0 flex-1 truncate">{project.name}</span>
                      <GitBadge />
                    </button>
                  ))}
                </>
              )}
            </div>
            <button
              type="button"
              className="mt-1 flex items-center gap-2 rounded-sm border-t border-border px-2 py-1.5 text-left text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent"
              onClick={() => pick(onBrowse)}
            >
              <FolderSearch aria-hidden className="size-icon-row" />
              Another folder on {machine.name}…
            </button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * A folder on a joined machine by path: typed, with that machine's folders suggested, or found in
 * its browser; every listing and the check come from its host.
 */
export function MachineFolderField({
  machine,
  value,
  onChange,
  status,
}: {
  machine: JoinedMachine;
  value: string;
  onChange: (value: string) => void;
  status: MachineFolderStatus;
}) {
  const hostId = HostId.make(machine.id);
  const browserId = useId();
  const [browsing, setBrowsing] = useState(false);
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-meta font-medium text-muted-foreground">
        Folder on {machine.name}
      </legend>
      <div className="flex gap-1">
        <PathField
          value={value}
          onChange={onChange}
          hostId={hostId}
          label={`Folder on ${machine.name}`}
          placeholder="~"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8"
          aria-expanded={browsing}
          aria-controls={browserId}
          onClick={() => setBrowsing((open) => !open)}
        >
          Browse
        </Button>
      </div>
      <MachineFolderLine machine={machine} status={status} />
      <Expand open={browsing} id={browserId}>
        <div className="mt-1 overflow-hidden rounded-lg border border-edge bg-card">
          {browsing && (
            <FolderBrowser
              hostId={hostId}
              startAt={status.state === "valid" ? status.folder.path : value.trim() || "~"}
              onChoose={(path) => {
                onChange(path);
                setBrowsing(false);
              }}
            />
          )}
        </div>
      </Expand>
    </fieldset>
  );
}

/**
 * What to do while the field is empty. Its check (checking, why not, where it runs) is said once,
 * under Where it runs (`machineFolderLine`).
 */
function MachineFolderLine({
  machine,
  status,
}: {
  machine: JoinedMachine;
  status: MachineFolderStatus;
}) {
  return status.state === "empty" ? (
    <p className="text-meta text-muted-foreground">
      Type a path on {machine.name}, or browse its folders.
    </p>
  ) : null;
}

/** Inline: it sits in the line under Where it runs, itself a paragraph. */
function FolderProblemLine({ message }: { message: string }) {
  return (
    <span
      role="alert"
      data-testid="folder-problem"
      className="flex items-center gap-1.5 text-meta text-danger-text"
    >
      <CircleAlert aria-hidden className="size-icon-row shrink-0" />
      {message}
    </span>
  );
}

/**
 * Where the thread will run, said under Where it runs before it starts: the machine and the real
 * folder there, or why it can't run there.
 */
export function machineFolderLine(
  machine: JoinedMachine,
  status: MachineFolderStatus,
): React.ReactNode {
  switch (status.state) {
    case "empty":
    case "checking":
      return <Shimmer>{`Checking the folder on ${machine.name}…`}</Shimmer>;
    case "invalid":
      return <FolderProblemLine message={status.problem.message} />;
    case "valid": {
      const { path, branch } = status.folder;
      return (
        <span data-testid="machine-folder-note">
          {`Runs on ${machine.name} in `}
          <span className="font-mono">{path}</span>
          {branch === undefined
            ? ", as it is: no worktree, diff or pull request outside a repository."
            : `, as it is, on its branch ${branch}.`}
        </span>
      );
    }
  }
}
