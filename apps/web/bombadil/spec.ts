// Bombadil's random exploration of the mock web app (a four-week, report-only trial; see
// docs/VERIFICATION.md#random-exploration-trial). Bombadil clicks, types, scrolls and navigates at
// random and checks every exported property on each state it captures. It acts faster than the app
// settles, so a property here holds in any one state, or compares a state only with the next.
import { actions, always, eventually, next, now, weighted } from "@antithesishq/bombadil";
import { extract, type ActionTemplate } from "@antithesishq/bombadil/browser";
import { defaultActions } from "@antithesishq/bombadil/browser/defaults";

import { installFlickerObserver, type FlickerAllow } from "../e2e/flicker-observer.ts";

// Its shipped properties: no console errors, HTTP error codes, uncaught exceptions or unhandled
// rejections.
export * from "@antithesishq/bombadil/browser/defaults/properties";

// --- What it does ------------------------------------------------------------------------------
// Its own clicks, typing, scrolling and navigation, and now and then a new window size or an
// Escape while something is open. One generator, weighted: each exported generator would get an
// equal share, and a resize every other step leaves no time to explore.

/** Phone, tablet, small laptop and desktop widths. */
const SIZES: [number, number][] = [
  [360, 740],
  [768, 1024],
  [1024, 768],
  [1440, 900],
];
const resizes = actions((): ActionTemplate[] =>
  SIZES.map(([width, height]) => ({ SetViewport: { width, height } })),
);

const ESCAPE = 27;
const escapes = actions((): ActionTemplate[] =>
  overlays.current.open.length > 0 ? [{ PressKey: { code: ESCAPE } }] : [],
);
/**
 * After an Escape, only looks until what it closed has finished animating out (at most a second):
 * focus goes back once it has, and a click meanwhile would move it first.
 */
const settle = actions((): ActionTemplate[] => ["Wait"]);
const isSettling = () => overlays.current.settling;

export const explore = weighted<ActionTemplate>([
  [40, defaultActions.when(() => !isSettling())],
  [1, resizes.when(() => !isSettling())],
  [4, escapes.when(() => !isSettling())],
  [1, settle.when(isSettling)],
]);

// --- Waiting while the app boots ---------------------------------------------------------------
// Until the app has drawn a control there is nothing to press, and Bombadil ends a run that has no
// action with "no actions available": the first nightly run did, on CI, half a second in. So while
// nothing is drawn it waits, and now and then reloads in case a script never arrived.

const booted = extract((state) => state.document.querySelector("button, a[href]") !== null);

export const waitWhileBooting = weighted<ActionTemplate>([
  [9, actions((): ActionTemplate[] => ["Wait"])],
  [1, actions((): ActionTemplate[] => ["Reload"])],
]).when(() => !booted.current);

// --- The Inbox count agrees with its rows ------------------------------------------------------
// When the Inbox is open on its main list, "N need(s) you" and the rows shown agree: none when
// nothing needs you, and never more rows than the count (a section filter may show fewer).

const inbox = extract((state) => {
  const root = state.document.querySelector('[data-testid="inbox"]');
  if (!root) return null;
  const said = (root.querySelector('[data-testid="inbox-count"]')?.textContent ?? "").trim();
  const match = /^(\d+) needs? you$/.exec(said);
  return {
    said,
    count: match ? Number(match[1]) : said === "Nothing needs you" ? 0 : null,
    rows: root.querySelectorAll('[data-testid="inbox-item"]').length,
  };
});

export const inboxCountAgrees = always(() => {
  const seen = inbox.current;
  if (seen === null || seen.count === null) return true; // closed, or on "for later"
  return seen.count === 0 ? seen.rows === 0 : seen.rows >= 1 && seen.rows <= seen.count;
});

// --- No navigation traps -----------------------------------------------------------------------
// One click adds at most one history entry: a redirect that pushes instead of replacing adds a
// second, and Back then lands on the redirect, which sends you forward again. And Back, with
// somewhere to go back to, leaves the address it started from.

const history = extract((state) => ({
  url: state.navigationHistory.current.url,
  back: state.navigationHistory.back.length,
  action:
    state.lastAction === null
      ? null
      : typeof state.lastAction === "string"
        ? state.lastAction
        : Object.keys(state.lastAction)[0]!,
}));

export const oneEntryPerClick = always(() => {
  const before = history.current;
  return next(() => {
    const after = history.current;
    return after.action !== "Click" || after.back <= before.back + 1;
  });
});

export const backLeavesThePage = always(() => {
  const before = history.current;
  return next(() => {
    const after = history.current;
    return after.action !== "Back" || before.back === 0 || after.url !== before.url;
  });
});

// --- No unrendered values ----------------------------------------------------------------------
// The page never shows `undefined`, `NaN` or `[object Object]` where a value should be. Code,
// editors and what the explorer itself typed are skipped: mock transcripts and files quote these
// words on purpose.

const SKIP =
  'code, pre, kbd, samp, textarea, input, [contenteditable]:not([contenteditable="false"]), .cm-editor, .xterm, script, style, noscript';
const UNRENDERED = /\bundefined\b|\bNaN\b|\[object Object\]/;

const unrendered = extract((state) => {
  const body = state.document.body;
  if (!body) return null;
  const walker = state.document.createTreeWalker(body, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    const match = UNRENDERED.exec(text);
    if (!match) continue;
    const parent = node.parentElement;
    if (parent === null || parent.closest(SKIP) !== null) continue;
    const start = Math.max(0, match.index - 40);
    return {
      text: text.slice(start, match.index + match[0].length + 40).trim(),
      tag: parent.tagName.toLowerCase(),
      testId: parent.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
      url: state.window.location.pathname,
    };
  }
  return null;
});

export const noUnrenderedValues = always(() => unrendered.current === null);

// --- No flicker --------------------------------------------------------------------------------
// Nothing the app does on its own flickers: an element gone for a frame and back, text going
// A → B → A, a list emptied and refilled, all within 300 ms, or a layout shift not right after
// input (e2e/flicker-observer.ts). The observer installs on the first look at each page load, so a
// flicker during boot after a reload goes unseen. Each allowed flicker says why; they still show
// in the trace as `allowed`, by reason.

/** Flickers that are meant: animations and the like. */
const FLICKER_INTENDED: FlickerAllow[] = [
  {
    selector: '[data-testid="setting-receipt"]',
    kinds: ["text-flip"],
    reason: 'a setting saved again cross-fades a new "Saved" over the old one for 200 ms',
  },
  {
    selector: '[data-testid="composer-toolbar"]',
    kinds: ["text-flip"],
    reason:
      "the mock runs turns at a twentieth of their pace, so Steer can come and go within 300 ms",
  },
];

/**
 * Flickers the trial found and nobody has fixed yet. Listed so that a run reports a new one, not
 * these again; remove an entry with its fix.
 */
const FLICKER_KNOWN: FlickerAllow[] = [
  {
    selector: '[data-testid="welcome"]',
    kinds: ["layout-shift"],
    reason: "known: the welcome screen shifts by about 0.05 as it loads at /",
  },
  {
    selector: '[data-testid="right-panel"] *',
    kinds: ["reappeared"],
    reason: "known: switching threads leaves the right panel's diff or PR empty for a frame",
  },
  {
    selector: '[data-testid="settings-subpages"]',
    kinds: ["layout-shift"],
    reason: "known: Settings' list shifts by about 0.03 as it loads after a reload",
  },
  {
    selector: '[data-testid="composer-toolbar"] *',
    kinds: ["reappeared"],
    reason: "known: switching threads redraws the composer's send button with a frame between",
  },
  {
    selector: '[data-testid="keyboard-settings"] li',
    kinds: ["reappeared"],
    reason: "known: Keyboard settings redraw their terminal rows with a frame between on arrival",
  },
  {
    selector: '[data-testid="overview-solo-status"]',
    kinds: ["text-flip"],
    reason: 'known: a thread\'s "now" in the overview blanks for a few frames as it updates',
  },
  {
    selector: '[data-testid="inbox-detail-body"] *',
    kinds: ["reappeared"],
    reason: "known: picking an Inbox item redraws its detail with a frame between",
  },
  {
    selector: '[data-testid="overview-sidebar"], [data-testid="overview-sidebar"] *',
    kinds: ["reappeared"],
    reason: "known: on the way to /threads the overview sidebar's sections go for a frame",
  },
  {
    selector:
      '[data-testid="settings-subpages"], [data-testid="settings-subpages"] *, [data-testid="settings-section-picker"]',
    kinds: ["reappeared", "text-flip"],
    reason:
      'known: opening Settings from the phone menu redraws its list, and shows "Section", for a frame',
  },
  {
    selector: '[data-testid="diff-panel"]',
    kinds: ["text-flip"],
    reason: 'known: a diff that loads at once still shows "Loading diff…" for a frame',
  },
  {
    selector: '[data-testid="right-panel"]',
    kinds: ["text-flip"],
    reason: "known: the right panel's PR tab drops out for a frame or three in Settings",
  },
  {
    selector: '[data-testid="shell-titlebar"]',
    kinds: ["text-flip"],
    reason: "known: the titlebar shows Chat · Board for a frame on the way to /threads",
  },
];

const flicker = extract((state) => {
  const report = installFlickerObserver(
    { allow: [...FLICKER_INTENDED, ...FLICKER_KNOWN] },
    state.window as Window & typeof globalThis,
  );
  return {
    virtualClock: "gramMockClock" in state.window,
    count: report.count,
    byKind: { ...report.byKind },
    allowed: { ...report.allowed },
    last: report.last.map((offender) => ({ ...offender })),
  };
});

/**
 * The replayable mock (`window.gramMockClock`) runs a virtual clock and plays timed states in a few
 * frames, so a 2 s "Loading…" would read as a flicker: there the count is recorded, not judged.
 */
export const noFlicker = always(() => flicker.current.virtualClock || flicker.current.count === 0);

// --- Loading ends ------------------------------------------------------------------------------
// Nothing says "Loading…" or is `aria-busy` for more than 10 s. The mock answers in milliseconds,
// so one that stays is stuck, whatever the explorer does meanwhile. Spinners alone are not
// counted: a running agent's is meant to turn for as long as it runs.

const LOADING_TEXT = /^Loading\b.*(?:…|\.\.\.)$/;

const shown = (element: Element) =>
  typeof element.checkVisibility !== "function" || element.checkVisibility();

const loading = extract((state) => {
  const keys = new Set<string>();
  for (const busy of state.document.querySelectorAll('[aria-busy="true"]')) {
    if (!shown(busy)) continue;
    const testId = busy.closest("[data-testid]")?.getAttribute("data-testid") ?? busy.tagName;
    keys.add(`busy ${testId}`);
  }
  const body = state.document.body;
  if (body) {
    const walker = state.document.createTreeWalker(body, 4 /* NodeFilter.SHOW_TEXT */);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = (node.textContent ?? "").trim();
      if (text.length > 80 || !LOADING_TEXT.test(text)) continue;
      if (node.parentElement && shown(node.parentElement)) keys.add(`text ${text}`);
    }
  }
  return [...keys].slice(0, 10);
});

export const loadingEnds = always(() =>
  loading.current
    .map((key) => eventually(() => !loading.current.includes(key)).within(10, "seconds"))
    .reduce(
      (all, each) => all.and(each),
      now(() => true),
    ),
);

// --- Fits the window ---------------------------------------------------------------------------
// At every window size the page never scrolls sideways, and no two controls in the titlebar or
// the navigation dock overlap. Either may happen for a moment while a resize or a fold animates,
// so it must last a second to count.

const overflow = extract((state) => {
  const win = state.window;
  const doc = state.document;
  const width = win.innerWidth;
  const scrollWidth = Math.max(doc.documentElement.scrollWidth, doc.body?.scrollWidth ?? 0);
  if (scrollWidth <= width + 1) return null;
  let culprit: string | null = null;
  for (const element of doc.body?.querySelectorAll("*") ?? []) {
    const right = element.getBoundingClientRect().right;
    const parentRight = element.parentElement?.getBoundingClientRect().right ?? 0;
    if (right > width + 1 && parentRight <= width + 1) {
      const testId = element.closest("[data-testid]")?.getAttribute("data-testid");
      culprit = `${element.tagName.toLowerCase()}${testId ? ` in ${testId}` : ""}`;
      break;
    }
  }
  return { width, scrollWidth, culprit, path: win.location.pathname };
});

export const noSidewaysScroll = always(
  now(() => overflow.current !== null).implies(
    eventually(() => overflow.current === null).within(1, "seconds"),
  ),
);

const BARS = '[data-testid="shell-titlebar"], [data-testid="nav-dock"]';
const CONTROLS = 'button, a[href], input, [role="button"], [role="tab"], [role="link"]';

const nameOf = (element: Element) =>
  element.getAttribute("aria-label") ??
  element.getAttribute("data-testid") ??
  (element.textContent ?? "").trim().slice(0, 30);

const crowded = extract((state) => {
  for (const bar of state.document.querySelectorAll(BARS)) {
    const controls = [...bar.querySelectorAll(CONTROLS)].filter((control) => {
      if (control.parentElement?.closest(CONTROLS)) return false; // a control inside another
      const box = control.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && shown(control);
    });
    const boxes = controls.map((control) => control.getBoundingClientRect());
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (overlapX > 2 && overlapY > 2)
          return {
            bar: bar.getAttribute("data-testid"),
            first: nameOf(controls[i]!),
            second: nameOf(controls[j]!),
            width: state.window.innerWidth,
          };
      }
    }
  }
  return null;
});

export const barControlsApart = always(
  now(() => crowded.current !== null).implies(
    eventually(() => crowded.current === null).within(1, "seconds"),
  ),
);

// --- Escape closes the topmost dialog or menu --------------------------------------------------
// Escape while a dialog, menu or list popup is open closes the topmost one, and focus goes back to
// what opened it: the trigger that controls it, else what had focus before it opened. Closing may
// animate, so it has a second. When the opener itself went with it (a submenu's), focus may land
// anywhere. Focus is judged only for an overlay open for 300 ms: the explorer can open one and
// press Escape a frame later, faster than a person, and then focus lands where the race leaves it.

interface OverlayWindow {
  gramOverlays?: {
    lastOutside: string | null;
    openers: Record<string, string | null>;
    openedAt: Record<string, number>;
    escapeAt: number;
  };
}

const OVERLAY = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';
/** What opens a list popup; a listbox no such control opens is part of the page, not over it. */
const POPUP_TRIGGER = '[role="combobox"], [aria-haspopup="listbox"]';

const overlays = extract((state) => {
  const doc = state.document;
  const win = state.window as Window & typeof globalThis & OverlayWindow;
  const keyOf = (element: Element | null): string | null => {
    if (element === null || element === doc.body) return null;
    if (element.id !== "") return `#${element.id}`;
    const testId = element.getAttribute("data-testid");
    return testId === null ? null : `${testId} ${element.getAttribute("aria-label") ?? ""}`;
  };
  if (win.gramOverlays === undefined) {
    const tracked = {
      lastOutside: null as string | null,
      openers: {} as Record<string, string | null>,
      openedAt: {} as Record<string, number>,
      escapeAt: -Infinity,
    };
    win.gramOverlays = tracked;
    doc.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") tracked.escapeAt = event.timeStamp;
      },
      true,
    );
    doc.addEventListener(
      "focusin",
      (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target !== null && target.closest(OVERLAY) === null)
          tracked.lastOutside = keyOf(target);
      },
      true,
    );
  }
  const tracked = win.gramOverlays;
  // The frame's time and the key's own timeStamp: a mock's virtual clock leaves both alone.
  const frameTime = doc.timeline?.currentTime;
  const frameNow = typeof frameTime === "number" ? frameTime : win.performance.now();
  const open: { key: string; opener: string | null; settled: boolean }[] = [];
  for (const overlay of doc.querySelectorAll(OVERLAY)) {
    if (overlay.hasAttribute("data-ending-style") || overlay.hasAttribute("data-closed")) continue;
    if (
      overlay.getAttribute("role") === "listbox" &&
      (overlay.id === "" ||
        doc.querySelector(
          POPUP_TRIGGER.split(", ")
            .map((trigger) => `${trigger}[aria-controls~="${win.CSS.escape(overlay.id)}"]`)
            .join(", "),
        ) === null)
    )
      continue;
    if (!shown(overlay)) continue;
    const key =
      keyOf(overlay) ??
      `${overlay.getAttribute("role")} ${overlay.getAttribute("aria-label") ?? ""}`;
    if (!(key in tracked.openers)) {
      const controller =
        overlay.id === ""
          ? null
          : doc.querySelector(`[aria-controls~="${win.CSS.escape(overlay.id)}"]`);
      tracked.openers[key] = keyOf(controller) ?? tracked.lastOutside;
      tracked.openedAt[key] = frameNow;
    }
    open.push({
      key,
      opener: tracked.openers[key] ?? null,
      settled: frameNow - (tracked.openedAt[key] ?? frameNow) >= 300,
    });
  }
  for (const key of Object.keys(tracked.openers))
    if (!open.some((each) => each.key === key)) {
      delete tracked.openers[key];
      delete tracked.openedAt[key];
    }
  const triggers = [...doc.querySelectorAll("[id], [data-testid]")]
    .filter((element) => element.matches(CONTROLS))
    .map(keyOf)
    .filter((key): key is string => key !== null);
  const sinceEscape = frameNow - tracked.escapeAt;
  const closing = doc.querySelector(
    OVERLAY.split(", ")
      .map((overlay) => `${overlay}[data-ending-style]`)
      .join(", "),
  );
  const settling = sinceEscape < 1000 && (sinceEscape < 150 || closing !== null);
  return { open, focus: keyOf(doc.activeElement), triggers, settling };
});

const pressedEscape = extract(
  (state) =>
    state.lastAction !== null &&
    typeof state.lastAction === "object" &&
    "PressKey" in state.lastAction &&
    state.lastAction.PressKey.code === ESCAPE,
);

export const escapeClosesTopmost = always(() => {
  const top = overlays.current.open.at(-1);
  if (top === undefined) return true;
  return next(() => {
    if (!pressedEscape.current) return true;
    return eventually(() => {
      const after = overlays.current;
      const closed = !after.open.some((each) => each.key === top.key);
      const focused =
        !top.settled ||
        top.opener === null ||
        after.focus === top.opener ||
        !after.triggers.includes(top.opener);
      return closed && focused;
    }).within(1, "seconds");
  });
});

// --- One row per item --------------------------------------------------------------------------
// No list shows the same item twice: rows of one kind (`data-testid`) in one list share no
// `data-key`, or `data-thread-id` when they have no key. A row leaving while its replacement
// arrives may overlap for a moment, so it must last a second to count.

const ROW = "[data-testid][data-key], [data-testid][data-thread-id]";
const ROW_LIST = 'ul, ol, [role="list"], [role="listbox"], [role="grid"], [role="tree"]';

const duplicateRow = extract((state) => {
  const seen = new Map<string, number>();
  const lists = new Map<Element, number>();
  for (const row of state.document.querySelectorAll(ROW)) {
    if (!shown(row)) continue;
    const list = row.parentElement?.closest(ROW_LIST) ?? row.parentElement;
    if (!list) continue;
    if (!lists.has(list)) lists.set(list, lists.size);
    const id = row.getAttribute("data-key") ?? row.getAttribute("data-thread-id");
    const key = `${lists.get(list)} ${row.getAttribute("data-testid")} ${id}`;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count > 1)
      return { row: row.getAttribute("data-testid"), id, path: state.window.location.pathname };
  }
  return null;
});

export const oneRowPerItem = always(
  now(() => duplicateRow.current !== null).implies(
    eventually(() => duplicateRow.current === null).within(1, "seconds"),
  ),
);
