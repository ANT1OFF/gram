// How an agent reads and acts on its thread's page, over the Chrome DevTools Protocol: Electron's
// `webContents.debugger` in the shells, a Playwright CDP session in its e2e spec. It reads what a
// person would see, the accessibility tree and the visible text, never the raw DOM, and acts as a
// person would, through mouse and keyboard input at an element's place on screen. The questions
// it asks the page (is this a submit control, which form does Enter send) run in an isolated world
// of its own, so a page that redefines the DOM's methods can't answer them.

import {
  BROWSER_INSPECTION_CAPABILITIES,
  BROWSER_MOBILE_MAX_WIDTH,
  BROWSER_VIEWPORTS,
  isPaneKey,
  paneKeyRefusal,
  PANE_KEY_REPEAT_MAX,
  PANE_NAMED_KEYS,
  type BrowserAction,
  type BrowserCapture,
  type BrowserColorScheme,
  type BrowserEmulation,
  type BrowserInspection,
  type BrowserRegion,
  type BrowserTarget,
  type BrowserViewport,
  type BrowserViewportPreset,
  type PaneConsoleEntry,
  type PaneKeyModifier,
} from "@gram/contracts/link-trust";
import { browserObservations, jpegDimensions } from "./browser-observations.ts";
import { randomUUID } from "node:crypto";

/** The part of a CDP session the driver uses. */
export interface Cdp {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Subscribes to a protocol event; returns the unsubscribe function. */
  on(event: string, listener: (params: unknown) => void): () => void;
}

/** An element on the page: a ref from the latest snapshot, or a point in the screenshot. */
export type PageTarget =
  | { readonly ref: string }
  | { readonly coordinate: readonly [number, number] };

/** What a snapshot outlines: the whole page by default. */
export interface SnapshotOptions {
  /** Only the elements an agent acts on, flat, without text runs. */
  readonly interactive?: boolean | undefined;
  /** Outline levels to show. */
  readonly depth?: number | undefined;
  /** The element whose subtree to outline. */
  readonly ref?: string | undefined;
  readonly maxChars?: number | undefined;
}

/** What a viewport command changes; what it doesn't name stays as it is. */
export interface ViewportChange {
  readonly preset?: BrowserViewportPreset | undefined;
  readonly size?: { readonly width: number; readonly height: number } | undefined;
  readonly mobile?: boolean | undefined;
  readonly colorScheme?: BrowserColorScheme | "system" | undefined;
}

/** The form an action would submit: where it goes, and the control that sends it. */
export interface PageSubmit {
  readonly action: string;
  readonly control: string;
}

export interface PageDriver {
  /** The accessibility tree as an indented outline, each element with a ref to act on. */
  snapshot(options?: SnapshotOptions): Promise<string>;
  /** The snapshot's lines whose role, name or value contain `query`, case-insensitively. */
  find(query: string): Promise<string>;
  /** The page's visible text, cut at `maxChars`. */
  text(maxChars?: number): Promise<string>;
  /**
   * The visible part of the page, in CSS pixels times `scale`, so a point in it divided by
   * `scale` is a point to click.
   */
  screenshot(target?: {
    ref?: string;
    region?: BrowserRegion;
    scale?: number;
    /** A lossless PNG, for evidence saved to a file. */
    format?: "png";
  }): Promise<{ readonly data: string; readonly mimeType: "image/jpeg" | "image/png" }>;
  /**
   * One recording frame of the viewport, a JPEG at `scale`, leaving the capture metadata of the
   * agent's own screenshots alone.
   */
  frame(scale: number): Promise<string>;
  /** The main frame's security origin, `null` for an opaque one. */
  securityOrigin(): Promise<string>;
  /** Runs `expression` in the page's own world; its value as JSON, or what it threw. */
  evaluate(expression: string): Promise<string>;
  /** The requests the current document made, oldest first, those whose URL has `filter`. */
  network(filter?: string): string;
  /** The response body of a request the current document made. */
  responseBody(requestId: string): Promise<string>;
  inspection(diagnostics?: boolean): BrowserInspection;
  viewport(change: BrowserViewportPreset | ViewportChange): Promise<void>;
  /** The form a click on `target` would submit, or `undefined` when it submits none. */
  clickSubmits(target: PageTarget): Promise<PageSubmit | undefined>;
  /** The form Enter would submit from `ref`, or the focused element; `undefined` for none. */
  enterSubmits(ref: string | undefined): Promise<PageSubmit | undefined>;
  /**
   * The form `key` would submit from `ref` or the focused element: Enter in a form's field, or
   * Enter or Space on its submit control; `undefined` for none, and for every other key.
   */
  keySubmits(ref: string | undefined, key: string): Promise<PageSubmit | undefined>;
  click(
    target: PageTarget,
    options?: { readonly button?: "left" | "right"; readonly double?: boolean },
  ): Promise<void>;
  /** Moves the mouse over `target`, pressing nothing. */
  hover(target: PageTarget): Promise<void>;
  /** Turns the wheel `amount` notches over `target`, or the viewport's centre. */
  scroll(
    target: PageTarget | undefined,
    direction: "up" | "down" | "left" | "right",
    amount: number,
  ): Promise<void>;
  /** Scrolls the element `ref` names into view. */
  scrollTo(ref: string): Promise<void>;
  /** Presses at `from`, moves to `to` and releases, completing an HTML drag-and-drop if one starts. */
  drag(from: PageTarget, to: PageTarget): Promise<void>;
  /** Types `text` into `ref`, or wherever the focus is, then presses Enter if `enter`. */
  type(text: string, ref: string | undefined, enter: boolean): Promise<void>;
  /**
   * Presses `key` (a `PANE_NAMED_KEYS` name or one printable character) `repeat` times with
   * `modifiers` held, on `ref` once it holds the focus, or wherever the focus is.
   */
  pressKey(
    ref: string | undefined,
    key: string,
    options?: { readonly modifiers?: readonly PaneKeyModifier[]; readonly repeat?: number },
  ): Promise<void>;
  /**
   * Waits up to `ms` for `text` to show in the page's visible text, or the element `ref` names to
   * be shown; whether it did.
   */
  waitFor(ms: number, until: { readonly text?: string; readonly ref?: string }): Promise<boolean>;
  /** Sets a field's value, a select's option or a checkbox, as the user changing it would. */
  formInput(ref: string, value: string | boolean): Promise<void>;
  /** What the page logged since the driver attached, oldest first. */
  console(onlyErrors: boolean): readonly PaneConsoleEntry[];
  /**
   * Whether the page asked to navigate its main frame to `url` by submitting a form, by whatever
   * means (a submit control, `requestSubmit()`, `form.submit()`), in the last few seconds.
   */
  formSubmission(url: string): boolean;
  /** Forgets the refs: the page they named is gone. */
  reset(): void;
  /**
   * While `from` is a time, what the page logs is dropped, and so is what it logged since then:
   * for a page the agent may not read, such as a file the user previews in the same view. `null`
   * starts keeping it again.
   */
  holdConsole(from: number | null): void;
  dispose(): void;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A ref that names nothing on the page now; the agent takes a fresh snapshot. */
export class StaleRefError extends Error {}
export class UserControlError extends Error {}
/** Authorization or document changed while an awaited command was in progress. */
export class PageAccessError extends Error {}
export class StalePageError extends StaleRefError {}

/** How long a form submission the renderer reported names the navigation that follows it. */
const SUBMISSION_FRESH_MS = 5_000;

/** `url` without its fragment, which a navigation's request never carries. */
const withoutHash = (url: string) => {
  const at = url.indexOf("#");
  return at === -1 ? url : url.slice(0, at);
};

/** The most requests the network log keeps, across documents. */
const NETWORK_KEPT = 500;
/** How many requests a listing shows. */
const NETWORK_SHOWN = 100;
/** A response body or an evaluation result longer than this is cut. */
export const BODY_MAX_CHARS = 50_000;
/** How long an evaluation may run. */
const EVALUATE_TIMEOUT_MS = 5_000;

/** One request the page made, as the network log keeps it. */
interface NetworkEntry {
  readonly id: string;
  /** The document it was made for, so a listing shows only the current one's. */
  readonly loader: string;
  readonly method: string;
  readonly url: string;
  readonly type: string;
  status?: number;
  mimeType?: string;
  failed?: string;
  finished?: boolean;
}

/** A PNG's width and height from its header. */
export const pngDimensions = (base64: string) => {
  const head = Buffer.from(base64.slice(0, 64), "base64");
  if (head.length < 24 || head.readUInt32BE(12) !== 0x49484452)
    throw new Error("Page capture isn't a PNG.");
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
};

const clip = (text: string, max = BODY_MAX_CHARS) =>
  text.length > max
    ? `${text.slice(0, max)}\n… (cut at ${max} of ${text.length} characters)`
    : text;

/** A snapshot longer than this is cut, with a line saying so. */
export const SNAPSHOT_MAX_CHARS = 40_000;
/** Visible text longer than this is cut. */
export const TEXT_MAX_CHARS = 60_000;
const FIND_MAX_LINES = 30;
const CONSOLE_MAX_CHARS = 2_000;
const NAME_MAX_CHARS = 200;

/** One node of `Accessibility.getFullAXTree`, as far as the outline reads it. */
export interface AxNode {
  readonly nodeId: string;
  readonly ignored?: boolean;
  readonly role?: { readonly value?: unknown };
  readonly name?: { readonly value?: unknown };
  readonly value?: { readonly value?: unknown };
  readonly properties?: ReadonlyArray<{
    readonly name: string;
    readonly value: { readonly value?: unknown };
  }>;
  readonly childIds?: readonly string[];
  readonly backendDOMNodeId?: number;
  readonly parentId?: string;
}

/** Roles that only group, shown only when they carry a name of their own. */
const STRUCTURAL = new Set([
  "generic",
  "none",
  "presentation",
  "group",
  "LineBreak",
  "InlineTextBox",
  "Section",
  "LayoutTable",
  "LayoutTableRow",
  "LayoutTableCell",
]);
const TEXT_ROLES = new Set(["StaticText", "text"]);
/** The document itself, whose title a result names already. */
const PAGE_ROLES = new Set(["RootWebArea", "WebArea"]);
/** States worth showing beside an element, in the order they're shown. */
const SHOWN_STATES = [
  "level",
  "checked",
  "selected",
  "expanded",
  "pressed",
  "disabled",
  "required",
  "readonly",
] as const;

const oneLine = (value: unknown, max = NAME_MAX_CHARS): string => {
  const text = typeof value === "string" ? value : value === undefined ? "" : String(value);
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** Ref names by backend node id, kept for as long as one document is on screen. */
export class RefTable {
  private readonly byNode = new Map<number, string>();
  private readonly byRef = new Map<string, number>();
  private next = 1;

  refFor(backendNodeId: number): string {
    const known = this.byNode.get(backendNodeId);
    if (known !== undefined) return known;
    const ref = `ref_${this.next++}`;
    this.byNode.set(backendNodeId, ref);
    this.byRef.set(ref, backendNodeId);
    return ref;
  }

  nodeOf(ref: string): number | undefined {
    return this.byRef.get(ref);
  }

  /**
   * Forgets every ref, keeping the count: a ref from a page gone stays stale, rather than naming
   * whatever the next page numbers the same.
   */
  clear(): void {
    this.byNode.clear();
    this.byRef.clear();
  }
}

/** Roles an agent acts on, which `interactive` snapshots keep. */
const INTERACTIVE = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "treeitem",
  "PopUpButton",
  "ComboBoxSelect",
  "ComboBoxMenuButton",
  "DisclosureTriangle",
]);

export interface OutlineOptions {
  readonly maxChars?: number | undefined;
  /** Only interactive elements, flat, without text runs. */
  readonly interactive?: boolean | undefined;
  /** Outline levels to show; deeper elements are left out. */
  readonly depth?: number | undefined;
  /** The AX node whose subtree to outline; the document when absent. */
  readonly rootId?: string | undefined;
}

/**
 * `nodes` as an outline: `- role "name" [ref_n] state…` per element, indented by depth, with text
 * runs as quoted lines. Grouping nodes without a name are skipped and their children lifted, so
 * the outline is what the page says, not how it is built.
 */
export function renderAxTree(
  nodes: readonly AxNode[],
  refs: RefTable,
  options: number | OutlineOptions = {},
) {
  const {
    maxChars = SNAPSHOT_MAX_CHARS,
    interactive = false,
    depth: maxDepth,
    rootId,
  } = typeof options === "number" ? { maxChars: options } : options;
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const root =
    rootId === undefined
      ? (nodes.find((node) => node.parentId === undefined) ?? nodes[0])
      : byId.get(rootId);
  const lines: string[] = [];
  let size = 0;
  let cut = false;
  let deeper = false;
  const push = (line: string) => {
    if (cut) return;
    if (size + line.length + 1 > maxChars) {
      cut = true;
      return;
    }
    lines.push(line);
    size += line.length + 1;
  };
  /** `named` is the nearest shown ancestor's name, which a text run repeating it adds nothing to. */
  const visit = (node: AxNode, depth: number, seen: Set<string>, named = "") => {
    if (cut || seen.has(node.nodeId)) return;
    seen.add(node.nodeId);
    const role = oneLine(node.role?.value, 40);
    const name = oneLine(node.name?.value);
    const indent = interactive ? "" : "  ".repeat(depth);
    let childDepth = depth;
    let childNamed = named;
    if (node.ignored !== true) {
      if (TEXT_ROLES.has(role)) {
        if (maxDepth !== undefined && depth >= maxDepth) {
          deeper = true;
          return;
        }
        if (!interactive && name !== "" && name !== named)
          push(`${indent}- text ${JSON.stringify(name)}`);
        return;
      }
      const shown = !(STRUCTURAL.has(role) && name === "") && !PAGE_ROLES.has(role) && role !== "";
      const focusable =
        !PAGE_ROLES.has(role) &&
        node.properties?.find((p) => p.name === "focusable")?.value.value === true;
      // An interactive outline keeps what takes focus, a nameless `div` with a tabindex included.
      const listed = interactive ? INTERACTIVE.has(role) || focusable : shown;
      if ((shown || listed) && maxDepth !== undefined && depth >= maxDepth) {
        deeper = true;
        return;
      }
      if (listed) {
        const parts = [`${indent}- ${role}`];
        if (name !== "") parts.push(JSON.stringify(name));
        if (node.backendDOMNodeId !== undefined)
          parts.push(`[${refs.refFor(node.backendDOMNodeId)}]`);
        const value = oneLine(node.value?.value);
        if (value !== "") parts.push(`value=${JSON.stringify(value)}`);
        for (const state of SHOWN_STATES) {
          const property = node.properties?.find((p) => p.name === state)?.value.value;
          if (property === undefined || property === false || property === "false") continue;
          parts.push(
            property === true || property === "true" ? state : `${state}=${oneLine(property, 20)}`,
          );
        }
        push(parts.join(" "));
      }
      if (shown) {
        childDepth = depth + 1;
        childNamed = name;
      }
    }
    for (const id of node.childIds ?? []) {
      const child = byId.get(id);
      if (child !== undefined) visit(child, childDepth, seen, childNamed);
    }
  };
  if (root !== undefined) visit(root, 0, new Set());
  if (cut)
    lines.push(
      `… (cut at ${maxChars} characters; use browser_find, or pass a ref, a depth or filter "interactive")`,
    );
  else if (deeper) lines.push(`… (deeper levels left out at depth ${maxDepth})`);
  return lines.length === 0
    ? interactive
      ? "(nothing interactive here)"
      : "(the page has no accessible content)"
    : lines.join("\n");
}

/** The lines of an outline that mention `query`, at most `FIND_MAX_LINES` of them. */
export function findInOutline(outline: string, query: string): string {
  const needle = query.toLowerCase().trim();
  if (needle === "") return "(nothing to look for)";
  const hits = outline
    .split("\n")
    .filter((line) => line.toLowerCase().includes(needle))
    .map((line) => line.trim());
  if (hits.length === 0) return `(nothing on the page matches ${JSON.stringify(query)})`;
  const shown = hits.slice(0, FIND_MAX_LINES);
  return hits.length > shown.length
    ? `${shown.join("\n")}\n… (${hits.length - shown.length} more)`
    : shown.join("\n");
}

/** The text of a console call's arguments, as the console would print them. */
export function consoleText(args: ReadonlyArray<Record<string, unknown>>): string {
  const text = args
    .map((arg) => {
      const value = arg["value"];
      if (typeof value === "string") return value;
      if (value !== undefined) return JSON.stringify(value);
      const shown = arg["unserializableValue"] ?? arg["description"] ?? arg["type"];
      return typeof shown === "string" ? shown : "";
    })
    .join(" ");
  return text.length > CONSOLE_MAX_CHARS ? `${text.slice(0, CONSOLE_MAX_CHARS)}…` : text;
}

// Run in the driver's isolated world on the element (`this`); they read the DOM, never write it.
const CLICK_SUBMITS = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  const control = el && el.closest("button, input[type=submit], input[type=image]");
  if (!control || !control.form) return null;
  if (control instanceof HTMLButtonElement && control.type !== "submit") return null;
  const label = control.innerText || control.value || control.getAttribute("aria-label") || control.type;
  const action = control.hasAttribute("formaction") ? control.formAction : control.form.action;
  return { action: action || location.href, control: String(label).slice(0, 80) };
}`;
const ENTER_SUBMITS = `function () {
  const el = this && this.nodeType === 1 ? this : document.activeElement;
  if (!el || !el.form || el instanceof HTMLTextAreaElement) return null;
  return { action: el.form.action || location.href, control: "Enter in " + (el.name || el.type || el.tagName.toLowerCase()) };
}`;
const SET_VALUE = `function (value) {
  const el = this;
  if (el instanceof HTMLSelectElement) {
    const option = Array.from(el.options).find((o) => o.value === value || o.text.trim() === value);
    if (!option) throw new Error("the select has no option " + JSON.stringify(value));
    el.value = option.value;
  } else if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
    el.checked = value === true || value === "true";
  } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, String(value));
  } else if (el.isContentEditable) {
    el.textContent = String(value);
  } else {
    throw new Error("that element isn't a form field");
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}`;
const KEY_SUBMITS = `function (key) {
  const el = this && this.nodeType === 1 ? this : document.activeElement;
  if (!el) return null;
  const control = el.closest && el.closest("button, input[type=submit], input[type=image]");
  if (control && control.form && !(control instanceof HTMLButtonElement && control.type !== "submit")) {
    const label = control.innerText || control.value || control.getAttribute("aria-label") || control.type;
    const action = control.hasAttribute("formaction") ? control.formAction : control.form.action;
    return { action: action || location.href, control: (key === "Enter" ? "Enter on " : "Space on ") + String(label).slice(0, 60) };
  }
  if (key !== "Enter" || !el.form || el instanceof HTMLTextAreaElement) return null;
  return { action: el.form.action || location.href, control: "Enter in " + (el.name || el.type || el.tagName.toLowerCase()) };
}`;
/** Whether the element is in the document and laid out where it can be seen. */
const IS_SHOWN = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el || !el.isConnected) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none" && el.getClientRects().length > 0;
}`;
const USER_AGENT = `function () { return navigator.userAgent; }`;
const VISIBLE_TEXT = `function () { return document.body ? document.body.innerText : ""; }`;

/** A phone's user agent on the engine the pane runs, for mobile emulation. */
const mobileUserAgent = () =>
  `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions["chrome"] ?? "130.0.0.0"} Mobile Safari/537.36`;

/** CDP's modifier bits. */
const MODIFIER_BITS: Record<PaneKeyModifier, number> = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
/** How far one wheel notch scrolls, in CSS pixels. */
const WHEEL_NOTCH = 100;
/** How many moves a drag makes between its ends, so pointer-driven drags see it travel. */
const DRAG_STEPS = 8;
/** How often a wait looks again. */
const WAIT_POLL_MS = 150;

/** The key event `key` makes: its DOM key and code, its virtual key code and the text it types. */
const keyEvent = (key: string, modifiers: number) => {
  const named = Object.hasOwn(PANE_NAMED_KEYS, key) ? PANE_NAMED_KEYS[key] : undefined;
  // Ctrl, Alt and Meta make a shortcut, which types nothing.
  const types = (modifiers & (MODIFIER_BITS.ctrl | MODIFIER_BITS.alt | MODIFIER_BITS.meta)) === 0;
  if (named !== undefined) {
    const text = named.key === "Enter" ? "\r" : named.key === " " ? " " : undefined;
    return {
      key: named.key,
      code: named.code,
      windowsVirtualKeyCode: named.keyCode,
      nativeVirtualKeyCode: named.keyCode,
      ...(text === undefined || !types ? {} : { text, unmodifiedText: text }),
    };
  }
  const upper = key.toUpperCase();
  const letter = /^[A-Z]$/.test(upper);
  const digit = /^[0-9]$/.test(key);
  const keyCode = letter || digit ? upper.charCodeAt(0) : 0;
  return {
    key,
    ...(letter ? { code: `Key${upper}` } : digit ? { code: `Digit${key}` } : {}),
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    ...(types ? { text: key, unmodifiedText: key } : {}),
  };
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/** A submission the page described, or `undefined` for anything else. */
const asSubmit = (value: unknown): PageSubmit | undefined => {
  const found = record(value);
  return typeof found["action"] === "string" && typeof found["control"] === "string"
    ? { action: found["action"], control: oneLine(found["control"], 80) }
    : undefined;
};

/** What `perform` records as an action's target. */
const targetOf = (target: PageTarget): BrowserTarget =>
  "ref" in target
    ? { source: "dom-ref", ref: target.ref }
    : { source: "coordinate", point: target.coordinate };

/**
 * A driver for the page behind `cdp`. Enables what it reads; `dispose` stops listening. `heldFrom`
 * starts its console held (`holdConsole`), before the first event can arrive.
 */
export async function createPageDriver(
  cdp: Cdp,
  heldFrom: number | null = null,
  canDispatch: () => boolean = () => true,
  validateOperation: (mutating: boolean) => void = () => {},
): Promise<PageDriver> {
  const refs = new RefTable();
  /** When the page last submitted a form to each URL. */
  const submissions = new Map<string, number>();
  const observations = browserObservations(cdp, heldFrom);
  let documentId = randomUUID();
  let capture: BrowserCapture | undefined;
  let action: BrowserAction | undefined;
  let viewportPreset: BrowserViewportPreset | undefined = "pane";
  let emulation: BrowserEmulation = { mobile: false };
  /** The page's own user agent, kept to restore after mobile emulation. */
  let userAgent: string | undefined;
  /** The isolated world's context, made once per document. */
  let worldId: number | undefined;
  /** The requests the page made, by CDP request id, oldest first. */
  const requests = new Map<string, NetworkEntry>();
  /** The main frame's current document's loader, which its requests name. */
  let loader: string | undefined;
  const resetDocument = () => {
    refs.clear();
    worldId = undefined;
    documentId = randomUUID();
  };
  const unsubscribe = [
    cdp.on("Page.frameNavigated", (params) => {
      const frame = record(record(params)["frame"]);
      if (frame["parentId"] !== undefined) return;
      resetDocument();
      loader = typeof frame["loaderId"] === "string" ? frame["loaderId"] : undefined;
    }),
    // The page's requests, by the document they were made for; bodies only on asking.
    cdp.on("Network.requestWillBeSent", (params) => {
      const event = record(params);
      const request = record(event["request"]);
      if (typeof event["requestId"] !== "string" || typeof request["url"] !== "string") return;
      const known = requests.get(event["requestId"]);
      // A redirect reuses the id: the hop it left is kept under its own key.
      if (known !== undefined) requests.set(`${known.id}#${requests.size}`, known);
      requests.delete(event["requestId"]);
      requests.set(event["requestId"], {
        id: event["requestId"],
        loader: String(event["loaderId"] ?? ""),
        method: String(request["method"] ?? "GET"),
        url: request["url"],
        type: String(event["type"] ?? "Other"),
      });
      while (requests.size > NETWORK_KEPT) requests.delete(requests.keys().next().value!);
    }),
    cdp.on("Network.responseReceived", (params) => {
      const event = record(params);
      const entry = requests.get(String(event["requestId"]));
      const response = record(event["response"]);
      if (entry === undefined) return;
      if (typeof response["status"] === "number") entry.status = response["status"];
      if (typeof response["mimeType"] === "string") entry.mimeType = response["mimeType"];
    }),
    cdp.on("Network.loadingFinished", (params) => {
      const entry = requests.get(String(record(params)["requestId"]));
      if (entry !== undefined) entry.finished = true;
    }),
    cdp.on("Network.loadingFailed", (params) => {
      const event = record(params);
      const entry = requests.get(String(event["requestId"]));
      if (entry !== undefined) entry.failed = oneLine(event["errorText"], 80);
    }),
    // The renderer names a navigation's reason as it asks for it, which is the only place a form
    // submission is told from a link: the request itself is a plain GET.
    cdp.on("Page.frameRequestedNavigation", (params) => {
      const event = record(params);
      const reason = event["reason"];
      if (reason !== "formSubmissionGet" && reason !== "formSubmissionPost") return;
      if (typeof event["url"] === "string") submissions.set(withoutHash(event["url"]), Date.now());
    }),
  ];
  await cdp.send("Runtime.enable");
  await cdp.send("Accessibility.enable");
  await cdp.send("DOM.enable");
  await cdp.send("Page.enable");
  // Bodies are buffered so a local page's responses can be read (`responseBody`), which only a
  // loopback page may do; nothing else reads them.
  await cdp.send("Network.enable", {
    maxTotalBufferSize: 20_000_000,
    maxResourceBufferSize: 2_000_000,
  });
  // Electron delivers CDP's mouse and keyboard input only to a page that has focus, which a page in
  // a hidden or detached pane never does: the clicks landed nowhere until the page was told it has.
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

  unsubscribe.push(
    cdp.on("Runtime.executionContextsCleared", () => {
      worldId = undefined;
    }),
    cdp.on("Runtime.executionContextDestroyed", (params) => {
      if (record(params)["executionContextId"] === worldId) worldId = undefined;
    }),
  );
  // Recheck around protocol reads: neither renderer data nor capture bytes may leave after
  // the command's document/authorization changed while the transport was awaited.
  const read = async (method: string, params?: Record<string, unknown>) => {
    validateOperation(false);
    const expected = documentId;
    const result = await cdp.send(method, params);
    validateOperation(false);
    if (expected !== documentId) throw new StalePageError("The page changed during the command.");
    return result;
  };
  let activeActionDocument: string | undefined;
  const checkDispatch = () => {
    if (!canDispatch()) throw new UserControlError("The user has control.");
    validateOperation(true);
    if (activeActionDocument !== undefined && activeActionDocument !== documentId)
      throw new StalePageError("The page changed before further input could be sent.");
  };
  const world = async (): Promise<number> => {
    if (worldId !== undefined) return worldId;
    const tree = record(record(await read("Page.getFrameTree"))["frameTree"]);
    const frameId = record(tree["frame"])["id"];
    const created = record(
      await read("Page.createIsolatedWorld", { frameId, worldName: "gram-agent" }),
    );
    worldId = Number(created["executionContextId"]);
    return worldId;
  };

  const nodeOf = (ref: string): number => {
    const node = refs.nodeOf(ref);
    if (node === undefined)
      throw new StaleRefError(`${ref} isn't on the page; take a new snapshot.`);
    return node;
  };

  /** Calls `fn` on a node in the isolated world; a node the page dropped is a stale ref. */
  const callOn = async (
    backendNodeId: number | undefined,
    fn: string,
    args: readonly unknown[] = [],
    mutating = false,
  ): Promise<unknown> => {
    const contextId = await world();
    let objectId: unknown;
    if (backendNodeId !== undefined) {
      try {
        objectId = record(
          record(await read("DOM.resolveNode", { backendNodeId, executionContextId: contextId }))[
            "object"
          ],
        )["objectId"];
      } catch (error) {
        if (error instanceof PageAccessError || error instanceof StalePageError) throw error;
        throw new StaleRefError("That element is gone from the page; take a new snapshot.");
      }
    }
    const result = record(
      await (mutating ? dispatch : read)(
        "Runtime.callFunctionOn",
        objectId === undefined
          ? {
              functionDeclaration: fn,
              executionContextId: contextId,
              arguments: args.map((value) => ({ value })),
              returnByValue: true,
            }
          : {
              functionDeclaration: fn,
              objectId,
              arguments: args.map((value) => ({ value })),
              returnByValue: true,
            },
      ),
    );
    const thrown = record(result["exceptionDetails"]);
    if (Object.keys(thrown).length > 0) {
      const description = record(thrown["exception"])["description"] ?? thrown["text"];
      throw new Error(oneLine(description, 300));
    }
    return record(result["result"])["value"];
  };

  const nodeAt = async ([x, y]: readonly [number, number]): Promise<number> => {
    const found = record(
      await read("DOM.getNodeForLocation", { x: Math.round(x), y: Math.round(y) }),
    );
    const node = found["backendNodeId"];
    if (typeof node !== "number") throw new Error(`Nothing is at (${x}, ${y}).`);
    return node;
  };

  const viewport = async (unzoomed = false): Promise<BrowserViewport> => {
    const metrics = record(await read("Page.getLayoutMetrics"));
    const v = record(metrics["cssVisualViewport"]);
    const result = {
      width: Number(v["clientWidth"]),
      height: Number(v["clientHeight"]),
      pageX: Number(v["pageX"]),
      pageY: Number(v["pageY"]),
      scale: Number(v["scale"]),
    };
    if (
      !Object.values(result).every(Number.isFinite) ||
      result.width <= 0 ||
      result.height <= 0 ||
      result.scale <= 0 ||
      (unzoomed && result.scale !== 1)
    )
      throw new Error("Viewport geometry unavailable or zoomed; use an unzoomed top-frame page.");
    return result;
  };
  const regionOf = async (backendNodeId: number): Promise<BrowserRegion> => {
    if (
      (await callOn(backendNodeId, "function () { return this.ownerDocument === document; }")) !==
      true
    )
      throw new Error("Frame-local target geometry is unavailable.");
    const quads = record(await read("DOM.getContentQuads", { backendNodeId }))["quads"];
    const q = Array.isArray(quads) ? (quads[0] as number[] | undefined) : undefined;
    if (q === undefined || q.length !== 8 || !q.every(Number.isFinite))
      throw new Error("Target geometry unavailable.");
    const xs = [q[0]!, q[2]!, q[4]!, q[6]!];
    const ys = [q[1]!, q[3]!, q[5]!, q[7]!];
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };
  };
  const centerOf = async (backendNodeId: number): Promise<readonly [number, number]> => {
    try {
      if (
        (await callOn(backendNodeId, "function () { return this.ownerDocument === document; }")) !==
        true
      )
        throw new Error("Frame-local geometry unavailable.");
      checkDispatch();
      await read("DOM.scrollIntoViewIfNeeded", { backendNodeId });
      const quads = record(await read("DOM.getContentQuads", { backendNodeId }))["quads"];
      const quad = Array.isArray(quads) ? (quads[0] as number[] | undefined) : undefined;
      if (quad === undefined || quad.length < 8) throw new Error("not on screen");
      const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
      const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
      return [xs.reduce((a, b) => a + b) / 4, ys.reduce((a, b) => a + b) / 4];
    } catch (error) {
      if (
        error instanceof UserControlError ||
        error instanceof PageAccessError ||
        error instanceof StalePageError
      )
        throw error;
      if (error instanceof Error && error.message === "not on screen") {
        throw new Error("That element isn't shown on the page, so it can't be clicked.", {
          cause: error,
        });
      }
      throw new StaleRefError("That element is gone from the page; take a new snapshot.", {
        cause: error,
      });
    }
  };

  const dispatch = async (method: string, params: Record<string, unknown>) => {
    checkDispatch();
    if (action !== undefined)
      action = {
        ...action,
        dispatchStartedAt: action.dispatchStartedAt ?? Date.now(),
        status: "dispatch-unknown",
      };
    return cdp.send(method, params);
  };
  const perform = async (
    op: BrowserAction["op"],
    target: BrowserTarget | undefined,
    run: () => Promise<void>,
  ) => {
    activeActionDocument = documentId;
    const id = randomUUID();
    action = {
      id,
      documentId,
      op,
      startedAt: Date.now(),
      status: "not-dispatched",
      ...(target === undefined ? {} : { target }),
    };
    try {
      await run();
      validateOperation(false);
      if (activeActionDocument !== documentId)
        throw new StalePageError("The page changed during input.");
      if (action?.id !== id) throw new PageAccessError("The page is no longer readable.");
      action = {
        ...action!,
        status: action!.dispatchStartedAt === undefined ? "not-dispatched" : "dispatch-completed",
        completedAt: Date.now(),
      };
    } catch (error) {
      if (action?.id === id)
        action = {
          ...action!,
          completedAt: Date.now(),
          failure:
            error instanceof UserControlError
              ? "user-control"
              : action!.dispatchStartedAt === undefined
                ? "target-unavailable"
                : "dispatch-error",
        };
      throw error;
    } finally {
      activeActionDocument = undefined;
    }
  };
  const mouseClick = async (
    [x, y]: readonly [number, number],
    button: "left" | "right" = "left",
    clicks: 1 | 2 = 1,
  ) => {
    const at = { x, y };
    const buttons = button === "left" ? 1 : 2;
    await dispatch("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
    for (let clickCount = 1; clickCount <= clicks; clickCount++) {
      await dispatch("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...at,
        button,
        buttons,
        clickCount,
      });
      await dispatch("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...at,
        button,
        buttons: 0,
        clickCount,
      });
    }
  };

  const pressEnter = async () => {
    const key = {
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    };
    await dispatch("Input.dispatchKeyEvent", { type: "keyDown", ...key, text: "\r" });
    await dispatch("Input.dispatchKeyEvent", { type: "keyUp", ...key });
  };

  const outline = async (options: SnapshotOptions = {}) => {
    const subtree = options.ref === undefined ? undefined : nodeOf(options.ref);
    const tree = record(await read("Accessibility.getFullAXTree"));
    const nodes = Array.isArray(tree["nodes"]) ? (tree["nodes"] as AxNode[]) : [];
    const rootId =
      subtree === undefined
        ? undefined
        : nodes.find((node) => node.backendDOMNodeId === subtree && node.ignored !== true)?.nodeId;
    if (subtree !== undefined && rootId === undefined)
      throw new StaleRefError(
        `${options.ref} isn't in the page's accessibility tree now; take a new snapshot.`,
      );
    return renderAxTree(nodes, refs, {
      interactive: options.interactive,
      depth: options.depth,
      rootId,
      ...(options.maxChars === undefined ? {} : { maxChars: options.maxChars }),
    });
  };

  /** Where a target is in the viewport, scrolled into view when it is a ref. */
  const pointOf = async (target: PageTarget): Promise<readonly [number, number]> => {
    const point = "ref" in target ? await centerOf(nodeOf(target.ref)) : target.coordinate;
    const v = await viewport(true);
    if (
      !point.every(Number.isFinite) ||
      point[0] < 0 ||
      point[1] < 0 ||
      point[0] >= v.width ||
      point[1] >= v.height
    )
      throw new Error("That point is outside the viewport.");
    action = { ...action!, viewport: v };
    return point;
  };
  const mouse = (
    type: "mouseMoved" | "mousePressed" | "mouseReleased",
    [x, y]: readonly [number, number],
    extra: Record<string, unknown> = {},
  ) => dispatch("Input.dispatchMouseEvent", { type, x, y, ...extra });

  /** Applies `emulation` to the page; each part only when it changed from `before`. */
  /** A layout change, held to the same ownership and limits as input, but not an action. */
  const layout = (method: string, params: Record<string, unknown>) => {
    checkDispatch();
    return read(method, params);
  };
  /**
   * What the page has applied, part by part, so a change that failed halfway is diffed against
   * what actually took and undone in full by the next.
   */
  const applied: {
    metrics: string | undefined;
    touch: boolean;
    /** The phone's user agent. */
    phone: boolean;
    scheme: BrowserColorScheme | undefined;
  } = { metrics: undefined, touch: false, phone: false, scheme: undefined };
  const emulate = async (next: BrowserEmulation) => {
    // Read before anything changes, so a page gone meanwhile leaves nothing half applied.
    if (next.mobile !== applied.phone)
      userAgent ??= String((await callOn(undefined, USER_AGENT)) ?? "");
    const metrics =
      next.width === undefined || next.height === undefined
        ? undefined
        : JSON.stringify([next.width, next.height, next.mobile]);
    if (metrics !== applied.metrics) {
      if (next.width === undefined || next.height === undefined)
        await layout("Emulation.clearDeviceMetricsOverride", {});
      else
        await layout("Emulation.setDeviceMetricsOverride", {
          width: next.width,
          height: next.height,
          deviceScaleFactor: next.mobile ? 2 : 1,
          mobile: next.mobile,
        });
      applied.metrics = metrics;
    }
    // Touch and the user agent are tracked apart: either may take while the other fails.
    if (next.mobile !== applied.touch) {
      await layout("Emulation.setTouchEmulationEnabled", {
        enabled: next.mobile,
        ...(next.mobile ? { maxTouchPoints: 5 } : {}),
      });
      applied.touch = next.mobile;
    }
    if (next.mobile !== applied.phone) {
      await layout("Emulation.setUserAgentOverride", {
        userAgent: next.mobile ? mobileUserAgent() : userAgent,
        ...(next.mobile ? { platform: "Android" } : {}),
      });
      applied.phone = next.mobile;
    }
    if (next.colorScheme !== applied.scheme) {
      await layout("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: next.colorScheme ?? "" }],
      });
      applied.scheme = next.colorScheme;
    }
  };

  return {
    snapshot: outline,
    find: async (query) => findInOutline(await outline(), query),
    text: async (maxChars = TEXT_MAX_CHARS) => {
      const text = String((await callOn(undefined, VISIBLE_TEXT)) ?? "");
      return text.length > maxChars
        ? `${text.slice(0, maxChars)}\n… (cut at ${maxChars} of ${text.length} characters)`
        : text;
    },
    inspection: (diagnostics = false) => ({
      capabilities: BROWSER_INSPECTION_CAPABILITIES,
      documentId,
      ...(capture === undefined ? {} : { capture }),
      ...(action === undefined ? {} : { action }),
      ...(viewportPreset === undefined ? {} : { viewportPreset }),
      emulation,
      ...(diagnostics ? { diagnostics: observations.diagnostics() } : {}),
    }),
    viewport: async (requested) => {
      const change: ViewportChange =
        typeof requested === "string" ? { preset: requested } : requested;
      checkDispatch();
      const size =
        change.preset === "pane"
          ? undefined
          : change.preset !== undefined
            ? BROWSER_VIEWPORTS[change.preset]
            : (change.size ??
              (emulation.width === undefined || emulation.height === undefined
                ? undefined
                : { width: emulation.width, height: emulation.height }));
      const resized = change.preset !== undefined || change.size !== undefined;
      // A new size drops mobile emulation unless asked for again; a phone is narrower than 768.
      const mobile = change.mobile ?? (resized ? false : emulation.mobile);
      if (mobile && (size === undefined || size.width >= BROWSER_MOBILE_MAX_WIDTH))
        throw new Error(`Mobile emulation needs a width below ${BROWSER_MOBILE_MAX_WIDTH}.`);
      const colorScheme =
        change.colorScheme === undefined
          ? emulation.colorScheme
          : change.colorScheme === "system"
            ? undefined
            : change.colorScheme;
      const next: BrowserEmulation = {
        ...(size === undefined ? {} : { width: size.width, height: size.height }),
        mobile,
        ...(colorScheme === undefined ? {} : { colorScheme }),
      };
      await emulate(next);
      emulation = next;
      if (change.preset !== undefined) viewportPreset = change.preset;
      else if (change.size !== undefined) viewportPreset = undefined;
    },
    screenshot: async (requested) => {
      const capturedDocument = documentId;
      const v = await viewport(requested?.ref !== undefined || requested?.region !== undefined);
      let target: BrowserTarget | undefined;
      if (requested?.ref !== undefined)
        target = {
          source: "dom-ref",
          ref: requested.ref,
          region: await regionOf(nodeOf(requested.ref)),
        };
      else if (requested?.region !== undefined) {
        const r = requested.region;
        if (
          ![r.x, r.y, r.width, r.height].every(Number.isFinite) ||
          r.x < 0 ||
          r.y < 0 ||
          r.width <= 0 ||
          r.height <= 0 ||
          r.x + r.width > v.width ||
          r.y + r.height > v.height
        )
          throw new Error("Region is outside the captured viewport.");
        target = { source: "region", region: r };
      }
      if (capturedDocument !== documentId)
        throw new StalePageError("The document changed before capture; take a new snapshot.");
      const targetObservedAt = target === undefined ? undefined : Date.now();
      const startedAt = Date.now();
      const png = requested?.format === "png";
      const shot = record(
        await read("Page.captureScreenshot", {
          ...(png ? { format: "png" } : { format: "jpeg", quality: 80 }),
          captureBeyondViewport: false,
          clip: {
            x: v.pageX,
            y: v.pageY,
            width: v.width,
            height: v.height,
            scale: requested?.scale ?? 1,
          },
        }),
      );
      if (typeof shot["data"] !== "string") throw new Error("Page capture unavailable.");
      const dimensions = png ? pngDimensions(shot["data"]) : jpegDimensions(shot["data"]);
      if (capturedDocument !== documentId)
        throw new StalePageError("The document changed during capture; take a new snapshot.");
      capture = {
        id: randomUUID(),
        source: "cdp-page",
        documentId: capturedDocument,
        startedAt,
        completedAt: Date.now(),
        viewport: v,
        imageWidth: dimensions.width,
        imageHeight: dimensions.height,
        ...(target === undefined ? {} : { target, targetObservedAt }),
      };
      return { data: shot["data"], mimeType: png ? "image/png" : "image/jpeg" };
    },
    frame: async (scale) => {
      const v = await viewport();
      const shot = record(
        await read("Page.captureScreenshot", {
          format: "jpeg",
          quality: 70,
          captureBeyondViewport: false,
          clip: { x: v.pageX, y: v.pageY, width: v.width, height: v.height, scale },
        }),
      );
      if (typeof shot["data"] !== "string") throw new Error("Page capture unavailable.");
      return shot["data"];
    },
    securityOrigin: async () => {
      const tree = record(record(await read("Page.getFrameTree"))["frameTree"]);
      const origin = record(tree["frame"])["securityOrigin"];
      return typeof origin === "string" && origin !== "" && origin !== "://" ? origin : "null";
    },
    evaluate: async (expression) => {
      let outcome: Record<string, unknown> = {};
      await perform("evaluate", undefined, async () => {
        // The protocol's timeout covers synchronous work only: a promise that never settles is
        // given up on here, so it can't hold the thread's pane.
        let timer: NodeJS.Timeout | undefined;
        const late = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`It didn't settle within ${EVALUATE_TIMEOUT_MS / 1000} s.`)),
            EVALUATE_TIMEOUT_MS + 500,
          );
        });
        try {
          outcome = record(
            await Promise.race([
              dispatch("Runtime.evaluate", {
                expression,
                returnByValue: true,
                awaitPromise: true,
                timeout: EVALUATE_TIMEOUT_MS,
              }),
              late,
            ]),
          );
        } finally {
          clearTimeout(timer);
        }
      });
      const thrown = record(outcome["exceptionDetails"]);
      if (Object.keys(thrown).length > 0) {
        const description = record(thrown["exception"])["description"] ?? thrown["text"];
        return `Threw: ${clip(String(description ?? "an exception"), 2_000)}`;
      }
      const result = record(outcome["result"]);
      const value =
        "value" in result
          ? JSON.stringify(result["value"], null, 2)
          : String(result["unserializableValue"] ?? result["description"] ?? result["type"]);
      return clip(value ?? "undefined");
    },
    network: (filter) => {
      const needle = filter?.toLowerCase();
      const entries = [...requests.values()].filter(
        (entry) =>
          loader !== undefined &&
          entry.loader === loader &&
          (needle === undefined || entry.url.toLowerCase().includes(needle)),
      );
      if (entries.length === 0) return "(no requests yet)";
      const lines = entries
        .slice(-NETWORK_SHOWN)
        .map((entry) =>
          [
            entry.id,
            entry.method,
            entry.status ?? (entry.failed === undefined ? "…" : "failed"),
            entry.type,
            entry.mimeType ?? "",
            oneLine(entry.url, 300),
            entry.failed === undefined ? "" : `(${entry.failed})`,
          ]
            .filter((part) => part !== "")
            .join(" "),
        );
      return entries.length > NETWORK_SHOWN
        ? `… (${entries.length - NETWORK_SHOWN} earlier left out)\n${lines.join("\n")}`
        : lines.join("\n");
    },
    responseBody: async (requestId) => {
      const entry = requests.get(requestId);
      if (entry === undefined || loader === undefined || entry.loader !== loader)
        throw new StaleRefError(`${requestId} isn't a request of this page; list them again.`);
      const body = record(await read("Network.getResponseBody", { requestId }));
      if (typeof body["body"] !== "string") throw new Error("That response has no body.");
      return body["base64Encoded"] === true
        ? `(binary, ${Buffer.from(body["body"], "base64").length} bytes${entry.mimeType === undefined ? "" : `, ${entry.mimeType}`})`
        : clip(body["body"]);
    },
    clickSubmits: async (target) => {
      const node = "ref" in target ? nodeOf(target.ref) : await nodeAt(target.coordinate);
      return asSubmit(await callOn(node, CLICK_SUBMITS));
    },
    enterSubmits: async (ref) =>
      asSubmit(await callOn(ref === undefined ? undefined : nodeOf(ref), ENTER_SUBMITS)),
    keySubmits: async (ref, key) =>
      key === "Enter" || key === " " || key === "Space"
        ? asSubmit(
            await callOn(ref === undefined ? undefined : nodeOf(ref), KEY_SUBMITS, [
              key === "Enter" ? "Enter" : " ",
            ]),
          )
        : undefined,
    click: async (target, options = {}) =>
      perform(
        "click",
        "ref" in target
          ? { source: "dom-ref", ref: target.ref }
          : { source: "coordinate", point: target.coordinate },
        async () => {
          await viewport(true);
          const point = "ref" in target ? await centerOf(nodeOf(target.ref)) : target.coordinate;
          const v = await viewport(true);
          if (
            !point.every(Number.isFinite) ||
            point[0] < 0 ||
            point[1] < 0 ||
            point[0] >= v.width ||
            point[1] >= v.height
          )
            throw new Error("Click is outside the viewport.");
          const region = "ref" in target ? await regionOf(nodeOf(target.ref)) : undefined;
          action = {
            ...action!,
            viewport: v,
            target: { ...action!.target!, point, ...(region === undefined ? {} : { region }) },
          };
          await mouseClick(point, options.button ?? "left", options.double === true ? 2 : 1);
        },
      ),
    hover: async (target) =>
      perform("hover", targetOf(target), async () => {
        await viewport(true);
        const point = await pointOf(target);
        action = { ...action!, target: { ...action!.target!, point } };
        await mouse("mouseMoved", point);
      }),
    scroll: async (target, direction, amount) =>
      perform("scroll", target === undefined ? undefined : targetOf(target), async () => {
        const v = await viewport(true);
        const point =
          target === undefined
            ? ([Math.floor(v.width / 2), Math.floor(v.height / 2)] as const)
            : await pointOf(target);
        action = {
          ...action!,
          viewport: v,
          ...(action!.target === undefined ? {} : { target: { ...action!.target, point } }),
        };
        const distance = amount * WHEEL_NOTCH;
        await dispatch("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: point[0],
          y: point[1],
          deltaX: direction === "left" ? -distance : direction === "right" ? distance : 0,
          deltaY: direction === "up" ? -distance : direction === "down" ? distance : 0,
        });
      }),
    scrollTo: async (ref) =>
      perform("scrollTo", { source: "dom-ref", ref }, async () => {
        const node = nodeOf(ref);
        if (
          (await callOn(node, "function () { return this.ownerDocument === document; }")) !== true
        )
          throw new StaleRefError("Use a top-frame element from a fresh snapshot.");
        try {
          await dispatch("DOM.scrollIntoViewIfNeeded", { backendNodeId: node });
        } catch (error) {
          if (
            error instanceof UserControlError ||
            error instanceof PageAccessError ||
            error instanceof StalePageError
          )
            throw error;
          throw new StaleRefError(`${ref} can't be scrolled to; take a new snapshot.`, {
            cause: error,
          });
        }
        action = {
          ...action!,
          viewport: await viewport(),
          target: { source: "dom-ref", ref, region: await regionOf(node) },
        };
      }),
    drag: async (from, to) =>
      perform("drag", targetOf(from), async () => {
        await viewport(true);
        // The destination is scrolled to first, then the start, which must still be on screen.
        const end = await pointOf(to);
        const start = await pointOf(from);
        if ("ref" in to) {
          const r = await regionOf(nodeOf(to.ref));
          if (Math.abs(r.x + r.width / 2 - end[0]) > 1 || Math.abs(r.y + r.height / 2 - end[1]) > 1)
            throw new Error("The drag's two ends don't fit on screen together.");
        }
        action = {
          ...action!,
          target: {
            ...action!.target!,
            point: start,
            ...("ref" in to ? { toRef: to.ref } : {}),
            toPoint: end,
          },
        };
        // A page's HTML drag-and-drop isn't run by synthetic mouse input: the protocol hands it
        // over (`Input.dragIntercepted`) for the driver to drop where the drag ends.
        let dragged: unknown;
        const off = cdp.on("Input.dragIntercepted", (params) => {
          dragged = record(params)["data"];
        });
        await dispatch("Input.setInterceptDrags", { enabled: true });
        try {
          await mouse("mouseMoved", start);
          await mouse("mousePressed", start, { button: "left", buttons: 1, clickCount: 1 });
          for (let step = 1; step <= DRAG_STEPS; step++) {
            const at = [
              start[0] + ((end[0] - start[0]) * step) / DRAG_STEPS,
              start[1] + ((end[1] - start[1]) * step) / DRAG_STEPS,
            ] as const;
            await mouse("mouseMoved", at, { button: "left", buttons: 1 });
            if (dragged !== undefined) break;
          }
          if (dragged !== undefined) {
            for (const type of ["dragEnter", "dragOver", "drop"])
              await dispatch("Input.dispatchDragEvent", {
                type,
                x: end[0],
                y: end[1],
                data: dragged,
              });
          }
          await mouse("mouseReleased", end, { button: "left", buttons: 0, clickCount: 1 });
        } finally {
          off();
          await cdp.send("Input.setInterceptDrags", { enabled: false }).catch(() => {});
        }
      }),
    type: async (text, ref, enter) =>
      perform("type", ref === undefined ? undefined : { source: "dom-ref", ref }, async () => {
        if (ref !== undefined) {
          try {
            await dispatch("DOM.focus", { backendNodeId: nodeOf(ref) });
          } catch (error) {
            if (
              error instanceof UserControlError ||
              error instanceof PageAccessError ||
              error instanceof StalePageError
            )
              throw error;
            throw new StaleRefError(`${ref} can't take typing; take a new snapshot.`);
          }
        }
        if (text !== "") await dispatch("Input.insertText", { text });
        if (enter) await pressEnter();
      }),
    formInput: async (ref, value) =>
      perform("formInput", { source: "dom-ref", ref }, async () => {
        // Runtime mutation may throw after dispatch; retain unknown outcome in that case.
        nodeOf(ref);
        await callOn(nodeOf(ref), SET_VALUE, [value], true);
      }),
    pressKey: async (ref, key, options = {}) =>
      perform("pressKey", ref === undefined ? undefined : { source: "dom-ref", ref }, async () => {
        if (!isPaneKey(key)) throw new Error("Unsupported key.");
        const repeat = options.repeat ?? 1;
        if (!Number.isInteger(repeat) || repeat < 1 || repeat > PANE_KEY_REPEAT_MAX)
          throw new Error("Unsupported repeat.");
        const refusal = paneKeyRefusal(key, options.modifiers);
        if (refusal !== undefined) throw new Error(refusal);
        const modifiers = (options.modifiers ?? []).reduce((bits, m) => {
          if (!Object.hasOwn(MODIFIER_BITS, m)) throw new Error("Unsupported modifier.");
          return bits | MODIFIER_BITS[m];
        }, 0);
        if (ref !== undefined) {
          const node = nodeOf(ref);
          if (
            (await callOn(node, "function () { return this.ownerDocument === document; }")) !== true
          )
            throw new StaleRefError("Use a top-frame element from a fresh snapshot.");
          await dispatch("DOM.focus", { backendNodeId: node });
          if (
            (await callOn(node, "function () { return document.activeElement === this; }")) !== true
          )
            throw new StaleRefError("The target did not retain focus; take a new snapshot.");
        }
        const input = { ...keyEvent(key, modifiers), modifiers };
        const {
          text: _text,
          unmodifiedText: _unmodified,
          ...up
        } = input as typeof input & {
          text?: string;
          unmodifiedText?: string;
        };
        for (let i = 0; i < repeat; i++) {
          await dispatch("Input.dispatchKeyEvent", {
            type: "text" in input ? "keyDown" : "rawKeyDown",
            ...input,
          });
          await dispatch("Input.dispatchKeyEvent", { type: "keyUp", ...up });
        }
      }),
    waitFor: async (ms, until) => {
      const deadline = Date.now() + ms;
      const node = until.ref === undefined ? undefined : nodeOf(until.ref);
      const needle = until.text?.toLowerCase();
      if (needle === undefined && node === undefined) {
        await delay(ms);
        return true;
      }
      for (;;) {
        const shown =
          needle === undefined
            ? (await callOn(node, IS_SHOWN)) === true
            : String((await callOn(undefined, VISIBLE_TEXT)) ?? "")
                .toLowerCase()
                .includes(needle);
        if (shown) return true;
        const left = deadline - Date.now();
        if (left <= 0) return false;
        await delay(Math.min(WAIT_POLL_MS, left));
      }
    },
    console: observations.console,
    formSubmission: (url) => {
      const at = submissions.get(withoutHash(url));
      return at !== undefined && Date.now() - at < SUBMISSION_FRESH_MS;
    },
    reset: resetDocument,
    holdConsole: (from) => {
      observations.hold(from);
      if (from !== null) {
        capture = undefined;
        action = undefined;
      }
    },
    dispose: () => {
      observations.dispose();
      for (const off of unsubscribe) off();
    },
  };
}
