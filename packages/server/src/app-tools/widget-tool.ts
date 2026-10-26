import { AppToolError } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { randomUUID } from "node:crypto";
import type { ThreadRuntimesShape } from "../runtime/thread-runtimes.ts";
import { defineAppTool, failed } from "./definition.ts";

/** A drawing is stored with its message and replayed to every client, so it stays small. */
export const WIDGET_MAX_LENGTH = 256 * 1024;

/** Where the construct opening at `from` ends (exclusive), given what closes it; -1 when it doesn't. */
const after = (text: string, close: string, from: number): number => {
  const at = text.indexOf(close, from);
  return at === -1 ? -1 : at + close.length;
};

/**
 * Where the tag opening at `from` ends (exclusive), or -1. Quote-aware, because an attribute value
 * may hold a `>`: `aria-label="latency > target"` is valid.
 */
const tagEnd = (text: string, from: number): number => {
  let quote: string | undefined;
  for (let i = from; i < text.length; i++) {
    const char = text[i]!;
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return i + 1;
    }
  }
  return -1;
};

/** The non-element constructs a scan steps over, by how they open and close. */
const OPAQUE: ReadonlyArray<readonly [open: string, close: string]> = [
  ["<!--", "-->"],
  ["<![CDATA[", "]]>"],
  ["<?", "?>"],
];

/**
 * Where the first element in `text` at or after `from` ends (exclusive), or why it doesn't: it never
 * closes, or a closing tag names a different element than the one open (`<svg><g></svg></g>`
 * balances by count and is still not a document). A scanner rather than a parser: it finds where the
 * root stops and that the nesting holds, and leaves the rest to `<img>`, which draws it or doesn't.
 */
const elementEnd = (text: string, from: number): number | "unclosed" | "mismatched" => {
  const open: Array<string> = [];
  let i = from;
  while (i < text.length) {
    if (text[i] !== "<") {
      i++;
      continue;
    }
    const opaque = OPAQUE.find(([start]) => text.startsWith(start, i));
    const end = opaque === undefined ? tagEnd(text, i) : after(text, opaque[1], i);
    if (end === -1) return "unclosed";
    if (opaque === undefined) {
      const closing = text[i + 1] === "/";
      const name = /^[^\s/>]*/.exec(text.slice(i + (closing ? 2 : 1), end))?.[0] ?? "";
      if (closing) {
        if (open.pop() !== name) return "mismatched";
      } else if (text[end - 2] !== "/") {
        open.push(name);
      }
      if (open.length === 0) return end;
    }
    i = end;
  }
  return "unclosed";
};

/** Where the root element starts: past the XML declaration, comments and a doctype. */
const rootStart = (svg: string): number => {
  let i = 0;
  for (;;) {
    while (i < svg.length && /\s/.test(svg[i]!)) i++;
    const close = svg.startsWith("<?", i)
      ? "?>"
      : svg.startsWith("<!--", i)
        ? "-->"
        : /^<!doctype/i.test(svg.slice(i, i + 9))
          ? ">"
          : undefined;
    if (close === undefined) return i;
    const end = after(svg, close, i);
    if (end === -1) return i;
    i = end;
  }
};

/** Why `svg` can't be shown, or `undefined` when it can. */
export const widgetProblem = (svg: string): string | undefined => {
  if (svg.length > WIDGET_MAX_LENGTH) {
    return `The SVG is ${svg.length} characters; the limit is ${WIDGET_MAX_LENGTH}.`;
  }
  const start = rootStart(svg);
  if (!/^<svg[\s>/]/i.test(svg.slice(start, start + 5))) {
    return "svg must be one SVG document: <svg …>…</svg>.";
  }
  const end = elementEnd(svg, start);
  if (end === "unclosed") return "The SVG isn't closed; it must end with </svg>.";
  if (end === "mismatched")
    return "The SVG isn't well formed: a closing tag doesn't match its opening tag.";
  // A second root, or anything else after the first, is not one document, and `<img>` draws none of it.
  if (svg.slice(end).trim() !== "")
    return "Nothing may follow the closing </svg>: send one SVG document.";
  return undefined;
};

/**
 * `show_widget`: a chart or diagram in the transcript. SVG only, and shown as an image, which is
 * what keeps it safe to render agent-authored markup: the renderer's CSP allows no frames and no
 * inline script, and an SVG inside `<img>` can neither run script nor fetch anything.
 */
export const showWidgetTool = (runtimes: Pick<ThreadRuntimesShape, "emitChunk">) =>
  defineAppTool({
    descriptor: {
      name: "show_widget",
      class: "self",
      description:
        "Draw a chart or diagram in your reply, as one self-contained SVG document with a viewBox. It renders as a static image: no scripts, no external images, fonts or stylesheets, and no links. For colours use the theme's CSS variables so it suits light and dark: var(--fg), var(--fg-muted), var(--bg), var(--surface), var(--border), var(--accent), var(--success), var(--warning), var(--danger), var(--info); text uses font-family: var(--font). currentColor is not set.",
    },
    input: Schema.Struct({
      // Not `NonEmptyString`: "   " passes that and trims to an image with no name.
      title: Schema.String.check(Schema.isPattern(/\S/)),
      svg: Schema.NonEmptyString,
    }),
    handle: (threadId, { title, svg }) =>
      Effect.gen(function* () {
        const problem = widgetProblem(svg);
        if (problem !== undefined) {
          return yield* new AppToolError({ tool: "show_widget", message: problem });
        }
        const id = randomUUID();
        yield* runtimes
          .emitChunk(threadId, { type: "data-widget", id, data: { id, title: title.trim(), svg } })
          .pipe(Effect.mapError(failed("show_widget")));
        return { widgetId: id };
      }),
  });
