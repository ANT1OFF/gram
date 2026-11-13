import type { DesktopPages, PageId, PageMeta, PageViewState, WorkspaceId } from "@gram/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { AppWindow, ChevronLeft, RotateCw } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { EmptyState } from "@/components/empty-state";
import { Hint } from "@/components/hint";
import { QueryError } from "@/components/not-available";
import { Button } from "@/components/ui/button";
import { formatStamp } from "@/lib/time";
import { useNow } from "@/lib/use-now";
import { PanelMessage } from "@/panels/panel-message";
import { useCoveredByOverlay } from "@/panels/preview-cover";
import { useLayoutStore } from "@/stores/layout";

import { usePagePane } from "./page-pane-store";
import { usePageAddress, usePages } from "./page-queries";

/** The shell's pinned pages, or the mock API's stand-in; absent where neither has them. */
const pagesBridge = (): DesktopPages | undefined =>
  window.gram?.pages ?? window.gramMock?.shell.pages;

/**
 * The right panel's Pages tab: the pages the user pinned in the workspace the window is on, or the
 * one a row opened. A pinned page is a copy in Gram's state on this computer, drawn by the shell in
 * a session of its own that no agent reaches; Gram's chrome above it says what it is and who made it.
 */
export function PagesPanel({ workspaceId }: { workspaceId: WorkspaceId | undefined }) {
  const open = usePagePane((s) => (workspaceId === undefined ? undefined : s.open[workspaceId]));
  const setOpen = usePagePane((s) => s.setOpen);
  if (workspaceId === undefined) {
    return (
      <PanelMessage>
        Pages belong to a workspace. Open a workspace or one of its threads to see them.
      </PanelMessage>
    );
  }
  if (open !== undefined) {
    return (
      <PageView
        key={open}
        workspaceId={workspaceId}
        id={open}
        onBack={() => setOpen(workspaceId, undefined)}
      />
    );
  }
  return <PagesList workspaceId={workspaceId} />;
}

function PagesList({ workspaceId }: { workspaceId: WorkspaceId }) {
  const pages = usePages(workspaceId);
  const setOpen = usePagePane((s) => s.setOpen);
  const setPanelTab = useLayoutStore((s) => s.setPanelTab);
  const ref = useRef<HTMLElement>(null);
  const now = useNow(true, ref, 60_000);
  if (pages.error) return <QueryError error={pages.error} feature="Pages" />;
  if (pages.data === undefined) return <PanelMessage loading>Reading pages…</PanelMessage>;
  const list = pages.data.pages;
  if (list.length === 0) {
    return (
      <EmptyState
        testId="pages-empty"
        icon={AppWindow}
        title="No pages yet"
        line="Pin an HTML page an agent made from the Preview tab to keep it here. It stays on this computer, and agents can't change it."
        action={{ label: "Open Preview", onClick: () => setPanelTab("preview") }}
      />
    );
  }
  return (
    <section
      ref={ref}
      aria-label="Pages"
      data-testid="pages-list"
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4"
    >
      <p className="text-meta text-muted-foreground">
        Pages you pinned from Preview. Each is a copy kept in Gram on this computer, with no network
        and nothing of yours to read.
      </p>
      <ul className="flex flex-col gap-1">
        {list.map((page) => (
          <li key={page.id}>
            <PageRow page={page} now={now} onOpen={() => setOpen(workspaceId, page.id)} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function PageRow({ page, now, onOpen }: { page: PageMeta; now: number; onOpen: () => void }) {
  return (
    <button
      type="button"
      data-testid="page-row"
      data-page-id={page.id}
      aria-label={`Open ${page.title}`}
      className="flex w-full items-start gap-3 rounded-md border border-edge bg-card px-2.5 py-2 text-start outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onOpen}
    >
      <AppWindow aria-hidden className="mt-0.5 size-icon-row shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-body-strong">{page.title}</span>
        <span className="block truncate text-meta text-muted-foreground">
          From {page.authorTitle} · {formatStamp(page.pinnedAt, now)}
          {page.offer === undefined ? "" : " · newer version"}
        </span>
      </span>
    </button>
  );
}

/**
 * One pinned page: Gram's own header (its title, the thread that made it, when it was pinned),
 * a notice when an agent offered a newer version, and the page itself, drawn by the shell over the
 * placeholder. The page never changes under the user: an offer waits for their Show it.
 */
function PageView({
  workspaceId,
  id,
  onBack,
}: {
  workspaceId: WorkspaceId;
  id: PageId;
  onBack: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const bridge = pagesBridge();
  const pages = usePages(workspaceId);
  const page = pages.data?.pages.find((p) => p.id === id);
  const address = usePageAddress(workspaceId, id, page?.version);
  const ref = useRef<HTMLElement>(null);
  const now = useNow(true, ref, 60_000);
  const placeholder = useRef<HTMLDivElement>(null);
  const covered = useCoveredByOverlay(placeholder);
  const [state, setState] = useState<PageViewState>({ loading: true });
  /** What the shell said to the latest open, for the address and attempt it was asked for. */
  const [answer, setAnswer] = useState<{ url: string; attempt: number; ok: boolean }>();
  const [acting, setActing] = useState<string | undefined>();
  const [actError, setActError] = useState<string | undefined>();
  /** Bumped by Retry, which opens the page again. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => bridge?.onState(id, setState), [bridge, id]);
  const url = address.data?.url;
  useEffect(() => {
    if (bridge === undefined || url === undefined) return;
    let live = true;
    void bridge.open(id, url).then((ok) => {
      if (live) setAnswer({ url, attempt, ok });
    });
    return () => {
      live = false;
    };
  }, [bridge, id, url, attempt]);
  const opened =
    answer !== undefined && answer.url === url && answer.attempt === attempt
      ? answer.ok
      : undefined;
  // The server restarted on another port: what was open came from the old address.
  const refetchAddress = address.refetch;
  useEffect(() => {
    if (state.error === "Gram restarted") void refetchAddress();
  }, [state.error, refetchAddress]);

  const showing = bridge !== undefined && opened === true && state.error === undefined && !covered;
  useLayoutEffect(() => {
    const element = placeholder.current;
    if (bridge === undefined || element === null) return;
    if (!showing) {
      bridge.setBounds(id, null);
      return;
    }
    const place = () => {
      const rect = element.getBoundingClientRect();
      bridge.setBounds(id, { x: rect.left, y: rect.top, width: rect.width, height: rect.height });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      bridge.setBounds(id, null);
    };
  }, [bridge, id, showing]);

  const act = async (name: string, run: () => Promise<unknown>) => {
    setActing(name);
    setActError(undefined);
    try {
      await run();
      await queryClient.invalidateQueries({ queryKey: ["pages", workspaceId] });
    } catch (error) {
      setActError(errorMessage(error).replace(/^InvalidState: /, ""));
    } finally {
      setActing(undefined);
    }
  };

  const back = (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      className="-ms-1.5 self-start text-muted-foreground"
      data-testid="page-back"
      onClick={onBack}
    >
      <ChevronLeft data-icon="inline-start" />
      All pages
    </Button>
  );
  if (pages.error) {
    return (
      <section className="flex flex-col gap-3 px-4 py-4">
        {back}
        <QueryError error={pages.error} feature="Pages" />
      </section>
    );
  }
  if (pages.data === undefined) {
    return (
      <section className="flex flex-col gap-3 px-4 py-4">
        {back}
        <PanelMessage loading>Reading pages…</PanelMessage>
      </section>
    );
  }
  if (page === undefined) {
    return (
      <section className="flex flex-col gap-3 px-4 py-4">
        {back}
        <PanelMessage>This page isn't pinned any more</PanelMessage>
      </section>
    );
  }
  const offer = page.offer;
  const failed = address.error ?? (opened === false ? "it can't be opened here" : state.error);

  return (
    <article
      ref={ref}
      aria-label={page.title}
      data-testid="page-view"
      data-page-id={page.id}
      data-version={page.version}
      className="flex min-h-0 flex-1 flex-col"
    >
      {/* Gram's chrome, never the page's: what it is, who made it, and what may change it. */}
      <header className="flex flex-col gap-1 border-b border-border px-4 pt-3 pb-2">
        {back}
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 data-testid="page-title" className="text-title text-pretty">
              {page.title}
            </h2>
            <p data-testid="page-meta" className="text-meta text-muted-foreground">
              Made in {page.authorTitle} · pinned {formatStamp(page.pinnedAt, now)}
              {page.version > 1 && ` · version ${page.version}`}
            </p>
          </div>
          <Hint
            label="Reload"
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="Reload"
                disabled={bridge === undefined || opened !== true}
                className="shrink-0 text-muted-foreground"
                onClick={() => bridge?.reload(id)}
              />
            }
          >
            <RotateCw />
          </Hint>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            data-testid="page-unpin"
            disabled={acting !== undefined}
            onClick={() =>
              void act("unpin", async () => {
                await api.unpinPage(workspaceId, id);
                bridge?.close(id);
                onBack();
              })
            }
          >
            Unpin
          </Button>
        </div>
        {offer !== undefined && (
          <p
            role="status"
            data-testid="page-offer"
            data-version={offer.version}
            className="text-meta text-muted-foreground"
          >
            Newer version from {offer.threadTitle} ·{" "}
            <Button
              type="button"
              variant="link"
              data-testid="page-show-offer"
              disabled={acting !== undefined}
              className="h-auto p-0 text-meta"
              onClick={() =>
                void act("show", () => api.showPageOffer(workspaceId, id, offer.version))
              }
            >
              Show it
            </Button>
          </p>
        )}
        {actError !== undefined && (
          <p role="alert" data-testid="page-error" className="text-meta text-destructive">
            {actError}
          </p>
        )}
      </header>
      <div
        ref={placeholder}
        data-testid="page-placeholder"
        data-showing={showing || undefined}
        className="flex min-h-0 flex-1 flex-col"
      >
        {bridge === undefined ? (
          <PanelMessage icon={AppWindow}>
            Pinned pages open in the Gram app on this computer.
          </PanelMessage>
        ) : failed !== undefined ? (
          <div data-testid="page-failed" className="flex flex-col items-center gap-2">
            <PanelMessage>
              {page.title} didn't load: {typeof failed === "string" ? failed : errorMessage(failed)}
            </PanelMessage>
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => {
                void address.refetch();
                setAttempt((n) => n + 1);
              }}
            >
              Retry
            </Button>
          </div>
        ) : null}
      </div>
    </article>
  );
}
