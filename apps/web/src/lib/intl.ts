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
    format = new Intl.DateTimeFormat(locales, options);
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
    format = new Intl.NumberFormat(locales, options);
    numberFormats.set(key, format);
  }
  return format;
}
