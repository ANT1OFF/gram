// A page-side flicker and layout-shift recorder. Bombadil's spec installs it from an extractor
// (apps/web/bombadil/spec.ts); a Playwright spec can install it before the app loads with
// `page.addInitScript(installFlickerObserver, options)`. So `installFlickerObserver` is
// self-contained: it closes over nothing outside its own body, and imports nothing.
//
// It records, per animation frame and only while no input happened in between:
// - `reappeared`: an element with a `data-testid` gone for at least a frame, back within `windowMs`;
// - `text-flip`: a `data-testid` element's visible text going A → B → A within `windowMs`;
// - `list-refill`: a list going empty for at least a frame and refilling within `windowMs`;
// - `layout-shift`: a `layout-shift` entry of at least `minShift` not right after input.
// Input is a pointer press, a key, typing, a scroll, a resize or a history step (Back, Forward):
// what changes after it is a response, not a flicker.

export type FlickerKind = "reappeared" | "text-flip" | "list-refill" | "layout-shift";

export interface FlickerAllow {
  /** Matched against the offending element (`matches`); `X, X *` covers what is inside X too. */
  readonly selector: string;
  /** The kinds it allows; every kind when absent. */
  readonly kinds?: readonly FlickerKind[];
  /** Why this flicker is intended. */
  readonly reason: string;
}

export interface FlickerOptions {
  /** How quickly something must come back to count as a flicker, in ms. */
  readonly windowMs?: number;
  /** How long after input a layout shift is the input's, in ms. */
  readonly inputGraceMs?: number;
  /** The smallest layout-shift score that counts. */
  readonly minShift?: number;
  /** Texts longer than this are not compared (streamed transcripts, documents). */
  readonly maxTextLength?: number;
  /** How many offenders `last` keeps. */
  readonly keep?: number;
  readonly allow?: readonly FlickerAllow[];
}

export interface FlickerOffender {
  readonly kind: FlickerKind;
  /** A short selector for the element: its tag and `data-testid`, and its parents'. */
  readonly selector: string;
  /** What changed, such as `"3 need you" → "2 need you" → "3 need you" in 120 ms`. */
  readonly change: string;
  /** When it was seen, in ms since the page's time origin (the frame's time, not `performance.now()`). */
  readonly at: number;
  readonly path: string;
}

export interface FlickerReport {
  readonly count: number;
  readonly byKind: Readonly<Record<FlickerKind, number>>;
  /** Offenders an allowlist entry matched, by its reason; not in `count`. */
  readonly allowed: Readonly<Record<string, number>>;
  readonly last: readonly FlickerOffender[];
}

declare global {
  interface Window {
    gramFlicker?: FlickerReport;
  }
}

/** Installs the recorder on `win` once; later calls return its report so far. */
export function installFlickerObserver(
  options: FlickerOptions = {},
  win: Window & typeof globalThis = window,
): FlickerReport {
  if (win.gramFlicker !== undefined) return win.gramFlicker;
  const windowMs = options.windowMs ?? 300;
  const inputGraceMs = options.inputGraceMs ?? 500;
  const minShift = options.minShift ?? 0.02;
  const maxTextLength = options.maxTextLength ?? 120;
  const keep = options.keep ?? 5;
  const allow = options.allow ?? [];
  const doc = win.document;

  const report = {
    count: 0,
    byKind: { reappeared: 0, "text-flip": 0, "list-refill": 0, "layout-shift": 0 },
    allowed: {} as Record<string, number>,
    last: [] as FlickerOffender[],
  };
  win.gramFlicker = report;

  // Time is the frame's (`document.timeline`) and the event's own `timeStamp`, never
  // `performance.now()`: a mock with a virtual clock replaces that, and its 300 ms would not be 300.
  const clock = () => {
    const time = doc.timeline?.currentTime;
    return typeof time === "number" ? time : win.performance.now();
  };
  let lastInput = -Infinity;
  const onInput = (event: Event) => {
    lastInput = Math.max(lastInput, event.timeStamp);
  };
  // Typing may arrive as `input` alone, a scroll re-renders virtual lists, and a resize may swap
  // the layout for another.
  for (const type of ["pointerdown", "keydown", "input", "wheel", "scroll", "popstate", "resize"])
    win.addEventListener(type, onInput, { capture: true, passive: true });
  /** Whether input came after `since`: then what followed answered it. */
  const inputSince = (since: number) => lastInput >= since;

  // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page, so it lives inside
  const describe = (element: Element | null): string => {
    const parts: string[] = [];
    for (let at = element; at !== null && parts.length < 3; at = at.parentElement) {
      const testId = at.getAttribute("data-testid");
      if (testId !== null || at === element)
        parts.unshift(
          `${at.tagName.toLowerCase()}${testId === null ? "" : `[data-testid="${testId}"]`}`,
        );
    }
    return parts.join(" ");
  };
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page, so it lives inside
  const quote = (text: string) => JSON.stringify(text.length > 40 ? `${text.slice(0, 39)}…` : text);

  const record = (kind: FlickerKind, element: Element | null, change: string) => {
    const allowedBy = allow.find(
      (entry) =>
        (entry.kinds === undefined || entry.kinds.includes(kind)) &&
        element !== null &&
        element.matches(entry.selector),
    );
    if (allowedBy !== undefined) {
      report.allowed[allowedBy.reason] = (report.allowed[allowedBy.reason] ?? 0) + 1;
      return;
    }
    report.count += 1;
    report.byKind[kind] += 1;
    report.last.push({
      kind,
      selector: describe(element),
      change,
      at: Math.round(clock()),
      path: win.location.pathname,
    });
    if (report.last.length > keep) report.last.shift();
  };

  // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page, so it lives inside
  const visible = (element: Element) =>
    element.isConnected &&
    (typeof element.checkVisibility !== "function" ||
      element.checkVisibility({ opacityProperty: true, visibilityProperty: true }));
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page, so it lives inside
  const textOf = (element: Element) => (element.textContent ?? "").replace(/\s+/g, " ").trim();
  /**
   * An element's identity across remounts: its `data-testid` and what names one of many (a row's
   * key or thread, a label, a link), else the start of its text. It is read only for elements just
   * added or removed and for those sharing a removed one's `data-testid`, never for the whole page.
   */
  const NAMES = [
    "data-key",
    "data-thread-id",
    "data-message-id",
    "data-workspace-id",
    "data-doc-id",
    "aria-label",
    "href",
  ];
  const identity = (element: Element) => {
    const testId = element.getAttribute("data-testid");
    if (testId === null) return null;
    const names = NAMES.map((attribute) => element.getAttribute(attribute) ?? "");
    const named = names.some((name) => name !== "");
    return `${testId}\u0000${named ? names.join("\u0001") : textOf(element).slice(0, 60)}`;
  };
  const LIST =
    'ul, ol, [role="list"], [role="listbox"], [role="grid"], [role="tree"], [role="table"], [role="feed"]';

  // --- What the mutations touched, settled once a frame ------------------------------------------
  const removed = new Map<string, { at: number }>();
  /** Identities gone for at least a frame, and when they went. */
  const gone = new Map<string, number>();
  const added = new Set<Element>();
  const textDirty = new Set<Element>();
  const listDirty = new Set<Element>();
  const texts = new WeakMap<Element, { text: string; since: number }[]>();
  const emptied = new WeakMap<Element, number>();
  const counts = new WeakMap<Element, number>();

  const each = (node: Node, visit: (element: Element) => void) => {
    if (!(node instanceof win.Element)) return;
    visit(node);
    for (const inner of node.querySelectorAll("[data-testid]")) visit(inner);
  };

  new win.MutationObserver((mutations) => {
    const now = clock();
    for (const mutation of mutations) {
      const target =
        mutation.target instanceof win.Element ? mutation.target : mutation.target.parentElement;
      if (target !== null) {
        const owner = target.closest("[data-testid]");
        if (owner !== null) textDirty.add(owner);
        const list = target.closest(LIST);
        if (list !== null) listDirty.add(list);
      }
      for (const node of mutation.removedNodes)
        each(node, (element) => {
          const key = identity(element);
          if (key !== null && !removed.has(key)) removed.set(key, { at: now });
        });
      for (const node of mutation.addedNodes) each(node, (element) => added.add(element));
    }
  }).observe(doc, { subtree: true, childList: true, characterData: true });

  const settle = () => {
    try {
      settleFrame();
    } finally {
      win.requestAnimationFrame(settle);
    }
  };
  const settleFrame = () => {
    const now = clock();
    // Gone: removed, and nothing with its identity in the page a frame later (a move or a
    // remount within one frame is never seen).
    const present = new Set<string>();
    for (const element of added) {
      const key = element.isConnected ? identity(element) : null;
      if (key === null) continue;
      present.add(key);
      const at = gone.get(key);
      if (at !== undefined) {
        gone.delete(key);
        if (now - at <= windowMs && !inputSince(at) && visible(element))
          record("reappeared", element, `gone ${Math.round(now - at)} ms, then back`);
      }
    }
    const inPage = new Map<string, Set<string>>();
    for (const [key, { at }] of removed) {
      if (present.has(key)) continue;
      const testId = key.slice(0, key.indexOf("\u0000"));
      let keys = inPage.get(testId);
      if (keys === undefined) {
        keys = new Set();
        for (const element of doc.querySelectorAll(`[data-testid="${win.CSS.escape(testId)}"]`)) {
          const found = identity(element);
          if (found !== null) keys.add(found);
        }
        inPage.set(testId, keys);
      }
      if (!keys.has(key)) gone.set(key, at);
    }
    removed.clear();
    added.clear();
    for (const [key, at] of gone) if (now - at > windowMs) gone.delete(key);

    // Text: A → B → A, each shown for a frame, within the window and with no input since A left.
    for (const element of textDirty) {
      if (!element.isConnected || !visible(element)) continue;
      const text = textOf(element);
      if (text.length > maxTextLength) continue;
      const seen = texts.get(element) ?? [];
      if (seen.at(-1)?.text === text) continue;
      seen.push({ text, since: now });
      if (seen.length > 3) seen.shift();
      texts.set(element, seen);
      const [a, b, c] = seen;
      if (
        a !== undefined &&
        b !== undefined &&
        c !== undefined &&
        a.text === c.text &&
        c.since - b.since <= windowMs &&
        !inputSince(b.since)
      )
        record(
          "text-flip",
          element,
          `${quote(a.text)} → ${quote(b.text)} → ${quote(c.text)} in ${Math.round(c.since - b.since)} ms`,
        );
    }
    textDirty.clear();

    // Lists: had items, none for a frame, items again within the window with no input between.
    for (const list of listDirty) {
      if (!list.isConnected) continue;
      const items = list.childElementCount;
      const before = counts.get(list);
      counts.set(list, items);
      if (items === 0 && before !== undefined && before > 0) emptied.set(list, now);
      const since = emptied.get(list);
      if (items > 0 && since !== undefined) {
        emptied.delete(list);
        if (now - since <= windowMs && !inputSince(since) && visible(list))
          record(
            "list-refill",
            list,
            `${before ?? 0} → 0 → ${items} items in ${Math.round(now - since)} ms`,
          );
      }
    }
    listDirty.clear();
  };
  win.requestAnimationFrame(settle);

  // Layout shifts the page made on its own: not within `inputGraceMs` of input.
  try {
    new win.PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & {
        value: number;
        hadRecentInput: boolean;
        sources?: { node?: Node | null }[];
      })[]) {
        if (entry.hadRecentInput || entry.value < minShift) continue;
        if (entry.startTime - lastInput < inputGraceMs) continue;
        const node = entry.sources?.find((source) => source.node)?.node ?? null;
        const element = node instanceof win.Element ? node : (node?.parentElement ?? null);
        record("layout-shift", element, `shifted the layout by ${entry.value.toFixed(3)}`);
      }
    }).observe({ type: "layout-shift", buffered: false });
  } catch {
    // No layout-shift entries in this browser: the other three still record.
  }
  return report;
}
