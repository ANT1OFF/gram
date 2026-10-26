import { Menu } from "@base-ui/react/menu";
import type { Project, WorkspaceState } from "@gram/contracts";
import { Check, ChevronDown, FolderGit2, MessageSquare, Network, Plus } from "lucide-react";

import { useShortcutHint } from "@/keyboard/use-shortcut-hint";
import { cn } from "@/lib/utils";

import { reposWithoutWorkspace, taskTargetKey, type TaskTarget } from "./task-model";

const POPUP =
  "z-50 w-80 origin-(--transform-origin) rounded-md border border-border bg-popover p-1 text-sm text-popover-foreground shadow-md outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0";
const ITEM =
  "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 outline-none select-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground";
const LABEL =
  "px-2 pt-1.5 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase";

/**
 * What the draft is aimed at: a task's target, or a one-off thread. `newWorkspace` is no target but
 * the new-workspace sheet, which the draft opens once it has carried what was typed.
 */
export type DraftTarget =
  | TaskTarget
  | { readonly kind: "oneOff" }
  | { readonly kind: "newWorkspace" };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The chip at the top of New task and of the one-off draft, and its menu: every workspace, the
 * repos with none yet (one is made on send), and the one-off thread, which is the other draft.
 */
export function TaskTargetPicker({
  value,
  disabled = false,
  workspaces,
  projects,
  onPick,
}: {
  value: TaskTarget | { readonly kind: "oneOff" } | undefined;
  /** While a file is still uploading, which the other draft couldn't take with it. */
  disabled?: boolean;
  workspaces: readonly WorkspaceState[];
  projects: readonly Project[];
  onPick: (target: DraftTarget) => void;
}) {
  const oneOffHint = useShortcutHint("thread.newInProject");
  const repos = reposWithoutWorkspace(workspaces, projects);
  const current = value === undefined || value.kind === "oneOff" ? undefined : taskTargetKey(value);
  const workspace =
    value?.kind === "workspace"
      ? workspaces.find((state) => state.workspace.id === value.workspaceId)
      : undefined;
  const repo = value?.kind === "repo" ? projects.find((p) => p.id === value.projectId) : undefined;
  const Icon =
    value?.kind === "oneOff" ? MessageSquare : value?.kind === "repo" ? FolderGit2 : Network;
  const label =
    value?.kind === "oneOff"
      ? "One-off thread"
      : (workspace?.workspace.name ?? repo?.name ?? "Choose where it goes");

  return (
    <Menu.Root>
      <Menu.Trigger
        data-testid="task-target"
        disabled={disabled}
        aria-label={`Where it goes: ${label}`}
        className="flex h-8 w-fit max-w-full min-w-0 items-center gap-1.5 rounded-md border border-input bg-card px-2.5 text-sm outline-none hover:bg-accent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Icon
          aria-hidden
          className={cn(
            "size-4 shrink-0",
            value?.kind === "workspace" ? "text-primary" : "text-muted-foreground",
          )}
        />
        <span className="truncate">{label}</span>
        <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="start" sideOffset={4} className="isolate z-50 outline-none">
          <Menu.Popup data-testid="task-target-menu" className={POPUP}>
            {workspaces.length > 0 && (
              <Menu.Group>
                <Menu.GroupLabel className={LABEL}>Workspaces</Menu.GroupLabel>
                {workspaces.map(({ workspace: each }) => (
                  <Menu.Item
                    key={each.id}
                    className={ITEM}
                    onClick={() => onPick({ kind: "workspace", workspaceId: each.id })}
                  >
                    <Network aria-hidden className="size-4 shrink-0 text-primary" />
                    <span className="min-w-0 flex-1 truncate">{each.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {plural(each.projectIds.length, "repo")}
                    </span>
                    <Check
                      aria-hidden
                      className={cn(
                        "size-4 shrink-0",
                        current === `w:${each.id}` ? "opacity-100" : "opacity-0",
                      )}
                    />
                  </Menu.Item>
                ))}
              </Menu.Group>
            )}
            <Menu.Group>
              {repos.length > 0 && (
                <Menu.GroupLabel className={LABEL}>Repos with no workspace yet</Menu.GroupLabel>
              )}
              {repos.map((project) => (
                <Menu.Item
                  key={project.id}
                  className={ITEM}
                  onClick={() => onPick({ kind: "repo", projectId: project.id })}
                >
                  <FolderGit2 aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">makes one on send</span>
                  <Check
                    aria-hidden
                    className={cn(
                      "size-4 shrink-0",
                      current === `p:${project.id}` ? "opacity-100" : "opacity-0",
                    )}
                  />
                </Menu.Item>
              ))}
              <Menu.Item
                className={cn(ITEM, "text-muted-foreground")}
                onClick={() => onPick({ kind: "newWorkspace" })}
              >
                <Plus aria-hidden className="size-4 shrink-0" />
                <span className="flex-1">New workspace…</span>
              </Menu.Item>
            </Menu.Group>
            <Menu.Separator className="my-1 border-t border-border" />
            <Menu.Item className={ITEM} onClick={() => onPick({ kind: "oneOff" })}>
              <MessageSquare aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-1 flex-col">
                One-off thread
                <span className="text-xs text-muted-foreground">
                  One agent in one folder, no orchestrator
                </span>
              </span>
              {oneOffHint && (
                <kbd className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {oneOffHint}
                </kbd>
              )}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
