import type { ThreadId } from "@gram/contracts";
import { Link, useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useEmbedShell, useThreadsTitle } from "@/embed/store";
import { cn } from "@/lib/utils";
import { useOpenBoard } from "@/orchestration/open-board";
import { WorkspaceSwitcher } from "@/shell/workspace-switcher";
import { useLayoutStore } from "@/stores/layout";
import { useViewStore } from "@/views/view-store";
import { useViewWorkspace } from "@/views/view-workspace";

const NO_DRAG = "[-webkit-app-region:no-drag]";

/** One of a workspace's two places: outlined, and filled while the window is on it. */
const PLACE =
  "border border-border text-muted-foreground aria-[current=page]:border-transparent aria-[current=page]:bg-secondary aria-[current=page]:text-foreground aria-pressed:border-transparent aria-pressed:bg-secondary aria-pressed:text-foreground";

/** Whether `pathname` is one of the New form's pages. */
const creating = (pathname: string) =>
  pathname === "/new" || pathname === "/new-task" || pathname === "/new-workspace";

/**
 * Whether the title bar starts as a path on this page: an embedding app asked for it
 * (`threadsPage.bar: "path"`), and the page is a thread, a Board or the New form. Gram's other
 * pages, and Gram on its own, keep the workspace and its views.
 */
export function usePathBar(): boolean {
  const asked = useEmbedShell((s) => s.threadsPage.bar === "path");
  const pathname = useLocation({ select: (location) => location.pathname });
  return asked && (pathname.startsWith("/t/") || creating(pathname));
}

function Step() {
  return <ChevronRight aria-hidden className="size-icon-chip shrink-0 text-muted-foreground" />;
}

/**
 * The bar's start as a path, for an app whose own pages say where they are this way: the page of
 * every thread, then the workspace (still its switcher) and, in the slot after it, the thread. A
 * solo thread is in no workspace, and the New form names itself.
 */
export function TitlebarPath({ solo, narrow }: { solo: boolean; narrow: boolean }) {
  const title = useThreadsTitle();
  const pathname = useLocation({ select: (location) => location.pathname });
  const fresh = creating(pathname);
  // The workspace is the path's end on its Board and on its orchestrator's thread, which the
  // buttons beside the path name: a step after it would lead nowhere.
  const workspace = useViewWorkspace();
  const board = useViewStore((s) => s.view === "board");
  const route = useParams({ strict: false }).threadId as ThreadId | undefined;
  const last =
    board || (route !== undefined && route === workspace?.workspace.orchestratorThreadId);
  return (
    <nav
      aria-label="Where you are"
      data-testid="titlebar-path"
      className={cn("flex min-w-0 shrink-0 items-center gap-1", NO_DRAG)}
    >
      <Link
        to="/threads"
        data-testid="titlebar-path-root"
        className="shrink-0 rounded-(--radius-sm) px-2 text-body text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        {title}
      </Link>
      <Step />
      {fresh && (
        <span aria-current="page" className="px-2 text-body font-medium text-foreground">
          New task
        </span>
      )}
      {!fresh && !solo && (
        <>
          <WorkspaceSwitcher className={cn("shrink-0", narrow && "max-w-28")} />
          {!last && <Step />}
        </>
      )}
    </nav>
  );
}

/**
 * A workspace's two places beside the path, as buttons: its orchestrator's thread, in the
 * embedding app's word for one, and its Board. Nothing on a solo thread or the New form.
 */
export function TitlebarPathViews({ solo }: { solo: boolean }) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const word = useEmbedShell((s) => s.threadsPage.kinds?.orchestrator ?? "Orchestrator");
  const workspace = useViewWorkspace();
  const board = useViewStore((s) => s.view === "board");
  const route = useParams({ strict: false }).threadId as ThreadId | undefined;
  const navigate = useNavigate();
  const openBoard = useOpenBoard();
  if (solo || creating(pathname) || workspace === undefined) return null;
  const orchestrator = workspace.workspace.orchestratorThreadId;
  const atOrchestrator = !board && orchestrator !== undefined && route === orchestrator;
  return (
    <div
      role="group"
      aria-label="Workspace"
      data-testid="titlebar-path-views"
      className={cn("flex shrink-0 items-center gap-1", NO_DRAG)}
    >
      {orchestrator !== undefined && (
        <Button
          variant="ghost"
          size="xs"
          aria-current={atOrchestrator ? "page" : undefined}
          className={PLACE}
          onClick={() => {
            const view = useViewStore.getState();
            view.setQuiet(false);
            view.setView("chat");
            useLayoutStore.getState().openThread(orchestrator);
            void navigate({ to: "/t/$threadId", params: { threadId: orchestrator } });
          }}
        >
          {word}
        </Button>
      )}
      <Button
        variant="ghost"
        size="xs"
        aria-pressed={board}
        className={PLACE}
        onClick={() => openBoard(workspace.workspace.id)}
      >
        Board
      </Button>
    </div>
  );
}
