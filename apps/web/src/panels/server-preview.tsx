// The Preview tab where no shell draws a page (a browser tab): the page the thread's agent drives
// in the server's own browser, drawn from the server's frames. A click, a key or a scroll in it
// takes the page over, as in the desktop app; it goes back to the agent with Hand back, or by
// itself once the person has sent nothing for a while.

import {
  VIEW_IDLE_MS,
  VIEW_INPUT_BATCH,
  viewInput,
  type BrowserViewEvent,
  type BrowserViewInput,
  type BrowserViewPage,
  type ThreadId,
} from "@gram/contracts";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Circle,
  Globe,
  HandGrab,
  LoaderCircle,
  RotateCw,
  Shield,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useApi } from "@/api/context";
import type { Api } from "@/api/types";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { formatLogTime } from "@/lib/time";
import { spin } from "@/motion";

import { ToolButton } from "./preview-strip";

type Frame = Extract<BrowserViewEvent, { type: "frame" }>;
type Status = Extract<BrowserViewEvent, { type: "page" }>["status"];

/** A thread's page on the server as the tab holds it. */
export interface ServerPage {
  readonly page: BrowserViewPage | null;
  readonly status: Status;
  /** False while the connection to the server is being reopened. */
  readonly connected: boolean;
  /** Whether a frame of the page has come: `frames.current` then has it. */
  readonly drawn: boolean;
  /** The latest frame, outside React's state: a page repaints many times a second. */
  readonly frames: {
    current: Frame | undefined;
    listen(listener: () => void): () => void;
  };
}

/** Follows the thread's page on the server, telling `changed` of each state; returns the end. */
const followServerPage = (
  api: Api,
  threadId: ThreadId,
  changed: (view: ServerPage | undefined) => void,
): (() => void) => {
  const abort = new AbortController();
  const listeners = new Set<() => void>();
  const frames: ServerPage["frames"] = {
    current: undefined,
    listen: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  let view: ServerPage = { page: null, status: undefined, connected: true, drawn: false, frames };
  const set = (next: Partial<ServerPage>) => {
    view = { ...view, ...next };
    if (!abort.signal.aborted) changed(view);
  };
  void (async () => {
    try {
      for await (const event of api.browserViewFeed(threadId, abort.signal)) {
        if (event.type === "dropped") set({ connected: false });
        else if (event.type === "page") {
          if (event.page === null) frames.current = undefined;
          set({
            page: event.page,
            status: event.status,
            connected: true,
            drawn: frames.current !== undefined,
          });
        } else {
          frames.current = event;
          if (!view.drawn || !view.connected) set({ drawn: true, connected: true });
          for (const listener of Array.from(listeners)) listener();
        }
      }
    } catch {
      // This server shows no page of its own: the tab is what it was without one.
      if (!abort.signal.aborted) changed(undefined);
    }
  })();
  return () => abort.abort();
};

/**
 * The thread's page in the server's own browser, while `enabled`; `undefined` until the server has
 * said it runs one, and for good when it runs none.
 */
export function useServerPage(threadId: ThreadId, enabled: boolean): ServerPage | undefined {
  const api = useApi();
  const [held, setHeld] = useState<{ readonly threadId: ThreadId; readonly view: ServerPage }>();
  useEffect(() => {
    if (!enabled) return;
    return followServerPage(api, threadId, (view) =>
      setHeld(view === undefined ? undefined : { threadId, view }),
    );
  }, [api, threadId, enabled]);
  return enabled && held?.threadId === threadId ? held.view : undefined;
}

/** Alt 1, Control 2, Meta 4, Shift 8. */
const modifiersOf = (event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}) =>
  (event.altKey ? 1 : 0) |
  (event.ctrlKey ? 2 : 0) |
  (event.metaKey ? 4 : 0) |
  (event.shiftKey ? 8 : 0);

// No middle button: on the server it would paste a selection every thread's page shares.
const BUTTONS = ["left", undefined, "right"] as const;

/** What a key types, when it types anything: a held Control or Command makes it a shortcut. */
export const typedBy = (event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey?: boolean;
}) => {
  // Control with Alt is AltGr, which types characters of its own on many keyboards.
  if (event.metaKey || (event.ctrlKey && event.altKey !== true)) return undefined;
  if (event.key === "Enter") return "\r";
  return Array.from(event.key).length === 1 ? event.key : undefined;
};

/** One key event as the page gets it. */
export const keyInput = (
  event: Pick<
    KeyboardEvent,
    "key" | "code" | "keyCode" | "repeat" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey"
  >,
  action: "down" | "up",
): BrowserViewInput => {
  const text = action === "down" ? typedBy(event) : undefined;
  return {
    type: "key",
    action,
    key: event.key.slice(0, 32),
    code: event.code.slice(0, 32),
    keyCode: Math.min(255, Math.max(0, Math.trunc(event.keyCode) || 0)),
    modifiers: modifiersOf(event),
    ...(text === undefined ? {} : { text }),
    ...(event.repeat ? { repeat: true } : {}),
  };
};

/**
 * Sends inputs in the order they happened, a batch at a time: the next goes once the last is
 * answered, so a slow connection gets fewer, fuller messages. Pointer moves waiting together
 * become the latest one.
 */
const inputSender = (api: Api, threadId: ThreadId) => {
  let waiting: BrowserViewInput[] = [];
  let sending = false;
  const flush = async () => {
    if (sending) return;
    sending = true;
    try {
      while (waiting.length > 0) {
        const batch = waiting.slice(0, VIEW_INPUT_BATCH);
        waiting = waiting.slice(batch.length);
        // An input lost to a dropped connection isn't sent again later, out of its moment.
        await api.browserViewInput(threadId, batch).catch(() => {
          waiting = [];
        });
      }
    } finally {
      sending = false;
    }
  };
  return (input: BrowserViewInput) => {
    const last = waiting.at(-1);
    if (
      input.type === "pointer" &&
      input.action === "move" &&
      last?.type === "pointer" &&
      last.action === "move"
    )
      waiting[waiting.length - 1] = input;
    else waiting.push(input);
    void flush();
  };
};

const IDLE_SECONDS = Math.round(VIEW_IDLE_MS / 1000);

export function ServerPreview({ threadId, view }: { threadId: ThreadId; view: ServerPage }) {
  const api = useApi();
  const { page, status, connected, drawn, frames } = view;
  const image = useRef<HTMLImageElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const leave = useRef<HTMLInputElement>(null);
  const send = useMemo(() => inputSender(api, threadId), [api, threadId]);
  const yours = page?.driver === "user";
  const live = page !== null && drawn;

  // Each frame goes straight to the image: no render for a repaint.
  useEffect(() => {
    // The image is there only while the page is drawn.
    if (!live) return;
    const draw = () => {
      const element = image.current;
      const frame = frames.current;
      if (element === null || frame === undefined) return;
      element.src = `data:image/jpeg;base64,${frame.jpeg}`;
      element.style.width = `${frame.width}px`;
      element.style.aspectRatio = `${frame.width} / ${frame.height}`;
    };
    draw();
    return frames.listen(draw);
  }, [frames, live]);

  /**
   * A point of the window in the page's own CSS pixels; `undefined` outside the drawn page, unless
   * `nearest` asks for the point of the page closest to it.
   */
  const pointOf = (event: { clientX: number; clientY: number }, nearest = false) => {
    const element = image.current;
    const frame = frames.current;
    if (element === null || frame === undefined) return undefined;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return undefined;
    const x = ((event.clientX - rect.left) * frame.width) / rect.width;
    const y = ((event.clientY - rect.top) * frame.height) / rect.height;
    if (nearest)
      return {
        x: Math.min(frame.width, Math.max(0, x)),
        y: Math.min(frame.height, Math.max(0, y)),
      };
    return x < 0 || y < 0 || x > frame.width || y > frame.height ? undefined : { x, y };
  };

  /** The button held down in the page, which is let go wherever the pointer is by then. */
  const pressed = useRef<(typeof BUTTONS)[number]>(undefined);
  useEffect(() => {
    if (!live) return;
    const up = (event: MouseEvent) => {
      const button = pressed.current;
      const at = pointOf(event, true);
      if (button === undefined || at === undefined) return;
      pressed.current = undefined;
      send({
        type: "pointer",
        action: "up",
        ...at,
        button,
        buttons: event.buttons & 27,
        clickCount: Math.min(3, Math.max(1, event.detail)),
        modifiers: modifiersOf(event),
      });
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
    // `pointOf` reads refs only.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [live, send]);

  // A wheel listener React adds can't stop the tab from scrolling too; this one can.
  useEffect(() => {
    const element = stage.current;
    if (element === null || !live) return;
    const wheel = (event: WheelEvent) => {
      const at = pointOf(event);
      if (at === undefined) return;
      event.preventDefault();
      const lines = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
      send({
        type: "wheel",
        ...at,
        deltaX: event.deltaX * lines,
        deltaY: event.deltaY * lines,
        modifiers: modifiersOf(event),
      });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
    // `pointOf` reads refs only.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [live, send]);

  const pointer = (event: React.MouseEvent, action: "move" | "down") => {
    // A drag goes on past the page's edge, at the nearest point of it.
    const at = pointOf(event, action === "move" && pressed.current !== undefined);
    if (at === undefined) return;
    // The agent's page takes no pointer passing over it; the server would drop it too.
    if (action === "move" && !yours) return;
    if (action === "down" && BUTTONS[event.button] === undefined) return;
    if (action === "down") {
      stage.current?.focus();
      pressed.current = BUTTONS[event.button];
    }
    event.preventDefault();
    send({
      type: "pointer",
      action,
      ...at,
      button: action === "move" ? "none" : (BUTTONS[event.button] ?? "none"),
      buttons: event.buttons & 27,
      clickCount: action === "move" ? 0 : Math.min(3, Math.max(1, event.detail)),
      modifiers: modifiersOf(event),
    });
  };

  const key = (event: React.KeyboardEvent, action: "down" | "up") => {
    if (!live) return;
    // The way out for someone without a pointer: every other key is the page's while it has the
    // focus, Tab and Escape among them.
    if (event.key === "Escape" && event.shiftKey) {
      event.preventDefault();
      if (action === "down") leave.current?.focus();
      return;
    }
    // Only what the page may get is taken from the app: Command's shortcuts, the function keys
    // and any other shortcut stay the app's and the browser's.
    const input = keyInput(event.nativeEvent, action);
    if (event.metaKey || event.key === "Meta" || viewInput(input) === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    send(input);
  };

  const control = (op: "back" | "forward" | "reload" | "handBack") =>
    void api.browserViewControl(threadId, op).catch(() => {});

  const state = !connected
    ? "reconnecting"
    : live
      ? yours
        ? "yours"
        : "agent"
      : status?.kind === "starting" || page !== null
        ? "starting"
        : status?.kind === "failed"
          ? "failed"
          : "empty";

  const [addressFocused, setAddressFocused] = useState(false);

  return (
    <div
      data-testid="server-preview"
      data-state={state}
      className="@container flex min-h-0 flex-1 flex-col"
    >
      <div className="flex items-center gap-0.5 border-b border-border p-1.5">
        <ToolButton
          label="Back"
          disabled={page?.canGoBack !== true}
          onClick={() => control("back")}
        >
          <ArrowLeft />
        </ToolButton>
        <ToolButton
          label="Forward"
          disabled={page?.canGoForward !== true}
          onClick={() => control("forward")}
        >
          <ArrowRight />
        </ToolButton>
        <ToolButton label="Reload" disabled={page === null} onClick={() => control("reload")}>
          <RotateCw ref={page?.loading === true ? spin : undefined} />
        </ToolButton>
        <div className="mx-1 flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-input pr-2 pl-1 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
          <Hint
            label={WHERE}
            render={
              <span
                data-testid="server-preview-where"
                tabIndex={0}
                aria-label={WHERE}
                className="flex h-5 shrink-0 items-center gap-1 rounded-sm bg-muted px-1.5 text-meta text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              />
            }
          >
            <Shield aria-hidden className="size-icon-row" />
            {/* The word where the panel has room for it and the address both. */}
            <span className="hidden @lg:inline">Server</span>
          </Hint>
          <input
            ref={leave}
            data-testid="preview-address"
            aria-label="Preview address"
            placeholder="No page yet"
            readOnly
            spellCheck={false}
            title={page?.title || undefined}
            // As a browser shows it: the whole address once it is being read or copied.
            value={addressFocused ? (page?.url ?? "") : shownAddress(page?.url ?? "")}
            onFocus={(event) => {
              setAddressFocused(true);
              const input = event.currentTarget;
              requestAnimationFrame(() => input.select());
            }}
            onBlur={() => setAddressFocused(false)}
            className="h-full min-w-0 flex-1 bg-transparent font-mono text-meta outline-none"
          />
        </div>
      </div>
      {page !== null && (
        <div
          role="status"
          aria-live="polite"
          data-testid="server-preview-status"
          className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-border px-3 py-1.5 text-meta text-muted-foreground"
        >
          {state === "reconnecting" ? (
            <span data-testid="server-preview-reconnecting" className="flex items-center gap-1.5">
              <LoaderCircle aria-hidden ref={spin} className="size-icon-row" />
              Reconnecting to the server's browser…
            </span>
          ) : (
            <>
              {page.recording === true && (
                <span
                  data-testid="preview-recording"
                  className="flex shrink-0 items-center gap-1 text-destructive"
                >
                  <Circle aria-hidden className="size-2.5 fill-current" />
                  <span className="@lg:hidden" aria-hidden>
                    Rec
                  </span>
                  <span className="sr-only @lg:not-sr-only">Recording</span>
                </span>
              )}
              <span
                data-testid="preview-driver"
                data-driver={yours ? "user" : "agent"}
                className="flex shrink-0 items-center gap-1 font-medium text-foreground"
              >
                {yours ? (
                  <HandGrab aria-hidden className="size-icon-row text-primary" />
                ) : (
                  <Bot aria-hidden className="size-icon-row text-status-working" />
                )}
                {yours ? "You're driving" : "Agent driving"}
              </span>
              {yours ? (
                <>
                  {/* In a narrow panel the button ends the first line and the rest takes the next. */}
                  <span className="order-3 flex min-w-0 basis-full flex-wrap items-center gap-x-2 @lg:order-none @lg:flex-1 @lg:basis-auto">
                    <span data-testid="server-preview-yours">
                      Agent resumes after {IDLE_SECONDS} s idle
                    </span>
                    <span className="shrink-0">
                      <Key>Shift</Key>
                      <Key>Esc</Key>to leave
                    </span>
                  </span>
                  <Hint
                    label="You have control. Hand the page back to the agent"
                    render={
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        data-testid="server-preview-hand-back"
                        className="order-2 ml-auto shrink-0 @lg:order-none"
                        onClick={() => control("handBack")}
                      />
                    }
                  >
                    <HandGrab aria-hidden />
                    Hand back
                  </Hint>
                </>
              ) : (
                <>
                  {page.action !== undefined && (
                    <span className="flex min-w-0 flex-[1_1_8rem] items-baseline gap-2">
                      <span
                        data-testid="preview-action"
                        className="min-w-0 truncate"
                        title={page.action.summary}
                      >
                        {page.action.summary}
                      </span>
                      <time
                        className="shrink-0 tabular-nums"
                        dateTime={new Date(page.action.at).toISOString()}
                      >
                        {formatLogTime(page.action.at)}
                      </time>
                    </span>
                  )}
                  {live && (
                    <span data-testid="server-preview-hint" className="shrink-0">
                      Click or type in the page to take over
                    </span>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}
      <div
        ref={stage}
        data-testid="server-preview-stage"
        // The page takes the keys while it has the focus, as a page in a pane would.
        tabIndex={live ? 0 : -1}
        role={live ? "application" : undefined}
        aria-label={live ? `The agent's page: ${page.title || page.url}` : undefined}
        onMouseDown={(event) => pointer(event, "down")}
        onMouseMove={(event) => pointer(event, "move")}
        onContextMenu={(event) => {
          if (live) event.preventDefault();
        }}
        onKeyDown={(event) => key(event, "down")}
        onKeyUp={(event) => key(event, "up")}
        className={`relative flex min-h-0 flex-1 justify-center overflow-hidden bg-muted/30 outline-none ${live ? "items-start" : "items-center"}`}
      >
        {live ? (
          <img
            ref={image}
            data-testid="server-preview-frame"
            alt=""
            draggable={false}
            className={`max-h-full max-w-full select-none -outline-offset-2 ${connected ? "" : "opacity-45"} ${
              yours ? "outline-2 outline-ring" : "shadow-[0_0_0_1px_var(--border)]"
            }`}
          />
        ) : state === "failed" && status?.kind === "failed" ? (
          <Notice
            testId="server-preview-failed"
            role="alert"
            icon={TriangleAlert}
            tone="error"
            title="The server's browser couldn't open a page"
          >
            <span className="block rounded-md bg-muted px-2 py-1 font-mono text-meta break-words text-foreground">
              {status.message}
            </span>
            <span className="mt-2 block">The agent's next browser command tries again.</span>
          </Notice>
        ) : state === "empty" ? (
          <Notice testId="server-preview-empty" icon={Globe} title="No page yet">
            When the agent browses, its page shows here live, from the server's browser. It opens
            addresses on the server only, such as its dev servers.
          </Notice>
        ) : (
          state === "starting" && (
            <Notice
              testId="server-preview-starting"
              icon={LoaderCircle}
              spinning
              title="Starting the browser on the server…"
            >
              The agent's page shows here once it opens.
            </Notice>
          )
        )}
      </div>
    </div>
  );
}

/** What the "Server" mark in the address says of where the page runs. */
const WHERE =
  "On the server's browser: it opens addresses on the server only, such as its dev servers.";

/** An address as the strip shows it at rest: without `http://`, as a browser's own bar does. */
export const shownAddress = (url: string) => url.replace(/^https?:\/\//, "");

function Key({ children }: { children: ReactNode }) {
  return (
    <kbd className="mr-1 rounded-sm border border-border bg-muted px-1 font-sans text-caption text-foreground">
      {children}
    </kbd>
  );
}

/** What the tab says in the page's place while there is none: a mark, what is so, and what next. */
function Notice({
  testId,
  role = "status",
  icon: Icon,
  tone,
  spinning = false,
  title,
  children,
}: {
  testId: string;
  role?: "status" | "alert";
  icon: LucideIcon;
  tone?: "error";
  spinning?: boolean;
  title: string;
  children: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      role={role}
      className="flex max-w-88 flex-col items-center gap-2 p-6 text-center"
    >
      <Icon
        aria-hidden
        ref={spinning ? spin : undefined}
        className={`size-icon-empty ${tone === "error" ? "text-destructive" : "text-muted-foreground"}`}
      />
      <p className="text-reading font-medium text-balance text-foreground">{title}</p>
      <div className="text-body text-muted-foreground">{children}</div>
    </div>
  );
}
