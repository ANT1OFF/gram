import {
  checkoutRoots,
  localPortUrl,
  loopbackUrl,
  previewAddress,
  previewFileKind,
  previewFileTarget,
  type DesktopPreview,
  type PreviewState,
  type ThreadId,
} from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  Pin,
  RotateCw,
  ScanSearch,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useApi } from "@/api/context";
import { openContentUrl } from "@/api/open-external";
import { Button } from "@/components/ui/button";
import { spin } from "@/motion";
import { useServerBrowser } from "@/settings/use-diagnostics";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

import { errorMessage } from "@/api/errors";

import { showFileAt } from "./files/files-store";
import { MarkdownPreview } from "./files/markdown-preview";
import { markdownRoot } from "@/thread/preview-files";
import { BrowserInspectionPanel } from "./browser-inspection";
import { PanelMessage } from "./panel-message";
import { showPage } from "@/pages/page-pane-store";
import { useCoveredByOverlay } from "./preview-cover";
import { AgentActivity, DriverButton, ToolButton } from "./preview-strip";
import { ServerPreview, useServerPage } from "./server-preview";

/** The shell's preview, or the mock API's stand-in for it; absent where neither has one. */
const previewBridge = (): DesktopPreview | undefined =>
  window.gram?.preview ?? window.gramMock?.shell.preview;

/** What the tab says of a page the shell refused or couldn't reach, such as an unforwardable port. */
const unopened = (url: string): PreviewState => ({
  url,
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  error: "it can't be opened here",
});

/**
 * The load of each thread's latest request, so coming back to its tab, or a second mount of it,
 * doesn't load the page again.
 */
const loads = new Map<string, { readonly id: number; readonly done: Promise<boolean> }>();

/** The requests whose typed web address was asked for already: each is asked for once. */
const typedSent = new Set<number>();

const load = (
  bridge: DesktopPreview,
  threadId: string,
  id: number,
  url: string,
  page: { readonly typed?: boolean; readonly webView?: string | undefined },
) => {
  const known = loads.get(threadId);
  if (known?.id === id) return known.done;
  // What the user typed opens in a session with their sign-ins, once. Their web page the shell
  // closed since is re-opened by the shell's own token and record, which it alone decides on.
  // Anything else, wherever it has gone since, opens on loopback only.
  let done: Promise<boolean>;
  if (page.typed === true && !typedSent.has(id)) {
    typedSent.add(id);
    done = bridge.openWeb?.(threadId, url) ?? Promise.resolve(false);
  } else if (page.webView !== undefined) {
    done = bridge.reopenWeb?.(threadId, page.webView) ?? Promise.resolve(false);
  } else {
    done = bridge.open(threadId, url);
  }
  loads.set(threadId, { id, done });
  return done;
};

/**
 * The Preview tab: the thread's local app, or any web page the user opens, drawn by the shell over
 * the placeholder below the address strip. The page is the shell's, one per thread and not this document's, so it is hidden while a
 * popup overlaps it and a message takes its place when it can't load.
 */
export function PreviewPane({ threadId }: { threadId: ThreadId }) {
  const bridge = previewBridge();
  // With no shell to draw a page (a browser tab), the page shown is the one the thread's agent
  // drives in the server's own browser, when the server runs one. A file the user opened here
  // keeps the tab until the agent browses again.
  const page = useLayoutStore((s) => s.previewPages[threadId]);
  const serverBrowser = useServerBrowser();
  const server = useServerPage(threadId, bridge === undefined && serverBrowser);
  if (server !== undefined && (page === undefined || page.driven === true))
    return <ServerPreview threadId={threadId} view={server} />;
  return <ShellPreview threadId={threadId} bridge={bridge} />;
}

function ShellPreview({
  threadId,
  bridge,
}: {
  threadId: ThreadId;
  bridge: DesktopPreview | undefined;
}) {
  const api = useApi();
  const page = useLayoutStore((s) => s.previewPages[threadId]);
  const openPreview = useLayoutStore((s) => s.openPreview);
  const openWebPreview = useLayoutStore((s) => s.openWebPreview);
  const previewFile = useLayoutStore((s) => s.previewFile);
  const notePreviewPage = useLayoutStore((s) => s.notePreviewPage);
  const adoptPreviewPage = useLayoutStore((s) => s.adoptPreviewPage);
  const ports = useThreadsStore((s) => s.byId[threadId]?.ports);
  const thread = useThreadsStore((s) => s.byId[threadId]?.thread);
  const roots = useMemo(
    () =>
      thread === undefined
        ? []
        : [...checkoutRoots(thread), ...(thread.additionalDirectories ?? [])],
    [thread],
  );
  const [state, setState] = useState<PreviewState | null>(null);
  const [draft, setDraft] = useState<string>();
  const [inspecting, setInspecting] = useState(false);
  const [refused, setRefused] = useState(false);
  const [pinning, setPinning] = useState(false);
  const [pinError, setPinError] = useState<string>();
  const placeholder = useRef<HTMLDivElement>(null);
  const covered = useCoveredByOverlay(placeholder);

  useEffect(() => bridge?.onState(threadId, setState), [bridge, threadId]);

  const pageId = page?.id;
  const driven = page?.driven === true;
  const typed = page?.typed === true;
  const webView = page?.webView;
  // A page another window opened, which the shell still holds: this window's requests start empty.
  useEffect(() => {
    if (bridge === undefined || pageId !== undefined) return;
    let live = true;
    void bridge.state(threadId).then((held) => {
      if (!live || held === null) return;
      loads.delete(threadId);
      // An agent's page, perhaps on a public host it was allowed, is shown as it is too.
      const id = adoptPreviewPage(threadId, held.url, held.driver !== undefined, held.webView);
      if (id !== undefined) loads.set(threadId, { id, done: Promise.resolve(true) });
    });
    return () => {
      live = false;
    };
  }, [bridge, threadId, pageId, adoptPreviewPage]);

  const file = page?.file;
  // A file asks the server first: Markdown's text to render here, or where an HTML page loads from.
  const filePreview = useQuery({
    queryKey: ["preview-file", threadId, file, pageId],
    queryFn: () => api.previewFile(threadId, file!),
    enabled: file !== undefined,
    retry: false,
    staleTime: Infinity,
  });
  const markdown = filePreview.data?.kind === "markdown" ? filePreview.data : undefined;
  // A mock opens at its board and theme: what follows the address the server gave.
  const at = page?.at ?? "";
  const pageUrl =
    file === undefined
      ? page?.url
      : filePreview.data?.kind === "html"
        ? `${filePreview.data.url}${at}`
        : undefined;
  useEffect(() => {
    if (bridge === undefined || pageId === undefined || pageUrl === undefined) return;
    let live = true;
    void (async () => {
      if (driven) {
        // The agent's page is in the shell already, wherever it has gone since.
        const next = await bridge.state(threadId);
        if (live) setState(next ?? unopened(pageUrl));
        return;
      }
      const first = load(bridge, threadId, pageId, pageUrl, { typed, webView });
      let opened = await first;
      let next = opened ? await bridge.state(threadId) : null;
      if (opened && next === null) {
        // The shell closed the page for more recent threads': load where it had gone, once, however
        // many mounts of the tab find it gone, since a re-open is good once.
        if (loads.get(threadId)?.done === first) loads.delete(threadId);
        opened = await load(bridge, threadId, pageId, pageUrl, { typed, webView });
        next = opened ? await bridge.state(threadId) : null;
      }
      if (live) setState(next ?? unopened(pageUrl));
    })();
    return () => {
      live = false;
    };
  }, [bridge, threadId, pageId, pageUrl, driven, typed, webView]);

  // The shell's page is only this tab's while a page is what it shows: not over Markdown, nor while
  // a file's address is still being asked for.
  const current = page === undefined || pageUrl === undefined ? null : state;
  // Where the page went, so the tab comes back to it after the shell has closed it. A file is asked
  // for again instead: its address is the server's, and lasts only as long as the server.
  useEffect(() => {
    if (file === undefined && pageId !== undefined && current !== null && !current.loading) {
      notePreviewPage(threadId, {
        id: pageId,
        url: current.url,
        ...(driven ? { driven } : {}),
        ...(current.webView === undefined ? {} : { webView: current.webView }),
      });
    }
  }, [threadId, pageId, file, current, driven, notePreviewPage]);

  const failed = current?.error !== undefined;
  const inspectionAvailable =
    current?.browserInspection !== undefined && bridge?.inspect !== undefined;
  const inspectionVisible = inspecting && inspectionAvailable;
  // Capability loss immediately restores the live view; the exit control stays usable.
  const showing =
    bridge !== undefined && current !== null && !failed && !covered && !inspectionVisible;
  useLayoutEffect(() => {
    const element = placeholder.current;
    if (bridge === undefined || element === null) return;
    if (!showing) {
      bridge.setBounds(threadId, null);
      return;
    }
    const place = () => {
      const rect = element.getBoundingClientRect();
      bridge.setBounds(threadId, {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      bridge.setBounds(threadId, null);
    };
  }, [bridge, threadId, showing]);

  const go = (target: string) => {
    const typedFile = previewFileTarget(target);
    const url = typedFile === undefined ? previewAddress(target) : undefined;
    setRefused(url === undefined && typedFile === undefined);
    // The one place a web page is asked for: the user typing it here.
    if (url !== undefined && loopbackUrl(url) !== undefined) openPreview(threadId, url);
    else if (url !== undefined) openWebPreview(threadId, url);
    else if (typedFile !== undefined) previewFile(threadId, typedFile, { previewPane: true });
  };
  // A file shows as its path, and its board, while the page is still the file the server served.
  const board = at.includes("#") ? at.slice(at.indexOf("#")) : "";
  const shownUrl =
    file !== undefined && (current === null || current.url === pageUrl)
      ? `${file}${board}`
      : (current?.url ?? pageUrl ?? "");
  const loading =
    page !== undefined &&
    (filePreview.isFetching || (markdown === undefined && (current === null || current.loading)));
  const fileFailed = file !== undefined && filePreview.isError;
  // Only the user pins, and only a page a thread of a workspace drafted as an HTML file: a copy of
  // its folder goes into Gram's state, so later edits in the worktree don't change it.
  const workspaceId = thread?.workspaceId;
  const pinnable =
    file !== undefined && filePreview.data?.kind === "html" && workspaceId !== undefined;
  const pin = async () => {
    if (file === undefined || workspaceId === undefined) return;
    setPinning(true);
    setPinError(undefined);
    try {
      const pinned = await api.pinPage(threadId, file);
      showPage(workspaceId, pinned.id);
    } catch (error) {
      setPinError(errorMessage(error).replace(/^InvalidState: /, ""));
    } finally {
      setPinning(false);
    }
  };

  return (
    <div data-testid="preview-pane" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-0.5 border-b border-border p-1.5">
        <ToolButton
          label="Back"
          disabled={current?.canGoBack !== true}
          onClick={() => bridge?.back(threadId)}
        >
          <ArrowLeft />
        </ToolButton>
        <ToolButton
          label="Forward"
          disabled={current?.canGoForward !== true}
          onClick={() => bridge?.forward(threadId)}
        >
          <ArrowRight />
        </ToolButton>
        <ToolButton
          label="Reload"
          disabled={current === null && markdown === undefined}
          onClick={() =>
            markdown === undefined ? bridge?.reload(threadId) : void filePreview.refetch()
          }
        >
          <RotateCw ref={loading ? spin : undefined} />
        </ToolButton>
        <form
          className="mx-1 min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft !== undefined) go(draft);
            setDraft(undefined);
          }}
        >
          <input
            data-testid="preview-address"
            aria-label="Preview address"
            placeholder="localhost:3000, a web address or a file path"
            spellCheck={false}
            title={current?.title || undefined}
            value={draft ?? shownUrl}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => {
              setDraft(event.target.value);
              setRefused(false);
            }}
            onBlur={() => setDraft(undefined)}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || draft === undefined) return;
              event.stopPropagation();
              setDraft(undefined);
            }}
            className="h-7 w-full rounded-md border border-input bg-transparent px-2 font-mono text-meta outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        </form>
        <ToolButton
          label={
            inspecting
              ? "Close browser inspection"
              : !inspectionAvailable
                ? "Browser inspection unavailable on this page or shell"
                : "Inspect page capture, action evidence and failures"
          }
          disabled={!inspecting && !inspectionAvailable}
          onClick={() => setInspecting((open) => !open)}
        >
          <ScanSearch />
        </ToolButton>
        <DriverButton
          driver={current?.driver}
          onTakeOver={
            bridge?.takeOver === undefined ? undefined : () => bridge.takeOver?.(threadId)
          }
          onHandBack={
            bridge?.handBack === undefined ? undefined : () => bridge.handBack?.(threadId)
          }
        />
        {pinnable && (
          <ToolButton
            label="Pin to Pages: keep a copy of this page in Gram"
            disabled={pinning}
            onClick={() => void pin()}
          >
            <Pin />
          </ToolButton>
        )}
        <ToolButton
          label="Open in your browser"
          disabled={(current?.url ?? pageUrl ?? "") === ""}
          onClick={() => void openContentUrl(api, current?.url ?? pageUrl ?? "")}
        >
          <ExternalLink />
        </ToolButton>
      </div>
      <AgentActivity
        driver={current?.driver}
        action={current?.action}
        recording={current?.recording === true}
      />
      {refused && (
        <p role="alert" className="border-b border-border px-3 py-1.5 text-meta text-destructive">
          Only a web address opens here, such as localhost:3000 or example.com, or the full path of
          a Markdown or HTML file.
        </p>
      )}
      {pinError !== undefined && (
        <p
          role="alert"
          data-testid="preview-pin-error"
          className="border-b border-border px-3 py-1.5 text-meta text-destructive"
        >
          {pinError}
        </p>
      )}
      {inspecting && !inspectionAvailable && (
        <p
          role="status"
          className="border-b border-border px-3 py-1.5 text-meta text-muted-foreground"
        >
          Browser inspection became unavailable. The live Preview is restored when readable; close
          inspection above.
        </p>
      )}
      <div
        ref={placeholder}
        data-testid="preview-placeholder"
        data-showing={showing || undefined}
        className="flex min-h-0 flex-1 flex-col"
      >
        {inspectionVisible && current?.browserInspection !== undefined && bridge !== undefined ? (
          <BrowserInspectionPanel
            key={threadId}
            threadId={threadId}
            bridge={bridge}
            inspection={current.browserInspection}
            onClose={() => setInspecting(false)}
          />
        ) : fileFailed ? (
          <div data-testid="preview-error" className="flex flex-col items-center gap-2">
            <PanelMessage>
              {file} can't be shown: {errorMessage(filePreview.error)}
            </PanelMessage>
          </div>
        ) : markdown !== undefined ? (
          <div data-testid="preview-markdown" className="min-h-0 flex-1 overflow-auto">
            <MarkdownPreview
              key={markdown.path}
              threadId={threadId}
              root={markdownRoot(markdown.path, roots)}
              path={markdown.path}
              content={markdown.content}
              onOpen={(target) => {
                // Another page stays here; any other file opens in Files, as from Files itself.
                if (previewFileKind(target) !== undefined) {
                  previewFile(threadId, target, { previewPane: true });
                } else {
                  showFileAt(threadId, roots, target);
                }
              }}
            />
          </div>
        ) : page === undefined ? (
          <div data-testid="preview-empty" className="flex flex-col items-center gap-2">
            <PanelMessage icon={Globe}>
              Your app shows here: start its dev server, then pick its port, or type any address
              above. Markdown and HTML files the agent writes open here too. Sites you open here are
              yours alone: agents never read or drive them.
            </PanelMessage>
            <div className="flex flex-wrap justify-center gap-1">
              {(ports ?? []).map((port) => (
                <Button
                  key={port}
                  type="button"
                  size="xs"
                  variant="outline"
                  className="font-mono"
                  onClick={() => openPreview(threadId, localPortUrl(port))}
                >
                  :{port}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          failed && (
            <div data-testid="preview-error" className="flex flex-col items-center gap-2">
              <PanelMessage>
                {shownUrl} didn't load: {current.error}
              </PanelMessage>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => bridge?.reload(threadId)}
              >
                Retry
              </Button>
            </div>
          )
        )}
      </div>
    </div>
  );
}
