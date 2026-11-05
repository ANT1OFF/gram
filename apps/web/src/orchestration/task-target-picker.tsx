import { Menu } from "@base-ui/react/menu";
import type { Project, WorkspaceState } from "@gram/contracts";
import { Check, ChevronDown, FolderGit2, Network, Plus } from "lucide-react";

import { cn } from "@/lib/utils";

import { reposWithoutWorkspace, taskTargetKey, type TaskTarget } from "./task-model";

const POPUP =
  "z-50 w-80 origin-(--transform-origin) rounded-md border border-edge bg-popover p-1 text-reading text-popover-foreground shadow-overlay outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0";
const ITEM =
  "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 outline-none select-none data-[highlighted]:row-cursor";
const LABEL = "px-2 pt-1.5 pb-1 text-meta font-medium text-muted-foreground";

/**
 * What the New form's "in" chip picks: a task's target, or `newWorkspace`, which is no target but
 * the new-workspace sheet, which the form opens once it has carried what was typed.
 */
export type DraftTarget = TaskTarget | { readonly kind: "newWorkspace" };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The New form's "in" chip for the orchestrator or a worker, and its menu: every workspace, the
 * repos with none yet (one is made on send), and New workspace. Who does it is the form's own
 * control, so the chip names only the place.
 */
export function TaskTargetPicker({
  value,
  disabled = false,
  workspaces,
  projects,
  onPick,
}: {
  value: TaskTarget | undefined;
  /** While a file is still uploading, which the new-workspace sheet couldn't take with it. */
  disabled?: boolean;
  workspaces: readonly WorkspaceState[];
  projects: readonly Project[];
  onPick: (target: DraftTarget) => void;
}) {
  const repos = reposWithoutWorkspace(workspaces, projects);
  const current = value === undefined ? undefined : taskTargetKey(value);
  const workspace =
    value?.kind === "workspace"
      ? workspaces.find((state) => state.workspace.id === value.workspaceId)
      : undefined;
  const repo = value?.kind === "repo" ? projects.find((p) => p.id === value.projectId) : undefined;
  const Icon = value?.kind === "repo" ? FolderGit2 : Network;
  const label = workspace?.workspace.name ?? repo?.name ?? "Choose a workspace";

  return (
    <Menu.Root>
      <Menu.Trigger
        data-testid="task-target"
        disabled={disabled}
        aria-label={`In: ${label}`}
        className="flex h-7 w-fit max-w-64 min-w-0 items-center gap-1.5 rounded-md border border-edge bg-card px-2 text-meta text-foreground outline-none hover:bg-accent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Icon aria-hidden className="size-icon-row shrink-0 text-muted-foreground" />
        <span className="truncate">{label}</span>
        <ChevronDown aria-hidden className="size-icon-chip shrink-0 text-muted-foreground" />
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
                    <Network aria-hidden className="size-icon-row shrink-0 text-primary" />
                    <span className="min-w-0 flex-1 truncate">{each.name}</span>
                    <span className="shrink-0 text-meta text-muted-foreground">
                      {plural(each.projectIds.length, "repo")}
                    </span>
                    <Check
                      aria-hidden
                      className={cn(
                        "size-icon-row shrink-0",
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
                  <FolderGit2
                    aria-hidden
                    className="size-icon-row shrink-0 text-muted-foreground"
                  />
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  <span className="shrink-0 text-meta text-muted-foreground">
                    makes one on send
                  </span>
                  <Check
                    aria-hidden
                    className={cn(
                      "size-icon-row shrink-0",
                      current === `p:${project.id}` ? "opacity-100" : "opacity-0",
                    )}
                  />
                </Menu.Item>
              ))}
              <Menu.Separator className="my-1 border-t border-border" />
              <Menu.Item
                data-testid="task-target-new-workspace"
                className={cn(ITEM, "text-muted-foreground")}
                onClick={() => onPick({ kind: "newWorkspace" })}
              >
                <Plus aria-hidden className="size-icon-row shrink-0" />
                <span className="flex-1">New workspace</span>
              </Menu.Item>
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
