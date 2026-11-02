/**
 * Clean-up for each committed utterance, before vocabulary replacement and never on the live
 * partial: filler words leave, spoken formatting ("new line") becomes line breaks, and spoken
 * symbols ("foo underscore bar") become characters joined as written code joins them. A pure
 * function of the text and the three switches, so later steps can chain onto it.
 *
 * The filler, formatting and symbol rules are ported from Hex's `src/dictation/filler_words.rs`,
 * `spoken_formatting.rs` and `spoken_symbols.rs` (https://github.com/anomalyco/hex), English only.
 * The developer symbols past Hex's own, the determiner guard, the bullet and empty-pair spacing,
 * backtick pairing and the `literal` escape are Gram's.
 *
 * Hex is under the MIT License:
 *
 * Copyright (c) 2026 Christopher Langton
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type { DictationCleanup } from "@gram/contracts";

/** Which rules run; each one's switch is on the Voice input page. */
export type PostprocessOptions = DictationCleanup;

/**
 * `text` cleaned up: fillers first, so one can't sit between a symbol and its neighbour, then
 * formatting, then symbols.
 */
export const postprocess = (text: string, options: PostprocessOptions): string => {
  let out = text;
  if (options.fillers) out = removeFillers(out);
  if (options.formatting) out = applyFormatting(out);
  if (options.symbols) out = applySymbols(out);
  return out;
};

// ---------------------------------------------------------------------------------------------
// Shared

const isAlnum = (c: string | undefined): boolean => c !== undefined && /^[\p{L}\p{N}]$/u.test(c);
/** Part of a word: "uh-huh", "don't" and "um_count" are one word each. */
const joinsWord = (c: string | undefined): boolean =>
  isAlnum(c) || c === "-" || c === "_" || c === "'" || c === "’";
const isSpace = (c: string | undefined): boolean =>
  c !== undefined && c !== "\n" && /^\s$/u.test(c);
const isUpper = (c: string): boolean => c !== c.toLowerCase() && c === c.toUpperCase();

/** `out` without trailing spaces (never newlines) or any of `also`, never below `floor`. */
const trimEnd = (out: string, also: string, floor = 0): string => {
  let end = out.length;
  while (end > floor && (isSpace(out[end - 1]) || also.includes(out[end - 1] ?? "\0"))) end--;
  return out.slice(0, end);
};

/** Past any spaces (not newlines) or `also` from `index`. */
const skip = (chars: readonly string[], index: number, also: string): number => {
  let at = index;
  while (at < chars.length && (isSpace(chars[at]) || also.includes(chars[at] ?? "\0"))) at++;
  return at;
};

/** Where `words` end if they're spoken from `start` as whole words, ignoring case. */
const phraseAt = (
  chars: readonly string[],
  start: number,
  words: readonly string[],
): number | undefined => {
  if (start > 0 && joinsWord(chars[start - 1])) return undefined;
  let at = start;
  for (const [number, word] of words.entries()) {
    if (number > 0) {
      const from = at;
      while (at < chars.length && /^\s$/u.test(chars[at] ?? "")) at++;
      if (at === from) return undefined;
    }
    for (const expected of word) {
      if (chars[at]?.toLowerCase() !== expected) return undefined;
      at++;
    }
  }
  return joinsWord(chars[at]) ? undefined : at;
};

/**
 * Words that make the next one a noun, as in "a dot on the screen", "the colon", "start a new
 * paragraph" or "polka dot": a phrase after one stays as spoken. Not "this" or "my", which start
 * code as often ("this dot props", "my underscore var").
 */
const DETERMINERS = new Set([
  "a",
  "an",
  "another",
  "any",
  "each",
  "every",
  "no",
  "polka",
  "some",
  "the",
  "these",
  "those",
  "what",
  "which",
]);

/** Whether the last word written is one of `DETERMINERS`. */
const afterDeterminer = (out: string): boolean => {
  const last = /(\p{L}+)[^\S\n]*$/u.exec(out)?.[1];
  return last !== undefined && DETERMINERS.has(last.toLowerCase());
};

interface Phrase {
  readonly words: readonly string[];
}

/** The first of `phrases` spoken at `start`; list longer phrases first. */
const matchAt = <P extends Phrase>(
  chars: readonly string[],
  start: number,
  phrases: readonly P[],
): { phrase: P; end: number } | undefined => {
  for (const phrase of phrases) {
    const end = phraseAt(chars, start, phrase.words);
    if (end !== undefined) return { phrase, end };
  }
  return undefined;
};

/**
 * One step of a phrase pass at `index`: "literal" before a phrase writes the phrase as spoken, and
 * a phrase after a determiner stays as spoken. Returns where to continue, or `undefined` when
 * neither applies.
 */
const verbatimAt = <P extends Phrase>(
  chars: readonly string[],
  index: number,
  out: { text: string },
  phrases: readonly P[],
): number | undefined => {
  const literal = phraseAt(chars, index, ["literal"]);
  if (literal !== undefined) {
    const next = skip(chars, literal, "");
    const escaped = next > literal ? matchAt(chars, next, phrases) : undefined;
    if (escaped !== undefined) {
      out.text += chars.slice(next, escaped.end).join("");
      return escaped.end;
    }
  }
  const match = matchAt(chars, index, phrases);
  if (match !== undefined && afterDeterminer(out.text)) {
    out.text += chars.slice(index, match.end).join("");
    return match.end;
  }
  return undefined;
};

// ---------------------------------------------------------------------------------------------
// Filler words, ported from Hex's filler_words.rs: a filler matches as a whole word, lowercase or
// with only its first letter capitalised, so "umbrella", "error", "uh-huh" and "ER" stay. The comma
// or ellipsis that comes with one goes too, the spaces around it close up, and a capitalised filler
// that started a sentence hands its capital to the next word. Line breaks are kept. Real words such
// as "like" or "so" are never fillers.

const FILLERS = ["um", "umm", "uh", "uhh", "uhm", "erm", "er", "ah"];

/** Ends a phrase, so a filler before it leaves no space. */
const CLOSING = new Set([".", ",", ";", ":", "!", "?", ")", "]", "}", "”", "’", "…"]);

/** Where the filler starting at `start` ends, if one does. */
const fillerAt = (chars: readonly string[], start: number): number | undefined => {
  if (start > 0 && joinsWord(chars[start - 1])) return undefined;
  for (const word of FILLERS) {
    const end = start + word.length;
    const matches = [...word].every(
      (expected, number) =>
        chars[start + number] === expected ||
        (number === 0 && chars[start] === expected.toUpperCase()),
    );
    if (matches && !joinsWord(chars[end])) return end;
  }
  return undefined;
};

/** Where the text goes on after a filler ending at `end`, past its own comma or ellipsis. */
const afterFiller = (chars: readonly string[], end: number): number => {
  let at = skip(chars, end, "");
  if (chars[at] === "," || chars[at] === "…") at++;
  else if (chars[at] === "." && chars[at + 1] === "." && chars[at + 2] === ".") at += 3;
  return skip(chars, at, "");
};

const sentenceStart = (out: string): boolean => {
  const last = out.at(-1);
  return last === undefined || ".!?\n".includes(last);
};

const needsSpace = (out: string): boolean => {
  const last = out.at(-1);
  if (last === undefined || "\n([{“‘".includes(last)) return false;
  if (last === '"') return out.length > 1 && !/\s/u.test(out.at(-2) ?? "");
  return true;
};

export const removeFillers = (text: string): string => {
  const chars = Array.from(text);
  let out = "";
  // A filler was just removed: the next text decides the spacing.
  let removed = false;
  let capitalize = false;
  let index = 0;
  while (index < chars.length) {
    const end = fillerAt(chars, index);
    if (end !== undefined) {
      out = trimEnd(out, "");
      if (!removed) capitalize = isUpper(chars[index] ?? "") && sentenceStart(out);
      index = afterFiller(chars, end);
      removed = true;
      continue;
    }
    const c = chars[index] ?? "";
    index++;
    if (removed) {
      if (isSpace(c)) continue;
      if (c === "\n") {
        removed = false;
        capitalize = false;
        out += c;
        continue;
      }
      if (".!?,".includes(c) && sentenceStart(out)) continue;
      removed = false;
      const closing = CLOSING.has(c) || (c === '"' && !isAlnum(chars[index]));
      if (closing) {
        out = trimEnd(out, ",");
        capitalize = false;
      } else {
        if (needsSpace(out)) out += " ";
        if (capitalize) {
          capitalize = false;
          out += c.toUpperCase();
          continue;
        }
      }
    }
    out += c;
  }
  return removed ? trimEnd(out, ",") : out;
};

// ---------------------------------------------------------------------------------------------
// Spoken formatting, ported from Hex's spoken_formatting.rs: whole phrases become line breaks and
// quotation marks, and the commas, periods and spaces a model puts around one go with it.

type FormattingCommand =
  | { readonly kind: "break"; readonly text: string }
  | { readonly kind: "open-quote" }
  | { readonly kind: "close-quote" };

interface FormattingPhrase extends Phrase {
  readonly command: FormattingCommand;
}

const FORMATTING: readonly FormattingPhrase[] = [
  { words: ["new", "paragraph"], command: { kind: "break", text: "\n\n" } },
  { words: ["new", "line"], command: { kind: "break", text: "\n" } },
  { words: ["line", "break"], command: { kind: "break", text: "\n" } },
  { words: ["open", "quote"], command: { kind: "open-quote" } },
  { words: ["close", "quote"], command: { kind: "close-quote" } },
];

export const applyFormatting = (text: string): string => {
  const chars = Array.from(text);
  const out = { text: "" };
  let index = 0;
  while (index < chars.length) {
    const verbatim = verbatimAt(chars, index, out, FORMATTING);
    if (verbatim !== undefined) {
      index = verbatim;
      continue;
    }
    const match = matchAt(chars, index, FORMATTING);
    if (match !== undefined) {
      index = emitFormatting(out, match.phrase.command, chars, match.end);
      continue;
    }
    out.text += chars[index] ?? "";
    index++;
  }
  return out.text;
};

const emitFormatting = (
  out: { text: string },
  command: FormattingCommand,
  chars: readonly string[],
  end: number,
): number => {
  switch (command.kind) {
    case "break":
      out.text = trimEnd(out.text, ",;") + command.text;
      return skip(chars, end, ",.;:");
    case "open-quote": {
      out.text = trimEnd(out.text, "");
      const last = out.text.at(-1);
      if (last !== undefined && !'\n(["'.includes(last)) out.text += " ";
      out.text += '"';
      return skip(chars, end, ",.");
    }
    case "close-quote": {
      out.text = `${trimEnd(out.text, ",")}"`;
      const next = skip(chars, end, "");
      if (isAlnum(chars[next])) out.text += " ";
      return next;
    }
  }
};

// ---------------------------------------------------------------------------------------------
// Spoken symbols, after Hex's spoken_symbols.rs: whole spoken words for symbols become the
// characters, joined to their neighbours as written text joins them. The commas, periods and
// spaces a model puts around one go with it.

/**
 * Which neighbour a symbol attaches to: `next` ("@claude"), `both` ("foo_bar"), `previous` with one
 * space after ("done, thanks"), `spaced` with a space each side ("a => b"), `close` as `previous`
 * but an empty pair joins the word before ("foo()"), and `toggle` opening or closing in turn
 * ("`code`").
 */
type Join = "next" | "both" | "previous" | "spaced" | "close" | "toggle";

interface SymbolPhrase extends Phrase {
  readonly symbol: string;
  readonly join: Join;
}

const sym = (spoken: string, symbol: string, join: Join): SymbolPhrase => ({
  words: spoken.split(" "),
  symbol,
  join,
});

/**
 * Kept to words that rarely mean anything else in a prompt: "equals", "hash", "pipe", "star" and
 * "period" alone are prose too often, so they need "sign" or another word. Longer phrases first.
 */
export const SYMBOLS: readonly SymbolPhrase[] = [
  sym("open angle bracket", "<", "next"),
  sym("close angle bracket", ">", "close"),
  sym("open square bracket", "[", "next"),
  sym("close square bracket", "]", "close"),
  sym("open curly brace", "{", "next"),
  sym("close curly brace", "}", "close"),
  sym("open paren", "(", "next"),
  sym("open parenthesis", "(", "next"),
  sym("close paren", ")", "close"),
  sym("close parenthesis", ")", "close"),
  sym("open bracket", "[", "next"),
  sym("close bracket", "]", "close"),
  sym("open brace", "{", "next"),
  sym("close brace", "}", "close"),
  sym("triple backtick", "```", "next"),
  sym("dash dash", "--", "next"),
  sym("double dash", "--", "next"),
  sym("double colon", "::", "both"),
  sym("triple equals", "===", "spaced"),
  sym("double equals", "==", "spaced"),
  sym("equals sign", "=", "spaced"),
  sym("equal sign", "=", "spaced"),
  sym("fat arrow", "=>", "spaced"),
  sym("plus sign", "+", "spaced"),
  sym("at sign", "@", "next"),
  sym("hash sign", "#", "next"),
  sym("pound sign", "#", "next"),
  sym("dollar sign", "$", "next"),
  sym("forward slash", "/", "both"),
  sym("question mark", "?", "previous"),
  sym("exclamation mark", "!", "previous"),
  sym("exclamation point", "!", "previous"),
  sym("hashtag", "#", "next"),
  sym("backtick", "`", "toggle"),
  sym("underscore", "_", "both"),
  sym("hyphen", "-", "both"),
  sym("dash", "-", "both"),
  sym("backslash", "\\", "both"),
  sym("slash", "/", "both"),
  sym("dot", ".", "both"),
  sym("asterisk", "*", "both"),
  sym("tilde", "~", "next"),
  sym("ampersand", "&", "spaced"),
  sym("semicolon", ";", "previous"),
  sym("colon", ":", "previous"),
  sym("comma", ",", "previous"),
];

/** After these a `previous` or `close` symbol adds no space. */
const NO_SPACE_BEFORE = '\n,.;:!?)]}"`';

const OPENER_OF: Readonly<Record<string, string>> = { ")": "(", "]": "[" };

export const applySymbols = (text: string): string => {
  const chars = Array.from(text);
  const out = { text: "" };
  // Where the last symbol written ends, so trimming never removes it.
  let floor = 0;
  let backticks = 0;
  let index = 0;
  while (index < chars.length) {
    const verbatim = verbatimAt(chars, index, out, SYMBOLS);
    if (verbatim !== undefined) {
      index = verbatim;
      continue;
    }
    const match = matchAt(chars, index, SYMBOLS);
    if (match === undefined) {
      out.text += chars[index] ?? "";
      index++;
      continue;
    }
    const { symbol } = match.phrase;
    let join = match.phrase.join;
    if (join === "toggle") join = backticks++ % 2 === 0 ? "next" : "close";
    const lineStart = /(?:^|\n)[^\S\n]*$/u.test(out.text);
    if (join === "both" && symbol === "-" && lineStart) {
      // A list item: "dash milk" at the start of a line is "- milk".
      out.text = `${trimEnd(out.text, "")}- `;
      floor = out.text.length;
      index = skip(chars, match.end, ",.");
      continue;
    }
    if (join !== "next") out.text = trimEnd(out.text, ",", floor);
    if (join === "close") {
      // "foo open paren close paren" is "foo()".
      const opener = OPENER_OF[symbol];
      if (
        opener !== undefined &&
        out.text.length === floor &&
        out.text.endsWith(` ${opener}`) &&
        isAlnum(out.text.at(-3))
      )
        out.text = out.text.slice(0, -2) + opener;
    }
    if (join === "spaced" && out.text !== "" && !"\n([{ ".includes(out.text.at(-1) ?? ""))
      out.text += " ";
    out.text += symbol;
    floor = out.text.length;
    // A closing mark's punctuation is the sentence's; an opening one's is the model's.
    const next = skip(chars, match.end, join === "close" ? "" : ",.");
    const following = chars[next];
    if (join === "spaced" && following !== undefined && following !== "\n") out.text += " ";
    if (
      (join === "previous" || join === "close") &&
      following !== undefined &&
      !NO_SPACE_BEFORE.includes(following)
    )
      out.text += " ";
    index = next;
  }
  return out.text;
};
