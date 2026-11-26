const FOLDS: Readonly<Record<string, string>> = {
  ß: "ss",
  æ: "ae",
  Æ: "AE",
  ø: "o",
  Ø: "O",
  ð: "d",
  Ð: "D",
  þ: "th",
  Þ: "Th",
  œ: "oe",
  Œ: "OE",
  ł: "l",
  Ł: "L",
  đ: "d",
  Đ: "D",
  ħ: "h",
  Ħ: "H",
  ı: "i",
  ŧ: "t",
  Ŧ: "T",
  ŋ: "n",
  Ŋ: "N",
  ŀ: "l",
  Ŀ: "L",
};

const FOLDED = new RegExp(`[${Object.keys(FOLDS).join("")}]`, "g");

const LATIN_LOOKALIKES: Readonly<Record<string, string>> = {
  а: "a",
  в: "b",
  е: "e",
  һ: "h",
  і: "i",
  ј: "j",
  к: "k",
  ӏ: "l",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  ԛ: "q",
  г: "r",
  ѕ: "s",
  т: "t",
  у: "y",
  ү: "y",
  ԝ: "w",
  х: "x",
  с: "c",
  ԁ: "d",
  А: "A",
  В: "B",
  Е: "E",
  К: "K",
  М: "M",
  Н: "H",
  О: "O",
  Р: "P",
  С: "C",
  Т: "T",
  У: "Y",
  Х: "X",
  Ѕ: "S",
  І: "I",
  Ј: "J",
  Ԛ: "Q",
  Ԝ: "W",
  α: "a",
  β: "b",
  ε: "e",
  ι: "i",
  κ: "k",
  ν: "v",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "u",
  χ: "x",
  Α: "A",
  Β: "B",
  Ε: "E",
  Ζ: "Z",
  Η: "H",
  Ι: "I",
  Κ: "K",
  Μ: "M",
  Ν: "N",
  Ο: "O",
  Ρ: "P",
  Τ: "T",
  Υ: "Y",
  Χ: "X",
};

const LOOKALIKE = new RegExp(`[${Object.keys(LATIN_LOOKALIKES).join("")}]`, "g");

const signs = (points: ReadonlyArray<number>): RegExp =>
  new RegExp(`[${String.fromCodePoint(...points)}]`, "gu");

const COLON_LOOKALIKES = signs([
  0x2236, 0xa789, 0x02f8, 0x05c3, 0x205a, 0x1361, 0x0589, 0x0703, 0x0704, 0x1804, 0x16ec,
]);

const EQUALS_LOOKALIKES = signs([0xa78a, 0x1400, 0x2e40]);

const combiningDiacritic = (char: string): boolean => {
  const point = char.codePointAt(0) ?? 0;
  return point >= 0x300 && point <= 0x36f;
};

const unaccented = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(FOLDED, (letter) => FOLDS[letter] ?? letter);

const ENCLOSED_LETTER_BASES: ReadonlyArray<number> = [0x1f130, 0x1f150, 0x1f170, 0x1f1e6];

const enclosedLetter = (char: string): string => {
  const point = char.codePointAt(0) ?? 0;
  const base = ENCLOSED_LETTER_BASES.find((start) => point >= start && point < start + 26);
  return base === undefined ? char : String.fromCodePoint(0x41 + point - base);
};

const KEY_EMOJI = signs([0x1f511, 0x1f5dd, 0x1f510]);

/**
 * Text as the shape checks read it: accents dropped, compatibility forms (a fullwidth `：`, `…`)
 * folded, Greek and Cyrillic look-alikes as the Latin letters they pass for, signs drawn like `:`
 * or `=` as those, enclosed letters (`🅟`) as letters, a key emoji as `key`, and every space as a space, so no spelling of a credential word or separator
 * gets past the checks.
 */
export const folded = (text: string): string =>
  unaccented(text.normalize("NFKC"))
    .replace(/\p{So}/gu, enclosedLetter)
    .replace(KEY_EMOJI, " key ")
    .replace(LOOKALIKE, (letter) => LATIN_LOOKALIKES[letter] ?? letter)
    .replace(COLON_LOOKALIKES, ":")
    .replace(EQUALS_LOOKALIKES, "=")
    .replace(/\p{Zs}/gu, " ");

/**
 * The fold the checks read before `folded`: accents dropped from Latin-1 letters. They read both,
 * so allowing a character never makes a check miss what it caught.
 */
export const foldedAsBefore = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/./gsu, (char) => (combiningDiacritic(char) ? "" : char))
    .replace(/[ßæÆøØðÐþÞ]/g, (letter) => FOLDS[letter] ?? letter);

const OTHER_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Devanagari}\p{Script=Thai}]/u;

const GREEK_OR_CYRILLIC = /[\p{Script=Greek}\p{Script=Cyrillic}]/u;

const INVISIBLE =
  /^(?:\u034F|\u115F|\u1160|\u17B4|\u17B5|\u180B|\u180C|\u180D|\u180E|\u180F|\u2800|\u3164|\uFFA0|\u{1D159})$/u;

const MICRO_SIGN = "µ";

const emojiPresentation = (char: string): boolean => char === "\uFE0E" || char === "\uFE0F";

const KEYCAP = "⃣";

const plainLetter = (char: string): boolean =>
  !INVISIBLE.test(char) &&
  (/^[A-Za-z]+$/.test(unaccented(char)) ||
    char === MICRO_SIGN ||
    GREEK_OR_CYRILLIC.test(char) ||
    OTHER_SCRIPT.test(char));

const plainMark = (char: string): boolean =>
  !INVISIBLE.test(char) &&
  (combiningDiacritic(char) || GREEK_OR_CYRILLIC.test(char) || OTHER_SCRIPT.test(char));

const MOST_MARKS = 3;

const EMOJI_BASE = /^(?:\p{Extended_Pictographic}|[0-9#*])$/u;

const KEYCAP_BASE = /^[0-9#*]\uFE0F?$/u;

const UNIT_LETTERS = new Set(["\u00B5", "\u03BC", "\u03A9", "\u2126"]);

const mixesLatin = (word: string): boolean => {
  const letters = [...word].filter((char) => /\p{L}/u.test(char) && !UNIT_LETTERS.has(char));
  return (
    letters.some((char) => /\p{Script=Latin}/u.test(char)) &&
    letters.some((char) => !/\p{Script=Latin}/u.test(char))
  );
};

const FOREIGN_CREDENTIAL_WORDS = [
  "\u043F\u0430\u0440\u043E\u043B",
  "\u0441\u0435\u043A\u0440\u0435\u0442",
  "\u0442\u043E\u043A\u0435\u043D",
  "\u03C3\u03C5\u03BD\u03B8\u03B7\u03BC\u03B1\u03C4\u03B9\u03BA",
  "\u03BA\u03C9\u03B4\u03B9\u03BA\u03CC\u03C2 \u03C0\u03C1\u03CC\u03C3\u03B2\u03B1\u03C3\u03B7\u03C2",
  "\u5BC6\u7801",
  "\u5BC6\u78BC",
  "\u53E3\u4EE4",
  "\u5BC6\u94A5",
  "\u5BC6\u9470",
  "\u79D8\u94A5",
  "\u4EE4\u724C",
  "\u30D1\u30B9\u30EF\u30FC\u30C9",
  "\u6697\u8A3C\u756A\u53F7",
  "\u79D8\u5BC6\u9375",
  "\u30C8\u30FC\u30AF\u30F3",
  "\uBE44\uBC00\uBC88\uD638",
  "\uC554\uD638",
  "\uD1A0\uD070",
  "\u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631",
  "\u0643\u0644\u0645\u0629 \u0627\u0644\u0633\u0631",
  "\u05E1\u05D9\u05E1\u05DE",
  "\u092A\u093E\u0938\u0935\u0930\u094D\u0921",
  "\u0E23\u0E2B\u0E31\u0E2A\u0E1C\u0E48\u0E32\u0E19",
];

/**
 * Whether `text` names a credential in one of the scripts `plainCharacters` lets through, which
 * the English credential words don't cover: a password, secret, token or key in Russian, Greek,
 * Chinese, Japanese, Korean, Arabic, Hebrew, Hindi or Thai.
 */
export const foreignCredentialWord = (text: string): boolean => {
  const lower = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\p{Zs}+/gu, " ");
  return FOREIGN_CREDENTIAL_WORDS.some((word) => lower.includes(word));
};

/**
 * Whether `text` holds only characters a reader sees as what they are. Ordinary typography
 * passes: punctuation, symbols and emoji, numbers, spaces, accented Latin letters, and Greek,
 * Cyrillic, CJK, Arabic, Hebrew, Devanagari and Thai letters. Held back: control and format
 * characters (zero-width, bidi overrides, tags), private-use and unassigned code points, letters
 * that render as nothing, runs of variation selectors and stacked marks, fullwidth and
 * mathematical letters, small capitals, IPA and other look-alike scripts (Cherokee, Armenian,
 * Lisu), and a word that mixes Latin letters with Greek or Cyrillic look-alikes.
 */
export const plainCharacters = (text: string): boolean => {
  let beforePrevious = "";
  let previous = "";
  let marks = 0;
  for (const char of text) {
    if (/[\t\n\r\x20-\x7E]/.test(char)) {
      marks = 0;
    } else if (/\p{L}/u.test(char)) {
      if (!plainLetter(char)) return false;
      marks = 0;
    } else if (emojiPresentation(char)) {
      if (!EMOJI_BASE.test(previous)) return false;
    } else if (char === KEYCAP) {
      if (!KEYCAP_BASE.test(beforePrevious + previous)) return false;
    } else if (/\p{M}/u.test(char)) {
      if (!/[\p{L}\p{M}]/u.test(previous) || !plainMark(char)) return false;
      if (++marks > MOST_MARKS) return false;
    } else if (!/[\p{P}\p{S}\p{N}\p{Zs}]/u.test(char) || INVISIBLE.test(char)) {
      return false;
    } else {
      marks = 0;
    }
    beforePrevious = previous;
    previous = char;
  }
  return [...text.matchAll(/[\p{L}\p{M}]+/gu)].every(([word]) => !mixesLatin(word));
};
