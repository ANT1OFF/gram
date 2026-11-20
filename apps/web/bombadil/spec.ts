// Bombadil's random exploration of the mock web app (a four-week, report-only trial; see
// docs/VERIFICATION.md#random-exploration-trial). Bombadil clicks, types, scrolls and navigates at
// random and checks every exported property on each state it captures. It acts faster than the app
// settles, so a property here holds in any one state, or compares a state only with the next.
import { actions, always, next, weighted } from "@antithesishq/bombadil";
import { extract, type ActionTemplate } from "@antithesishq/bombadil/browser";

import { installFlickerObserver, type FlickerAllow } from "../e2e/flicker-observer.ts";

// Its shipped properties and actions: no console errors, HTTP error codes, uncaught exceptions or
// unhandled rejections.
export * from "@antithesishq/bombadil/browser/defaults";

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
    count: report.count,
    byKind: { ...report.byKind },
    allowed: { ...report.allowed },
    last: report.last.map((offender) => ({ ...offender })),
  };
});

export const noFlicker = always(() => flicker.current.count === 0);
