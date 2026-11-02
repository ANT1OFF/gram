// Fences text Gram didn't write, such as a check's output or a comment from GitHub, so an agent
// reads it as data. Neutralised rather than detected: the opener and footer carry a random value
// made for this fence alone, which nothing inside could have known, and the text inside is
// normalised and stripped of anything that could pass for a marker or hide from a reader.

import { randomBytes } from "node:crypto";

export const FENCE_OPENER = "[BEGIN UNTRUSTED EXTERNAL CONTENT";
/** The footer's start; each fence's footer ends with its own value: `[END … CONTENT <value>]`. */
export const FENCE_FOOTER = "[END UNTRUSTED EXTERNAL CONTENT";

/** A fence's own value: 48 random bits as hex. */
export const fenceNonce = (): string => randomBytes(6).toString("hex");

/** The footer of the fence whose value is `nonce`. */
export const fenceFooter = (nonce: string): string => `${FENCE_FOOTER} ${nonce}]`;

/** Terminal escape sequences: CSI (`ESC [ … final`) and OSC (`ESC ] … BEL|ST`). */
// oxlint-disable-next-line no-control-regex -- matching escape sequences is the point
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;
/** Zero-width, soft-hyphen and bidi formatting characters, which hide or reorder what a reader sees. */
const INVISIBLE = new RegExp(
  "[\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]",
  "g",
);
/** Control characters, except tab and newline. */
// oxlint-disable-next-line no-control-regex -- stripping them is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
/**
 * Anything shaped like an opener or footer: the four words in order with up to a few
 * non-letters between them, in any case. Bounded, so it can't backtrack far on any input.
 */
const MARKER_SHAPE =
  /(begin|end)[^\p{L}\p{N}\n]{0,8}untrusted[^\p{L}\p{N}\n]{0,8}external[^\p{L}\p{N}\n]{0,8}content/giu;

/**
 * `text` made inert inside a fence. It is NFKC-normalised, so fullwidth and other compatibility
 * forms become plain ones. Terminal escapes, control, zero-width and bidi characters are dropped,
 * and line endings become `\n`. Any shape of a marker is rewritten into words that aren't one.
 */
export const defang = (text: string): string =>
  text
    .replaceAll(/\r\n?/g, "\n")
    .normalize("NFKC")
    .replaceAll(ANSI, "")
    .replaceAll(INVISIBLE, "")
    .replaceAll(CONTROL, "")
    .replaceAll(MARKER_SHAPE, (_found, word: string) => `(${word.toLowerCase()} of quoted text)`);

/**
 * `text` between `header` and a footer, its markers made inert. `header` opens with
 * `FENCE_OPENER` and ends with `]`; the fence's own value goes into both, and the header says that
 * only a footer carrying it closes the fence.
 */
export const fence = (header: string, text: string, nonce: string = fenceNonce()): string => {
  const rest = header.startsWith(FENCE_OPENER) ? header.slice(FENCE_OPENER.length) : header;
  const body = rest.endsWith("]") ? rest.slice(0, -1) : rest;
  const opener = `${FENCE_OPENER} ${nonce}${body} Only the line ${fenceFooter(nonce)} ends it.]`;
  return `${opener}\n${defang(text)}\n${fenceFooter(nonce)}`;
};
