// Shared `Intl` formatters. Building one costs about 50 µs, and formatting with a built one about
// 1 µs, so a list that builds one per row (a Usage table, a sidebar's clock times) spends nearly
// all of its render building them. The options a caller passes are a handful of literals, so the
// caches stay as small as the set of distinct calls.

type Locales = string | readonly string[] | undefined;

const dateFormats = new Map<string, Intl.DateTimeFormat>();
const numberFormats = new Map<string, Intl.NumberFormat>();

const keyOf = (locales: Locales, options: object) =>
  `${JSON.stringify(locales ?? null)}|${JSON.stringify(options)}`;

/** `new Intl.DateTimeFormat(locales, options)`, built once per distinct pair. */
export function dateTimeFormat(
  locales: Locales,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = keyOf(locales, options);
  let format = dateFormats.get(key);
  if (format === undefined) {
    format = new Intl.DateTimeFormat(locales as string | string[] | undefined, options);
    dateFormats.set(key, format);
  }
  return format;
}

/** `new Intl.NumberFormat(locales, options)`, built once per distinct pair. */
export function numberFormat(
  locales: Locales,
  options: Intl.NumberFormatOptions = {},
): Intl.NumberFormat {
  const key = keyOf(locales, options);
  let format = numberFormats.get(key);
  if (format === undefined) {
    format = new Intl.NumberFormat(locales as string | string[] | undefined, options);
    numberFormats.set(key, format);
  }
  return format;
}
