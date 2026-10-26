import { Menu } from "@base-ui/react/menu";
import type { WorkspaceId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Check, ChevronRight, Layers, MessageSquare, Network, Plus, User } from "lucide-react";
import { useRef, useState, type ComponentType, type ReactNode } from "react";

import { useApi } from "@/api/context";
import { Button } from "@/components/ui/button";
import { useShortcutHint } from "@/keyboard/use-shortcut-hint";
import { cn } from "@/lib/utils";
import { focusedThreadId } from "@/shell/thread-switcher";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

import {
  newEntryLabel,
  newEntryRoute,
  prefillOneOff,
  targetWorkspace,
  type NewEntry,
} from "./new-entry";
import { useTaskDraftStore } from "./task-draft-store";
import { defaultTaskTarget } from "./task-model";
import { useWorkspacesQuery } from "./use-orchestration";

const POPUP =
  "z-50 origin-(--transform-origin) rounded-md border border-border bg-popover p-1 text-sm text-popover-foreground shadow-md outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0";
const ITEM =
  "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 outline-none select-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[popup-open]:bg-accent [&_svg]:size-4 [&_svg]:shrink-0";
const LABEL = "px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground";

/** A menu row's shortcut, right-aligned; nothing for one that's turned off. */
function Keys({ id }: { id: string }) {
  const hint = useShortcutHint(id);
  return hint ? (
    <kbd className="ml-auto pl-4 font-mono text-[10px] text-muted-foreground">{hint}</kbd>
  ) : null;
}

/**
 * The overview header's `+`: a task for a workspace's orchestrator, a worker in one, a one-off
 * thread or a new workspace, each landing on its own first screen. The task and the worker go to
 * the default workspace (the open thread's, else the last one used); their Send to submenu picks
 * another. The menu opens on the row used last, so Enter repeats it.
 */
export function NewEntryMenu() {
  const api = useApi();
  const navigate = useNavigate();
  const { workspaces } = useWorkspacesQuery();
  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });
  const currentId = useLayoutStore((s) => s.grid.panes[s.grid.focused] ?? undefined);
  const current = useThreadsStore((s) =>
    currentId === undefined ? undefined : s.byId[currentId]?.thread,
  );
  const last = useTaskDraftStore((s) => s.last);
  const remembered = useTaskDraftStore((s) => s.entry);
  const workspace = targetWorkspace(
    defaultTaskTarget({ current, workspaces, projects, last }),
    workspaces,
  )?.workspace;
  const [open, setOpen] = useState(false);
  const rows = useRef(new Map<NewEntry, HTMLElement>());
  const row = (entry: NewEntry) => (element: HTMLElement | null) => {
    if (element === null) rows.current.delete(entry);
    else rows.current.set(entry, element);
  };

  const start = (entry: NewEntry, workspaceId?: WorkspaceId) => {
    setOpen(false);
    useTaskDraftStore.getState().rememberEntry(entry);
    if (entry === "oneOff") prefillOneOff(focusedThreadId());
    void navigate(newEntryRoute(entry, workspaceId));
  };

  const sendTo = (entry: "task" | "worker", Icon: ComponentType<{ "aria-hidden"?: boolean }>) => {
    const label = newEntryLabel(entry, workspace?.name);
    const keys = <Keys id={entry === "task" ? "thread.new" : "thread.newWorker"} />;
    const icon = <Icon aria-hidden />;
    if (workspaces.length === 0) {
      return (
        <Menu.Item
          ref={row(entry)}
          data-testid={`new-entry-${entry}`}
          className={ITEM}
          onClick={() => start(entry)}
        >
          {icon}
          <span title={label} className="min-w-0 flex-1 truncate">
            {label}
          </span>
          {keys}
        </Menu.Item>
      );
    }
    return (
      <Menu.SubmenuRoot>
        <Menu.SubmenuTrigger
          ref={row(entry)}
          data-testid={`new-entry-${entry}`}
          className={ITEM}
          // A click or Enter goes to the default workspace; hover or → opens Send to.
          onClick={(event) => {
            event.preventBaseUIHandler();
            start(entry, workspace?.id);
          }}
        >
          {icon}
          <span title={label} className="min-w-0 flex-1 truncate">
            {label}
          </span>
          {keys}
          <ChevronRight aria-hidden className="text-muted-foreground" />
        </Menu.SubmenuTrigger>
        <Menu.Portal>
          <Menu.Positioner side="right" align="start" alignOffset={-4} className="isolate z-50">
            <Menu.Popup data-testid={`new-entry-${entry}-to`} className={cn(POPUP, "w-48")}>
              <Menu.Group>
                <Menu.GroupLabel className={LABEL}>Send to</Menu.GroupLabel>
                {workspaces.map(({ workspace: each }) => (
                  <Menu.Item key={each.id} className={ITEM} onClick={() => start(entry, each.id)}>
                    {icon}
                    <span className="min-w-0 flex-1 truncate">{each.name}</span>
                    <Check
                      aria-hidden
                      className={each.id === workspace?.id ? "opacity-100" : "opacity-0"}
                    />
                  </Menu.Item>
                ))}
              </Menu.Group>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.SubmenuRoot>
    );
  };

  return (
    <Menu.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Opened, the row used last takes the highlight, so a plain click and Enter repeat it.
        if (!next || remembered === undefined) return;
        requestAnimationFrame(() => rows.current.get(remembered)?.focus({ preventScroll: true }));
      }}
    >
      <Menu.Trigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="New"
            data-testid="new-entry"
            title="New task, worker, one-off thread or workspace"
            className="ml-auto text-muted-foreground [-webkit-app-region:no-drag]"
          />
        }
      >
        <Plus />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="start" sideOffset={4} className="isolate z-50 outline-none">
          <Menu.Popup data-testid="new-entry-menu" className={cn(POPUP, "w-80 max-w-[90vw]")}>
            {sendTo("task", Network)}
            {sendTo("worker", User)}
            <EntryItem
              entry="oneOff"
              ref={row("oneOff")}
              onPick={start}
              icon={<MessageSquare aria-hidden />}
            >
              One-off thread
              <Keys id="thread.newInProject" />
            </EntryItem>
            <Menu.Separator className="-mx-1 my-1 h-px bg-border" />
            <EntryItem
              entry="workspace"
              ref={row("workspace")}
              onPick={start}
              icon={<Layers aria-hidden />}
            >
              New workspace…
            </EntryItem>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function EntryItem({
  entry,
  ref,
  icon,
  onPick,
  children,
}: {
  entry: NewEntry;
  ref: (element: HTMLElement | null) => void;
  icon: ReactNode;
  onPick: (entry: NewEntry) => void;
  children: ReactNode;
}) {
  return (
    <Menu.Item
      ref={ref}
      data-testid={`new-entry-${entry}`}
      className={ITEM}
      onClick={() => onPick(entry)}
    >
      {icon}
      {children}
    </Menu.Item>
  );
}
