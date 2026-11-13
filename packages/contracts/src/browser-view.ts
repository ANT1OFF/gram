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
  /**
   * The server has nothing of the page yet (its first watcher just came): the host says what the
   * page is and sends a frame again, even where it is still sending them from an earlier watch.
   */
  readonly fresh?: boolean | undefined;
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

const ALT = 1;
const CONTROL = 2;
const META = 4;
const SHIFT = 8;

/**
 * The keys that go with Control or Command: editing a field and moving in it, by the key code
 * the browser reads a shortcut from, each with the names it may carry. Nothing else does, since a
 * browser has shortcuts of its own (a new window, its developer tools, closing the page) that no
 * check on a page's requests covers. Copy, cut and paste are left out too: every thread's page
 * shares the one clipboard of the server's browser.
 */
const CHORD_KEYS: ReadonlyMap<number, { readonly keys: readonly string[]; readonly code: string }> =
  new Map([
    [65, { keys: ["a"], code: "KeyA" }],
    [89, { keys: ["y"], code: "KeyY" }],
    [90, { keys: ["z"], code: "KeyZ" }],
    [8, { keys: ["backspace"], code: "Backspace" }],
    [46, { keys: ["delete"], code: "Delete" }],
    [35, { keys: ["end"], code: "End" }],
    [36, { keys: ["home"], code: "Home" }],
    [37, { keys: ["arrowleft"], code: "ArrowLeft" }],
    [38, { keys: ["arrowup"], code: "ArrowUp" }],
    [39, { keys: ["arrowright"], code: "ArrowRight" }],
    [40, { keys: ["arrowdown"], code: "ArrowDown" }],
  ]);

/** With Shift as well, only undoing a redo and selecting while moving: not deleting. */
const SHIFT_CHORD_KEYS: ReadonlySet<number> = new Set([90, 35, 36, 37, 38, 39, 40]);

/** Whether `text` is one character a key types: nothing a browser takes for a control key. */
const printable = (text: string | undefined): text is string =>
  text !== undefined &&
  Array.from(text).length === 1 &&
  (text === "\r" || text >= " ") &&
  text !== "\u007f";

/**
 * A key as the page may get it, or `undefined` for one it may not: a function key, a browser or
 * media key, and any shortcut outside `CHORD_KEYS`. A key that types a character while Alt is
 * held (AltGr, or Option on a Mac) is that character, without the modifiers.
 */
const allowedKey = (
  key: string,
  code: string,
  keyCode: number,
  text: string | undefined,
  modifiers: number,
): { code: string; text: string | undefined; modifiers: number } | undefined => {
  // F1 to F24, and the browser's own keys (back, refresh, search) with the media keys.
  if ((keyCode >= 112 && keyCode <= 135) || (keyCode >= 166 && keyCode <= 183)) return undefined;
  if (/^(F\d+|Browser\w*|Launch\w*|Media\w*)$/.test(key) || /^(F\d+|Browser\w*)$/.test(code))
    return undefined;
  const typed = printable(text) ? text : undefined;
  if ((modifiers & ALT) !== 0) {
    // Alt with an arrow or F4 is the browser's; Alt with a character is only that character.
    return typed === undefined || (modifiers & META) !== 0
      ? undefined
      : { code, text: typed, modifiers: modifiers & SHIFT };
  }
  // Shift with Insert pastes and with Delete cuts, from a clipboard every thread's page shares.
  if ((modifiers & SHIFT) !== 0 && (keyCode === 45 || keyCode === 46)) return undefined;
  if (/^(insert|delete)$/i.test(key) && (modifiers & SHIFT) !== 0) return undefined;
  if ((modifiers & (CONTROL | META)) === 0) return { code, text: typed, modifiers };
  const chord = CHORD_KEYS.get(keyCode);
  if (chord === undefined || !chord.keys.includes(key.toLowerCase())) return undefined;
  if ((modifiers & SHIFT) !== 0 && !SHIFT_CHORD_KEYS.has(keyCode)) return undefined;
  // The code is the key code's own, so the two can't name different keys.
  return { code: chord.code, text: undefined, modifiers };
};

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
    const allowed = allowedKey(key, code, keyCode, text, modifiers);
    if (allowed === undefined) return undefined;
    return {
      type: "key",
      action,
      key,
      code: allowed.code,
      keyCode,
      modifiers: allowed.modifiers,
      ...(allowed.text === undefined ? {} : { text: allowed.text }),
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
  const m = raw as {
    type?: unknown;
    threadId?: unknown;
    inputs?: unknown;
    op?: unknown;
    fresh?: unknown;
  };
  if (!short(m.threadId, 200) || m.threadId === "") return undefined;
  const { threadId } = m;
  if (m.type === "pane.view.watch")
    return { type: m.type, threadId, ...(m.fresh === true ? { fresh: true } : {}) };
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
