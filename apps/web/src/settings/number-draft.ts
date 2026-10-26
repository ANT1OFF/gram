/**
 * The number a typed draft means, or `undefined` when it isn't one the field accepts: not a finite
 * number, below `min`, or fractional where whole numbers are wanted.
 */
export const parseNumberDraft = (
  draft: string,
  { min, integer }: { readonly min: number; readonly integer: boolean },
): number | undefined => {
  const text = draft.trim();
  if (text === "") return undefined;
  const value = Number(text);
  if (!Number.isFinite(value)) return undefined;
  if (integer && !Number.isInteger(value)) return undefined;
  if (value < min) return undefined;
  return value;
};
