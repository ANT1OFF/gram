// Bombadil's random exploration of the mock web app (a four-week, report-only trial; see
// docs/VERIFICATION.md#random-exploration-trial). Bombadil clicks, types, scrolls and navigates at
// random and checks every exported property on each state it captures. It acts faster than the app
// settles, so a property here holds in any one state, or compares a state only with the next.
import { always, next } from "@antithesishq/bombadil";
import { extract } from "@antithesishq/bombadil/browser";

// Its shipped properties and actions: no console errors, HTTP error codes, uncaught exceptions or
// unhandled rejections.
export * from "@antithesishq/bombadil/browser/defaults";

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
  const now = inbox.current;
  if (now === null || now.count === null) return true; // closed, or on "for later"
  return now.count === 0 ? now.rows === 0 : now.rows >= 1 && now.rows <= now.count;
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
