// Fences text Gram didn't write, such as a check's output, so an agent reads it as data: between
// an opener and a footer only Gram writes, with any copy of those markers inside made inert.

export const FENCE_OPENER = "[BEGIN UNTRUSTED EXTERNAL CONTENT";
export const FENCE_FOOTER = "[END UNTRUSTED EXTERNAL CONTENT]";

/** Every string only Gram writes around fenced text; inside it they're inert. */
const MARKERS: ReadonlyArray<string> = [FENCE_OPENER, FENCE_FOOTER];

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `text` with each marker opened by `(` instead of `[`, in any letter case, so content that
 * reproduces one can't close the fence early and carry on in Gram's voice.
 */
export const defang = (text: string): string =>
  MARKERS.reduce(
    (out, marker) =>
      out.replace(new RegExp(escapeRegExp(marker), "gi"), (found) => `(${found.slice(1)}`),
    text,
  );

/** `text` between `header` and the footer, its markers made inert. */
export const fence = (header: string, text: string): string =>
  `${header}\n${defang(text)}\n${FENCE_FOOTER}`;
