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

const HAS_LOOKALIKE = new RegExp(LOOKALIKE.source);

const COLON_LOOKALIKES = /[∶꞉˸׃⁚፡]/g;

const EQUALS_LOOKALIKES = /[꞊᐀⹀]/g;

const combiningDiacritic = (char: string): boolean => {
  const point = char.codePointAt(0) ?? 0;
  return point >= 0x300 && point <= 0x36f;
};

const unaccented = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(FOLDED, (letter) => FOLDS[letter] ?? letter);

/**
 * Text as the shape checks read it: accents dropped, compatibility forms (a fullwidth `：`, `…`)
 * folded, Greek and Cyrillic look-alikes as the Latin letters they pass for, signs drawn like `:`
 * or `=` as those, and every space as a space, so no spelling of a credential word or separator
 * gets past the checks.
 */
export const folded = (text: string): string =>
  unaccented(text.normalize("NFKC"))
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
  /^(?:\u034F|\u115F|\u1160|\u17B4|\u17B5|\u180B|\u180C|\u180D|\u180E|\u180F|\u2800|\u3164|\uFFA0)$/u;

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
  let previous = "";
  let marks = 0;
  for (const char of text) {
    if (/[\t\n\r\x20-\x7E]/.test(char)) {
      marks = 0;
    } else if (/\p{L}/u.test(char)) {
      if (!plainLetter(char)) return false;
      marks = 0;
    } else if (emojiPresentation(char)) {
      if (previous === "" || /[\s\p{M}\p{L}]/u.test(previous)) return false;
    } else if (char === KEYCAP) {
      if (!emojiPresentation(previous)) return false;
    } else if (/\p{M}/u.test(char)) {
      if (!/[\p{L}\p{M}]/u.test(previous) || !plainMark(char)) return false;
      if (++marks > MOST_MARKS) return false;
    } else if (!/[\p{P}\p{S}\p{N}\p{Zs}]/u.test(char) || INVISIBLE.test(char)) {
      return false;
    } else {
      marks = 0;
    }
    previous = char;
  }
  for (const [word] of text.matchAll(/[\p{L}\p{M}]+/gu)) {
    if (/[A-Za-z]/.test(unaccented(word)) && HAS_LOOKALIKE.test(word)) return false;
  }
  return true;
};
