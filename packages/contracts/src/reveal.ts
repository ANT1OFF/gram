const HIDDEN =
  /(?![\n\t])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}\p{Variation_Selector}ᅟᅠㅤﾠ]/gu;

const markerOf = (char: string): string =>
  `⟨U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}⟩`;

/** Whether `text` holds a character that hides or reorders what it reads as. */
export const hidesText = (text: string): boolean => {
  HIDDEN.lastIndex = 0;
  return HIDDEN.test(text);
};

/** `text` with each hiding character shown as its marker, such as `⟨U+202E⟩`. */
export const revealHidden = (text: string): string => text.replace(HIDDEN, markerOf);

/** Whether any string anywhere in `value` (an approval's input, at any depth) hides text. */
export const valueHidesText = (value: unknown): boolean => {
  if (typeof value === "string") return hidesText(value);
  if (Array.isArray(value)) return value.some(valueHidesText);
  if (value !== null && typeof value === "object")
    return Object.entries(value).some(([key, item]) => hidesText(key) || valueHidesText(item));
  return false;
};

/** `value` with every string in it, keys included, passed through `revealHidden`. */
export const revealValue = (value: unknown): unknown => {
  if (typeof value === "string") return revealHidden(value);
  if (Array.isArray(value)) return value.map(revealValue);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [revealHidden(key), revealValue(item)]),
    );
  return value;
};

/** The warning an approval shows above text that held hiding characters. */
export const HIDDEN_TEXT_WARNING =
  "This request contains hidden or reordering characters, shown as ⟨U+…⟩. Read it before you allow it.";
