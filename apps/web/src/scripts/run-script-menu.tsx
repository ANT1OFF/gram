import { Menu } from "@base-ui/react/menu";
import type { ProjectId, ProjectScript, ThreadId } from "@gram/contracts";
import { Pencil, Play, Plus } from "lucide-react";

import { useApi } from "@/api/context";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { formatKeys } from "@/keyboard/registry";
import { cn } from "@/lib/utils";
import { useThreadDialogs } from "@/thread/thread-dialogs-store";

import { startScript, useProjectScripts } from "./use-project-scripts";

const POPUP =
  "z-50 max-w-80 min-w-56 origin-(--transform-origin) rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0";
const ITEM =
  "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground";

/** The exact line a script runs, and where, as its menu row's tooltip says it. */
export const scriptCommandHint = (script: ProjectScript): string =>
  script.cwd === undefined ? script.command : `${script.command}\nin ${script.cwd}`;

/**
 * "Run script": the thread's project scripts, each run in the thread's checkout in a terminal tab
 * named after it, with the exact command in its tooltip; then adding or editing them.
 */
export function RunScriptMenu({
  threadId,
  projectId,
  size = "icon-sm",
  className,
  onlyWithScripts = false,
}: {
  threadId: ThreadId;
  projectId: ProjectId;
  size?: "icon-sm" | "icon-xs";
  /** On the trigger, e.g. to drop it from a narrow header. */
  className?: string | undefined;
  /**
   * Shown only once the project has scripts: in the thread's header, whose chips need the room,
   * the first one is added from the thread menu, the Terminal tab or the palette.
   */
  onlyWithScripts?: boolean;
}) {
  const api = useApi();
  const { data, isPending, isError, refetch } = useProjectScripts(projectId);
  const scripts = data?.scripts ?? [];
  const openEditor = () =>
    useThreadDialogs.getState().open({ kind: "projectScripts", projectId, threadId });
  if (onlyWithScripts && scripts.length === 0) return null;

  return (
    // Read again on open, so a hand edit of the file is in the menu.
    <Menu.Root onOpenChange={(open) => open && void refetch()}>
      <Hint
        label="Run script"
        side="bottom"
        render={
          <Menu.Trigger
            render={<Button size={size} variant="ghost" aria-label="Run script" />}
            data-testid="run-script-menu"
            className={cn(
              "shrink-0 text-muted-foreground/70 hover:text-foreground focus-visible:text-foreground aria-expanded:text-foreground",
              className,
            )}
          />
        }
      >
        <Play aria-hidden className={size === "icon-xs" ? "size-3" : "size-3.5"} />
      </Hint>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={4} className="isolate z-50 outline-none">
          <Menu.Popup data-testid="run-script-popup" aria-label="Run script" className={POPUP}>
            <div className="px-2 py-1 text-xs text-muted-foreground">
              Run in this thread's folder
            </div>
            {isPending && <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</p>}
            {isError && (
              <p className="px-2 py-1.5 text-xs text-danger-text">Couldn't read the scripts.</p>
            )}
            {data?.problem !== undefined && (
              <p className="px-2 py-1.5 text-xs text-danger-text">{data.problem}</p>
            )}
            {data !== undefined && scripts.length === 0 && data.problem === undefined && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                No project scripts yet.
                {data.suggestions.length > 0 &&
                  ` ${data.suggestions.length === 1 ? "1 command" : `${data.suggestions.length} commands`} in this project can be added in one click.`}
              </p>
            )}
            {scripts.map((script) => (
              <Hint
                key={script.name}
                label={scriptCommandHint(script)}
                side="left"
                render={
                  <Menu.Item
                    data-testid="run-script-item"
                    className={ITEM}
                    onClick={() => startScript(api, threadId, script.name)}
                  />
                }
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{script.name}</span>
                  <span className="truncate font-mono text-[11px] text-muted-foreground">
                    {script.command}
                  </span>
                </span>
                {script.shortcut !== undefined && (
                  <kbd className="shrink-0 pl-3 font-mono text-[10px] text-muted-foreground">
                    {formatKeys(script.shortcut)}
                  </kbd>
                )}
              </Hint>
            ))}
            <div role="separator" className="-mx-1 my-1 h-px bg-border" />
            <Menu.Item data-testid="edit-project-scripts" className={ITEM} onClick={openEditor}>
              {scripts.length === 0 ? (
                <Plus aria-hidden className="size-3.5" />
              ) : (
                <Pencil aria-hidden className="size-3.5" />
              )}
              {scripts.length === 0 ? "Add project script…" : "Edit project scripts…"}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
