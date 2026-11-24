import { fieldsOf, type PickedElement } from "@gram/contracts";

/**
 * The isolated world the picker runs in: the page's own scripts can't see or replace its listeners
 * and overlay. What it reports is still the page's content, read in `parsePicked`.
 */
export const PICK_WORLD = 1747;

const TEXT_MAX = 80;
const HTML_MAX = 1500;
const SELECTOR_MAX = 300;
const STYLE_MAX = 120;

/** The computed styles a pick carries: how the element is laid out and looks. */
export const PICK_STYLES = [
  "display",
  "position",
  "margin",
  "padding",
  "width",
  "height",
  "font-size",
  "font-weight",
  "color",
  "background-color",
  "border-radius",
  "gap",
] as const;

/**
 * Runs in the page: outlines the element under the pointer with its selector and size, and
 * resolves with what the user clicks, or `null` on Esc or `window.__gramPickCancel()`. The click
 * that picks goes to Gram, never to the page.
 */
export const PICK_SCRIPT = `new Promise((resolve) => {
  if (window.__gramPickCancel) window.__gramPickCancel();
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
  const root = host.attachShadow({ mode: "closed" });
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;border:2px solid #3b82f6;border-radius:4px;background:rgba(59,130,246,.12);display:none";
  const tag = document.createElement("div");
  tag.style.cssText = "position:fixed;padding:2px 6px;border-radius:4px;background:#2563eb;color:#fff;font:11px ui-monospace,monospace;white-space:nowrap;display:none";
  root.append(box, tag);
  document.documentElement.append(host);
  const styles = ${JSON.stringify(PICK_STYLES)};
  const part = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) return s + "#" + CSS.escape(el.id);
    const classes = [...el.classList].slice(0, 2).map((c) => "." + CSS.escape(c)).join("");
    s += classes;
    const parent = el.parentElement;
    if (parent && !classes) {
      const same = [...parent.children].filter((c) => c.tagName === el.tagName);
      if (same.length > 1) s += ":nth-of-type(" + (same.indexOf(el) + 1) + ")";
    }
    return s;
  };
  const selector = (el) => {
    const parts = [];
    for (let at = el; at && at !== document.documentElement && parts.length < 4; at = at.parentElement) {
      parts.unshift(part(at));
      if (at.id) break;
    }
    return parts.join(" > ");
  };
  let current = null;
  const show = (el) => {
    current = el;
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: "block", left: r.left - 2 + "px", top: r.top - 2 + "px", width: r.width + "px", height: r.height + "px" });
    tag.textContent = selector(el) + "  " + Math.round(r.width) + " × " + Math.round(r.height);
    const below = r.bottom + 24 < innerHeight;
    Object.assign(tag.style, { display: "block", left: Math.max(0, r.left - 2) + "px", top: (below ? r.bottom + 4 : Math.max(0, r.top - 24)) + "px" });
  };
  const move = (event) => {
    const el = document.elementFromPoint(event.clientX, event.clientY);
    if (el && el !== current && el !== host) show(el);
  };
  const stop = (event) => { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); };
  const done = (value) => {
    removeEventListener("mousemove", move, true);
    removeEventListener("click", click, true);
    removeEventListener("mousedown", stop, true);
    removeEventListener("mouseup", stop, true);
    removeEventListener("keydown", key, true);
    host.remove();
    delete window.__gramPickCancel;
    resolve(value);
  };
  const click = (event) => {
    stop(event);
    const el = current ?? document.elementFromPoint(event.clientX, event.clientY);
    if (!el) return done(null);
    const r = el.getBoundingClientRect();
    const computed = getComputedStyle(el);
    done({
      selector: selector(el),
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, ${TEXT_MAX}),
      html: el.outerHTML.slice(0, ${HTML_MAX}),
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      styles: Object.fromEntries(styles.map((name) => [name, computed.getPropertyValue(name)])),
    });
  };
  const key = (event) => { if (event.key === "Escape") { stop(event); done(null); } };
  window.__gramPickCancel = () => done(null);
  addEventListener("mousemove", move, true);
  addEventListener("click", click, true);
  addEventListener("mousedown", stop, true);
  addEventListener("mouseup", stop, true);
  addEventListener("keydown", key, true);
})`;

/** Ends a pick in progress, if any. */
export const CANCEL_PICK_SCRIPT = "window.__gramPickCancel?.()";

const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" ? value.slice(0, max) : undefined;

const number = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;

/**
 * What the page reported, as a pick: anything not shaped like one is `null`, and every string is
 * cut to its limit, since the page could report anything at all.
 */
export function parsePicked(value: unknown, url: string): PickedElement | null {
  if (typeof value !== "object" || value === null) return null;
  const selector = text("selector" in value ? value.selector : undefined, SELECTOR_MAX);
  const tag = text("tag" in value ? value.tag : undefined, 40);
  const html = text("html" in value ? value.html : undefined, HTML_MAX);
  if (selector === undefined || selector === "" || tag === undefined || html === undefined) {
    return null;
  }
  const rect = "rect" in value ? value.rect : undefined;
  const box = typeof rect === "object" && rect !== null ? rect : {};
  const reported = "styles" in value ? value.styles : undefined;
  const styles: Record<string, string> = {};
  if (typeof reported === "object" && reported !== null) {
    const given = fieldsOf(reported);
    for (const name of PICK_STYLES) {
      const style = text(given.get(name), STYLE_MAX);
      if (style !== undefined && style !== "") styles[name] = style;
    }
  }
  return {
    url,
    selector,
    tag,
    text: (text("text" in value ? value.text : undefined, TEXT_MAX) ?? "")
      .replace(/\s+/g, " ")
      .trim(),
    html,
    rect: {
      x: number("x" in box ? box.x : undefined),
      y: number("y" in box ? box.y : undefined),
      width: number("width" in box ? box.width : undefined),
      height: number("height" in box ? box.height : undefined),
    },
    styles,
  };
}
