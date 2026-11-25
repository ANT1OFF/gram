/** `value` when it is one of `options`, else undefined: for what a control or storage gave back. */
export const oneOf = <const T>(options: readonly T[], value: unknown): T | undefined =>
  options.find((option) => option === value);
