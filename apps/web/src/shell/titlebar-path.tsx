import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useId } from "react";

import { Button } from "@/components/ui/button";
import { useEmbedShell, useThreadsTitle, useThreadsWorkspaceNoun } from "@/embed/store";
import { cn } from "@/lib/utils";
import { SegmentSlab } from "@/motion/segment-slab";
import { SEGMENT_SLAB, SEGMENT_TRACK } from "@/settings/fields";
import { useOpenBoard } from "@/orchestration/open-board";
import { isNewForm, newFormName } from "@/shell/new-form-name";
import { useRouteThreadId } from "@/shell/route-params";
import { WorkspaceSwitcher } from "@/shell/workspace-switcher";
import { useLayoutStore } from "@/stores/layout";
import { useViewStore } from "@/views/view-store";
import { useViewWorkspace } from "@/views/view-workspace";

const NO_DRAG = "[-webkit-app-region:no-drag]";

const PLACE =
  "relative h-6 px-2 text-muted-foreground hover:bg-transparent hover:text-foreground aria-[current=page]:text-foreground aria-pressed:text-foreground";

const onMemory = (pathname: string) => pathname.startsWith("/w/") && pathname.endsWith("/memory");

/**
 * Whether the title bar starts as a path on this page: an embedding app asked for it
 * (`threadsPage.bar: "path"`), and the page is a thread, a Board, a workspace's Memory or the New
 * form. Gram's other pages, and Gram on its own, keep the workspace and its views.
 */
export function usePathBar(): boolean {
  const asked = useEmbedShell((s) => s.threadsPage.bar === "path");
  const pathname = useLocation({ select: (location) => location.pathname });
  return asked && (pathname.startsWith("/t/") || onMemory(pathname) || isNewForm(pathname));
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
  const fresh = isNewForm(pathname);
  const noun = useThreadsWorkspaceNoun();
  const workspace = useViewWorkspace();
  const board = useViewStore((s) => s.view === "board");
  const route = useRouteThreadId();
  const place = useEmbedShell((s) =>
    route === undefined
      ? undefined
      : s.threadsPage.places?.find((each) => each.list !== undefined && each.ids.includes(route)),
  );
  const last =
    board ||
    onMemory(pathname) ||
    (route !== undefined && route === workspace?.workspace.orchestratorThreadId);
  return (
    <nav
      aria-label="Where you are"
      data-testid="titlebar-path"
      className={cn("flex min-w-0 shrink-0 items-center gap-1", NO_DRAG)}
    >
      <Link
        to={place?.list ?? "/threads"}
        data-testid="titlebar-path-root"
        className="shrink-0 rounded-(--radius-sm) px-2 text-body text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        {place?.name ?? title}
      </Link>
      <Step />
      {fresh && (
        <span aria-current="page" className="px-2 text-body font-medium text-foreground">
          {newFormName(pathname, noun)}
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

/** One of a workspace's places: its orchestrator's thread, its Board, its Memory. */
export interface WorkspacePlace {
  readonly key: "orchestrator" | "board" | "memory";
  readonly label: string;
  /** The window is on it. */
  readonly current: boolean;
  readonly go: () => void;
}

/**
 * The workspace's places, for the bar or a phone's row: its orchestrator's thread, in the
 * embedding app's word for one, its Board and its Memory. None on a solo thread or the New form.
 */
export function useWorkspacePlaces(solo: boolean): readonly WorkspacePlace[] | undefined {
  const pathname = useLocation({ select: (location) => location.pathname });
  const word = useEmbedShell((s) => s.threadsPage.kinds?.orchestrator ?? "Orchestrator");
  const workspace = useViewWorkspace();
  const board = useViewStore((s) => s.view === "board");
  const route = useRouteThreadId();
  const navigate = useNavigate();
  const openBoard = useOpenBoard();
  if (solo || isNewForm(pathname) || workspace === undefined) return undefined;
  const orchestrator = workspace.workspace.orchestratorThreadId;
  const workspaceId = workspace.workspace.id;
  return [
    ...(orchestrator === undefined
      ? []
      : [
          {
            key: "orchestrator" as const,
            label: word,
            current: !board && route === orchestrator,
            go: () => {
              const view = useViewStore.getState();
              view.setQuiet(false);
              view.setView("chat");
              useLayoutStore.getState().openThread(orchestrator);
              void navigate({ to: "/t/$threadId", params: { threadId: orchestrator } });
            },
          },
        ]),
    { key: "board", label: "Board", current: board, go: () => openBoard(workspaceId) },
    {
      key: "memory",
      label: "Memory",
      current: !board && onMemory(pathname),
      go: () => {
        useViewStore.getState().setView("chat");
        void navigate({ to: "/w/$workspaceId/memory", params: { workspaceId } });
      },
    },
  ];
}

/**
 * A workspace's places beside the path, as one segmented control: its orchestrator's thread, its
 * Board and its Memory. Nothing on a solo thread or the New form.
 */
export function TitlebarPathViews({ solo }: { solo: boolean }) {
  const places = useWorkspacePlaces(solo);
  const slab = useId();
  if (places === undefined) return null;
  return (
    <div
      role="group"
      aria-label="Workspace"
      data-testid="titlebar-path-views"
      className={cn("shrink-0 items-center", SEGMENT_TRACK, NO_DRAG)}
    >
      {places.map((place) => (
        <Button
          key={place.key}
          variant="ghost"
          size="xs"
          {...(place.key === "board"
            ? { "aria-pressed": place.current }
            : { "aria-current": place.current ? ("page" as const) : undefined })}
          {...(place.key === "memory" ? { "data-testid": "titlebar-path-memory" } : {})}
          className={PLACE}
          onClick={place.go}
        >
          {place.current && <SegmentSlab group={slab} className={SEGMENT_SLAB} />}
          {place.label}
        </Button>
      ))}
    </div>
  );
}
