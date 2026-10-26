import type { ThreadId, ThreadSummary, Workspace } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Check, ChevronDown } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { useApi } from "@/api/context";
import { Button } from "@/components/ui/button";
import { formatKeys, registerShortcut } from "@/keyboard/registry";
import { effectiveKeys, useBindingsStore } from "@/keyboard/bindings-store";
import { listIndexForKey } from "@/lib/list-keys";
import { formatRelative } from "@/lib/time";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { useWorkspaceAsks } from "@/orchestration/ask-stack";
import { useOpenWorkspace } from "@/orchestration/home";
import { useWorkspaces } from "@/orchestration/use-orchestration";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { threadDisplayTitle } from "@/thread/thread-title";
import { soloThreads } from "@/views/solo-threads";
import { useViewStore } from "@/views/view-store";
import { useViewWorkspace } from "@/views/view-workspace";

import { TitlebarPopover } from "./titlebar-popover";

/** ⌘1–⌘9 pick the workspaces in the switcher's order. */
const WORKSPACE_KEYS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

const ITEM = "data-switcher-item";

/**
 * Opens `workspace`'s orchestrator, keeping the view: Board shows the next workspace's board. Goes
 * nowhere when the window is there already.
 */
export function useSwitchWorkspace(): (workspace: Workspace) => void {
  const open = useOpenWorkspace();
  return (workspace) => {
    const threadId = workspace.orchestratorThreadId;
    if (threadId !== undefined) {
      const pathname = `/t/${threadId}`;
      if (window.location.pathname === pathname) return;
      useViewStore.getState().carryView(pathname);
    }
    open(workspace);
  };
}

/**
 * ⌘1–⌘9 switch workspace. Never while typing in a field, so a composer never loses its focus to
 * them.
 */
export function useWorkspaceKeys(): void {
  const workspaces = useWorkspaces();
  const switchTo = useSwitchWorkspace();
  const ref = useRef({ workspaces, switchTo });
  // Before paint, not after: a key pressed as a workspace appears must already find it.
  useLayoutEffect(() => {
    ref.current = { workspaces, switchTo };
  });
  useEffect(() => {
    const unregister = WORKSPACE_KEYS.map((n) =>
      registerShortcut({
        id: `workspace.switch${n}`,
        keys: `mod+${n}`,
        label: "Switch workspace 1–9",
        group: "Navigation",
        hidden: n !== 1,
        skipWhileTyping: true,
        when: () => ref.current.workspaces[n - 1] !== undefined,
        run: () => {
          const target = ref.current.workspaces[n - 1];
          if (target !== undefined) ref.current.switchTo(target.workspace);
        },
      }),
    );
    return () => {
      for (const each of unregister) each();
    };
  }, [ref]);
}

/** Arrow keys, Home and End move between the popover's items. */
const moveFocus = (event: KeyboardEvent<HTMLElement>) => {
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>(`[${ITEM}]`)];
  const active = items.indexOf(document.activeElement as HTMLElement);
  const next = listIndexForKey(event.key, Math.max(active, 0), items.length);
  if (next === undefined || event.key === "PageUp" || event.key === "PageDown") return;
  event.preventDefault();
  items[next]?.focus();
};

/**
 * The Orchestrator layout's stand-in for the sidebar: the workspace the window is on, and in its
 * popover every workspace with its asks and key, then the threads outside any workspace.
 */
export function WorkspaceSwitcher({ className }: { className?: string }) {
  const api = useApi();
  const navigate = useNavigate();
  const workspaces = useWorkspaces();
  const current = useViewWorkspace();
  const asks = useWorkspaceAsks();
  const byId = useThreadsStore((s) => s.byId);
  const overrides = useBindingsStore((s) => s.overrides);
  const switchTo = useSwitchWorkspace();
  const [open, setOpen] = useState(false);
  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });

  const counts = useMemo(
    () => new Map(asks.map((each) => [each.workspaceId as string, each.asks.length])),
    [asks],
  );
  const solo = useMemo(
    () =>
      soloThreads(
        Object.values(byId),
        new Set(workspaces.map((state) => state.workspace.id as string)),
      ),
    [byId, workspaces],
  );
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id as string, project.name])),
    [projects],
  );

  const openThread = (threadId: ThreadId) => {
    setOpen(false);
    useLayoutStore.getState().openThread(threadId);
    void navigate({ to: "/t/$threadId", params: { threadId } });
  };
  const name = current?.workspace.name ?? "Threads";

  return (
    <TitlebarPopover
      open={open}
      onOpenChange={setOpen}
      label="Workspaces"
      testId="workspace-switcher"
      align="start"
      className="w-72 p-1"
      onShown={(popup) =>
        (
          popup.querySelector<HTMLElement>(`[${ITEM}][aria-current="true"]`) ??
          popup.querySelector<HTMLElement>(`[${ITEM}]`)
        )?.focus()
      }
      trigger={
        <Button
          variant="ghost"
          size="xs"
          aria-label={`Workspace: ${name}`}
          data-testid="workspace-switcher-button"
          className={cn(
            "max-w-48 gap-1 px-2 text-[13px] font-medium data-popup-open:bg-muted",
            className,
          )}
        >
          <span className="min-w-0 truncate">{name}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </Button>
      }
    >
      <div className="flex max-h-[min(32rem,70dvh)] flex-col overflow-y-auto" onKeyDown={moveFocus}>
        {workspaces.map((state, i) => {
          const keys = i < WORKSPACE_KEYS.length ? `mod+${i + 1}` : undefined;
          const shown = keys && effectiveKeys(`workspace.switch${i + 1}`, keys, overrides);
          const count = counts.get(state.workspace.id) ?? 0;
          const here = state.workspace.id === current?.workspace.id;
          return (
            <SwitcherItem
              key={state.workspace.id}
              current={here}
              onClick={() => {
                setOpen(false);
                switchTo(state.workspace);
              }}
            >
              <Check className={cn("size-3.5 shrink-0", !here && "invisible")} />
              <span className="min-w-0 flex-1 truncate">{state.workspace.name}</span>
              {count > 0 && (
                <span
                  data-testid="workspace-ask-count"
                  aria-label={`${count} asks`}
                  className="min-w-4 rounded-full bg-accent px-1 text-center text-[11px] leading-4 text-accent-foreground tabular-nums"
                >
                  {count}
                </span>
              )}
              {shown && <kbd className="font-sans text-[11px] opacity-70">{formatKeys(shown)}</kbd>}
            </SwitcherItem>
          );
        })}
        <SoloThreads
          threads={solo}
          projectNames={projectNames}
          leading={workspaces.length > 0}
          onOpen={openThread}
        />
      </div>
    </TitlebarPopover>
  );
}

function SoloThreads({
  threads,
  projectNames,
  leading,
  onOpen,
}: {
  threads: readonly ThreadSummary[];
  projectNames: ReadonlyMap<string, string>;
  leading: boolean;
  onOpen: (threadId: ThreadId) => void;
}) {
  // Ages to the minute, while the popover is open.
  const now = useNow(true, undefined, 60_000);
  return (
    <section aria-label="Solo threads" data-testid="solo-threads">
      <h2
        className={cn(
          "flex items-center justify-between px-2 pt-1.5 pb-1 text-[11px] font-medium text-muted-foreground",
          leading && "mt-1 border-t border-border pt-2",
        )}
      >
        Solo threads
        <span className="tabular-nums">{threads.length}</span>
      </h2>
      {threads.map(({ thread }) => (
        <SwitcherItem key={thread.id} onClick={() => onOpen(thread.id)}>
          <span className="min-w-0 flex-1 truncate">{threadDisplayTitle(thread)}</span>
          <span className="max-w-20 shrink-0 truncate text-[11px] text-muted-foreground">
            {projectNames.get(thread.projectId)}
          </span>
          <span className="w-7 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
            {formatRelative(thread.lastActivityAt, now)}
          </span>
        </SwitcherItem>
      ))}
    </section>
  );
}

function SwitcherItem({
  current,
  onClick,
  children,
}: {
  current?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      {...{ [ITEM]: "" }}
      aria-current={current || undefined}
      onClick={onClick}
      className="flex h-7 shrink-0 items-center gap-2 rounded-(--radius-sm) px-2 text-left text-[13px] text-foreground outline-none hover:bg-muted focus-visible:bg-muted"
    >
      {children}
    </button>
  );
}
