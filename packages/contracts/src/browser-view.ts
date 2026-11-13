// Watching and driving an agent's page in the browser a server runs for itself (the headless
// browser host): what the page is, its frames, and the input a person sends it. Plain types and
// checks with no schema behind them, for the host, which doesn't bundle Effect.

/** The agent's page as a watcher's Preview tab shows it: a `PreviewState` without a shell. */
export interface ViewPage {
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  /** Who drives the page: its agent, or a person who clicked or typed in it. */
  readonly driver?: "agent" | "user" | undefined;
  /** What the agent said its latest input does, and when it sent it. */
  readonly action?: { readonly summary: string; readonly at: number } | undefined;
  readonly recording?: boolean | undefined;
}

/** Why a thread has no page to show: its browser is starting, or couldn't open one. */
export type ViewStatus =
  | { readonly kind: "starting" }
  | { readonly kind: "failed"; readonly message: string };

/**
 * How long a person keeps the page after their last input: then it is the agent's again, so an
 * agent isn't left waiting on someone who walked away.
 */
export const VIEW_IDLE_MS = 20_000;

/** How long the host keeps sending a thread's page after the server last asked for it. */
export const VIEW_LEASE_MS = 6_000;

/** How often the server asks again while someone watches. */
export const VIEW_RENEW_MS = 2_000;

/** The most inputs one message carries. */
export const VIEW_INPUT_BATCH = 64;

/** Alt 1, Control 2, Meta 4, Shift 8: the DevTools Protocol's modifier bits. */
export type ViewModifiers = number;

export type ViewButton = "none" | "left" | "middle" | "right";

/** One input from a watcher, in the page's own CSS pixels. */
export type ViewInput =
  | {
      readonly type: "pointer";
      readonly action: "move" | "down" | "up";
      readonly x: number;
      readonly y: number;
      readonly button: ViewButton;
      /** The buttons held, as the DOM's `MouseEvent.buttons`. */
      readonly buttons: number;
      readonly clickCount: number;
      readonly modifiers: ViewModifiers;
    }
  | {
      readonly type: "wheel";
      readonly x: number;
      readonly y: number;
      readonly deltaX: number;
      readonly deltaY: number;
      readonly modifiers: ViewModifiers;
    }
  | {
      readonly type: "key";
      readonly action: "down" | "up";
      /** The DOM's `KeyboardEvent.key` and `code`, and its legacy `keyCode`. */
      readonly key: string;
      readonly code: string;
      readonly keyCode: number;
      /** What the key types, when it types anything. */
      readonly text?: string | undefined;
      readonly modifiers: ViewModifiers;
      readonly repeat?: boolean | undefined;
    };

/** What the strip's buttons do to the page. `handBack` gives it back to its agent at once. */
export type ViewControl = "back" | "forward" | "reload" | "handBack";

const VIEW_CONTROLS: ReadonlySet<string> = new Set(["back", "forward", "reload", "handBack"]);
const BUTTONS: ReadonlySet<string> = new Set(["none", "left", "middle", "right"]);

/** The server asks the host to send a thread's page and frames, for `VIEW_LEASE_MS` more. */
export interface ViewWatchMessage {
  readonly type: "pane.view.watch";
  readonly threadId: string;
}

export interface ViewInputMessage {
  readonly type: "pane.view.input";
  readonly threadId: string;
  readonly inputs: ReadonlyArray<ViewInput>;
}

export interface ViewControlMessage {
  readonly type: "pane.view.control";
  readonly threadId: string;
  readonly op: ViewControl;
}

/** The host's word on a watched thread's page: `null` while it has none, and then why. */
export interface ViewPageMessage {
  readonly type: "pane.view.page";
  readonly threadId: string;
  readonly page: ViewPage | null;
  readonly status?: ViewStatus | undefined;
}

/** One frame of a watched thread's page: a JPEG, and the page's size in its own CSS pixels. */
export interface ViewFrameMessage {
  readonly type: "pane.view.frame";
  readonly threadId: string;
  readonly jpeg: string;
  readonly width: number;
  readonly height: number;
}

export type ViewServerMessage = ViewWatchMessage | ViewInputMessage | ViewControlMessage;
export type ViewHostMessage = ViewPageMessage | ViewFrameMessage;

const within = (value: unknown, low: number, high: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= low && value <= high;

const whole = (value: unknown, low: number, high: number): value is number =>
  within(value, low, high) && Number.isInteger(value);

const short = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max;

/** The longest frame carried, in base64 characters: far above what a page's JPEG comes to. */
const FRAME_MAX = 8_000_000;

/** The farthest a point may be from the page's corner, and the most one wheel event scrolls. */
const FAR = 100_000;

/** `raw` as one input, or `undefined` when it isn't one: nothing unchecked reaches the browser. */
export function viewInput(raw: unknown): ViewInput | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (!whole(r["modifiers"], 0, 15)) return undefined;
  const modifiers = r["modifiers"];
  if (r["type"] === "key") {
    const { action, key, code, keyCode, text, repeat } = r;
    if (action !== "down" && action !== "up") return undefined;
    if (!short(key, 32) || !short(code, 32) || !whole(keyCode, 0, 255)) return undefined;
    if (text !== undefined && !short(text, 8)) return undefined;
    return {
      type: "key",
      action,
      key,
      code,
      keyCode,
      modifiers,
      ...(text === undefined || text === "" ? {} : { text }),
      ...(repeat === true ? { repeat } : {}),
    };
  }
  if (!within(r["x"], 0, FAR) || !within(r["y"], 0, FAR)) return undefined;
  const { x, y } = r;
  if (r["type"] === "wheel") {
    const { deltaX, deltaY } = r;
    if (!within(deltaX, -FAR, FAR) || !within(deltaY, -FAR, FAR)) return undefined;
    return { type: "wheel", x, y, deltaX, deltaY, modifiers };
  }
  if (r["type"] !== "pointer") return undefined;
  const { action, button, buttons, clickCount } = r;
  if (action !== "move" && action !== "down" && action !== "up") return undefined;
  if (typeof button !== "string" || !BUTTONS.has(button)) return undefined;
  if (!whole(buttons, 0, 31) || !whole(clickCount, 0, 3)) return undefined;
  return {
    type: "pointer",
    action,
    x,
    y,
    button: button as ViewButton,
    buttons,
    clickCount,
    modifiers,
  };
}

/** Whether an input is a person acting on the page, which takes it over: not a pointer's move or a release. */
export const viewInputTakes = (input: ViewInput): boolean =>
  input.type === "wheel" || input.action === "down";

/** A message from the server about a thread's view, checked; `undefined` for anything else. */
export function viewServerMessage(raw: unknown): ViewServerMessage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const m = raw as { type?: unknown; threadId?: unknown; inputs?: unknown; op?: unknown };
  if (!short(m.threadId, 200) || m.threadId === "") return undefined;
  const { threadId } = m;
  if (m.type === "pane.view.watch") return { type: m.type, threadId };
  if (m.type === "pane.view.control")
    return typeof m.op === "string" && VIEW_CONTROLS.has(m.op)
      ? { type: m.type, threadId, op: m.op as ViewControl }
      : undefined;
  if (m.type !== "pane.view.input") return undefined;
  if (!Array.isArray(m.inputs) || m.inputs.length > VIEW_INPUT_BATCH) return undefined;
  const inputs = m.inputs.flatMap((each) => viewInput(each) ?? []);
  return { type: m.type, threadId, inputs };
}

/** A message from the host about a thread's view; `undefined` for anything else. */
export function viewHostMessage(raw: unknown): ViewHostMessage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const m = raw as Record<string, unknown>;
  if (typeof m["threadId"] !== "string") return undefined;
  if (m["type"] === "pane.view.page") {
    const page = m["page"];
    if (page !== null && (typeof page !== "object" || page === undefined)) return undefined;
    return m as unknown as ViewPageMessage;
  }
  if (m["type"] !== "pane.view.frame") return undefined;
  return short(m["jpeg"], FRAME_MAX) && within(m["width"], 1, FAR) && within(m["height"], 1, FAR)
    ? (m as unknown as ViewFrameMessage)
    : undefined;
}
