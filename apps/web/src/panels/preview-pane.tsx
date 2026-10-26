import {
  checkoutRoots,
  localPortUrl,
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
  Bot,
  Circle,
  ExternalLink,
  Globe,
  Hand,
  RotateCw,
  ScanSearch,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useApi } from "@/api/context";
import { openContentUrl } from "@/api/open-external";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { spin } from "@/motion";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

import { errorMessage } from "@/api/errors";

import { showFileAt } from "./files/files-store";
import { MarkdownPreview } from "./files/markdown-preview";
import { markdownRoot } from "@/thread/preview-files";
import { BrowserInspectionPanel } from "./browser-inspection";
import { PanelMessage } from "./panel-message";
import { useCoveredByOverlay } from "./preview-cover";

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

const load = (bridge: DesktopPreview, threadId: string, id: number, url: string) => {
  const known = loads.get(threadId);
  if (known?.id === id) return known.done;
  const done = bridge.open(threadId, url);
  loads.set(threadId, { id, done });
  return done;
};

/**
 * The Preview tab: the thread's local app, drawn by the shell over the placeholder below the address
 * strip. The page is the shell's, one per thread and not this document's, so it is hidden while a
 * popup overlaps it and a message takes its place when it can't load.
 */
export function PreviewPane({ threadId }: { threadId: ThreadId }) {
  const bridge = previewBridge();
  const api = useApi();
  const page = useLayoutStore((s) => s.previewPages[threadId]);
  const openPreview = useLayoutStore((s) => s.openPreview);
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
  const placeholder = useRef<HTMLDivElement>(null);
  const covered = useCoveredByOverlay(placeholder);

  useEffect(() => bridge?.onState(threadId, setState), [bridge, threadId]);

  const pageId = page?.id;
  const driven = page?.driven === true;
  // A page another window opened, which the shell still holds: this window's requests start empty.
  useEffect(() => {
    if (bridge === undefined || pageId !== undefined) return;
    let live = true;
    void bridge.state(threadId).then((held) => {
      if (!live || held === null) return;
      loads.delete(threadId);
      // An agent's page, perhaps on a public host it was allowed, is shown as it is too.
      const id = adoptPreviewPage(threadId, held.url, held.driver !== undefined);
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
      let opened = await load(bridge, threadId, pageId, pageUrl);
      let next = opened ? await bridge.state(threadId) : null;
      if (opened && next === null) {
        // The shell closed the page for more recent threads': load where it had gone.
        loads.delete(threadId);
        opened = await load(bridge, threadId, pageId, pageUrl);
        next = opened ? await bridge.state(threadId) : null;
      }
      if (live) setState(next ?? unopened(pageUrl));
    })();
    return () => {
      live = false;
    };
  }, [bridge, threadId, pageId, pageUrl, driven]);

  // The shell's page is only this tab's while a page is what it shows: not over Markdown, nor while
  // a file's address is still being asked for.
  const current = page === undefined || pageUrl === undefined ? null : state;
  // Where the page went, so the tab comes back to it after the shell has closed it. A file is asked
  // for again instead: its address is the server's, and lasts only as long as the server.
  useEffect(() => {
    if (file === undefined && pageId !== undefined && current !== null && !current.loading) {
      notePreviewPage(threadId, { id: pageId, url: current.url, ...(driven ? { driven } : {}) });
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
    if (url !== undefined) openPreview(threadId, url);
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
            placeholder="localhost:3000 or a file path"
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
            className="h-7 w-full rounded-md border border-input bg-transparent px-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
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
        <p role="alert" className="border-b border-border px-3 py-1.5 text-xs text-destructive">
          Only an address on localhost opens here, such as localhost:3000, or the full path of a
          Markdown or HTML file.
        </p>
      )}
      {inspecting && !inspectionAvailable && (
        <p
          role="status"
          className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground"
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
              Your app shows here: start its dev server, then pick its port, or type a localhost
              address above. Markdown and HTML files the agent writes open here too. Other sites
              open in your browser.
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
                Try again
              </Button>
            </div>
          )
        )}
      </div>
    </div>
  );
}

/**
 * What the agent's latest input on the page is for, as it said ("Opens the Filters menu"), and
 * whether it is recording the page, so the user can follow along. While the user drives, frames
 * aren't taken, but the recording is still shown.
 */
function AgentActivity({
  driver,
  action,
  recording,
}: {
  driver: "agent" | "user" | undefined;
  action: { readonly summary: string; readonly at: number } | undefined;
  recording: boolean;
}) {
  // A recording is shown whoever drives; the agent's latest label only while it does.
  const label = driver === "agent" ? action : undefined;
  if (label === undefined && !recording) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="preview-activity"
      className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-1 text-xs text-muted-foreground"
    >
      {recording && (
        <span
          data-testid="preview-recording"
          className="flex shrink-0 items-center gap-1 text-destructive"
        >
          <Circle aria-hidden className="size-2.5 fill-current" />
          Recording
        </span>
      )}
      {label !== undefined && (
        <>
          <Bot aria-hidden className="size-3.5 shrink-0 text-status-working" />
          <span data-testid="preview-action" className="min-w-0 truncate" title={label.summary}>
            {label.summary}
          </span>
          <time
            className="ml-auto shrink-0 tabular-nums"
            dateTime={new Date(label.at).toISOString()}
          >
            {new Date(label.at).toLocaleTimeString(undefined, {
              hour12: false,
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </time>
        </>
      )}
    </div>
  );
}

/**
 * Who drives the page, once the thread's agent has used it: the agent, until the user clicks or
 * types in the page, and then the user, until they hand it back here.
 */
function DriverButton({
  driver,
  onHandBack,
  onTakeOver,
}: {
  driver: "agent" | "user" | undefined;
  onHandBack: (() => void) | undefined;
  onTakeOver: (() => void) | undefined;
}) {
  if (driver === undefined) return null;
  if (driver === "agent") {
    return (
      <span data-testid="preview-driver" data-driver="agent" className="contents">
        {onTakeOver === undefined ? (
          <Hint
            label="The agent is driving this page. Click or type in it to take over."
            render={
              <span
                role="img"
                aria-label="The agent is driving"
                tabIndex={0}
                className="flex size-6 items-center justify-center text-status-working"
              />
            }
          >
            <Bot aria-hidden className="size-4" />
          </Hint>
        ) : (
          <ToolButton
            label="Take control of this page; pause agent input"
            disabled={false}
            onClick={onTakeOver}
          >
            <Bot />
          </ToolButton>
        )}
      </span>
    );
  }
  return (
    <span data-testid="preview-driver" data-driver="user" className="contents">
      <ToolButton
        label="You have control. Hand the page back to the agent"
        disabled={onHandBack === undefined}
        onClick={() => onHandBack?.()}
      >
        <Hand />
      </ToolButton>
    </span>
  );
}

/** An icon button in the address strip, its hint above it: below, the page would cover it. */
function ToolButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Hint
      label={label}
      render={
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={label}
          disabled={disabled}
          className="shrink-0 text-muted-foreground"
          onClick={onClick}
        />
      }
    >
      {children}
    </Hint>
  );
}
