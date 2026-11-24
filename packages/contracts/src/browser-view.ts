import * as Predicate from "effect/Predicate";

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

const VIEW_CONTROLS: ReadonlyArray<ViewControl> = ["back", "forward", "reload", "handBack"];
const BUTTONS: ReadonlyArray<ViewButton> = ["none", "left", "right"];
const isOneOf = <T extends string>(allowed: ReadonlyArray<T>, value: unknown): value is T =>
  allowed.some((each) => each === value);

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

const FRAME_MAX = 8_000_000;

const FAR = 100_000;

const ALT = 1;
const CONTROL = 2;
const META = 4;
const SHIFT = 8;

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

const SHIFT_CHORD_KEYS: ReadonlySet<number> = new Set([90, 35, 36, 37, 38, 39, 40]);

const KEY_CODES: ReadonlySet<number> = new Set([
  8,
  9,
  13,
  16,
  17,
  18,
  20,
  27,
  32,
  33,
  34,
  35,
  36,
  37,
  38,
  39,
  40,
  45,
  46,
  91,
  92,
  144,
  145,
  186,
  187,
  188,
  189,
  190,
  191,
  192,
  219,
  220,
  221,
  222,
  223,
  226,
  ...Array.from({ length: 10 }, (_, digit) => 48 + digit),
  ...Array.from({ length: 26 }, (_, letter) => 65 + letter),
  ...Array.from({ length: 16 }, (_, pad) => 96 + pad),
]);

const KEY_NAMES: ReadonlySet<string> = new Set([
  "Backspace",
  "Tab",
  "Enter",
  "Shift",
  "Control",
  "Alt",
  "AltGraph",
  "Meta",
  "CapsLock",
  "Escape",
  "PageUp",
  "PageDown",
  "End",
  "Home",
  "ArrowLeft",
  "ArrowUp",
  "ArrowRight",
  "ArrowDown",
  "Insert",
  "Delete",
  "NumLock",
  "ScrollLock",
  "Clear",
]);

const printable = (text: string | undefined): text is string =>
  text !== undefined &&
  Array.from(text).length === 1 &&
  (text === "\r" || text >= " ") &&
  text !== "\u007f";

const allowedKey = (
  key: string,
  code: string,
  keyCode: number,
  text: string | undefined,
  modifiers: number,
  up: boolean,
): { code: string; text: string | undefined; modifiers: number } | undefined => {
  if (!KEY_CODES.has(keyCode)) return undefined;
  const character = Array.from(key).length === 1 && key >= " " && key !== "\u007f";
  if (!character && !KEY_NAMES.has(key)) return undefined;
  if (/^(F\d+|Browser\w*)$/.test(code)) return undefined;
  if ((modifiers & SHIFT) !== 0 && (keyCode === 45 || keyCode === 46)) return undefined;
  if (/^(insert|delete)$/i.test(key) && (modifiers & SHIFT) !== 0) return undefined;
  const typed = printable(text) ? text : undefined;
  if ((modifiers & ALT) !== 0) {
    if ((modifiers & META) !== 0 || !character || keyCode < 48) return undefined;
    if (typed !== undefined) return { code, text: typed, modifiers: modifiers & SHIFT };
    return up && character ? { code, text: undefined, modifiers: modifiers & SHIFT } : undefined;
  }
  if ((modifiers & (CONTROL | META)) === 0) return { code, text: typed, modifiers };
  const chord = CHORD_KEYS.get(keyCode);
  if (chord === undefined || !chord.keys.includes(key.toLowerCase())) return undefined;
  if ((modifiers & SHIFT) !== 0 && !SHIFT_CHORD_KEYS.has(keyCode)) return undefined;
  return { code: chord.code, text: undefined, modifiers };
};

/** `raw` as one input, or `undefined` when it isn't one: nothing unchecked reaches the browser. */
export function viewInput(raw: unknown): ViewInput | undefined {
  if (!Predicate.isObject(raw)) return undefined;
  const r = raw;
  if (!whole(r["modifiers"], 0, 15)) return undefined;
  const modifiers = r["modifiers"];
  if (r["type"] === "key") {
    const { action, key, code, keyCode, text, repeat } = r;
    if (action !== "down" && action !== "up") return undefined;
    if (!short(key, 32) || !short(code, 32) || !whole(keyCode, 0, 255)) return undefined;
    if (text !== undefined && !short(text, 8)) return undefined;
    const allowed = allowedKey(key, code, keyCode, text, modifiers, action === "up");
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
  if (!isOneOf(BUTTONS, button)) return undefined;
  if (!whole(buttons, 0, 31) || (buttons & 4) !== 0 || !whole(clickCount, 0, 3)) return undefined;
  return {
    type: "pointer",
    action,
    x,
    y,
    button,
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
    return isOneOf(VIEW_CONTROLS, m.op) ? { type: m.type, threadId, op: m.op } : undefined;
  if (m.type !== "pane.view.input") return undefined;
  if (!Array.isArray(m.inputs) || m.inputs.length > VIEW_INPUT_BATCH) return undefined;
  const inputs = m.inputs.flatMap((each) => viewInput(each) ?? []);
  return { type: m.type, threadId, inputs };
}

/** A message from the host about a thread's view; `undefined` for anything else. */
export function viewHostMessage(raw: unknown): ViewHostMessage | undefined {
  if (!Predicate.isObject(raw)) return undefined;
  const { type, threadId, jpeg, width, height } = raw;
  if (typeof threadId !== "string") return undefined;
  if (type === "pane.view.page") {
    const page = raw["page"];
    if (page !== null && typeof page !== "object") return undefined;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the host's own page snapshot, which it builds as a ViewPage
    return raw as unknown as ViewPageMessage;
  }
  if (type !== "pane.view.frame") return undefined;
  return short(jpeg, FRAME_MAX) && within(width, 1, FAR) && within(height, 1, FAR)
    ? { type, threadId, jpeg, width, height }
    : undefined;
}
