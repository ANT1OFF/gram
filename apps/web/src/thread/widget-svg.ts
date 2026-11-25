const WIDGET_TOKENS = [
  ["--fg", "--fg"],
  ["--fg-muted", "--fg-muted"],
  ["--bg", "--surface-2"],
  ["--surface", "--surface-3"],
  ["--border", "--border-subtle"],
  ["--accent", "--accent"],
  ["--success", "--success-text"],
  ["--warning", "--warning-text"],
  ["--danger", "--danger-text"],
  ["--info", "--info-text"],
  ["--font", "--font-ui"],
] as const;

type WidgetToken = (typeof WIDGET_TOKENS)[number][0];

export type WidgetTheme = Readonly<Record<WidgetToken, string>>;

/** The page's current values for `WIDGET_TOKENS`; a token the theme leaves unset is dropped. */
export const readWidgetTheme = (root: Element): Partial<WidgetTheme> => {
  const style = getComputedStyle(root);
  const theme: Partial<Record<WidgetToken, string>> = {};
  for (const [name, source] of WIDGET_TOKENS) {
    const value = style.getPropertyValue(source).trim();
    if (value !== "") theme[name] = value;
  }
  return theme;
};

const tagEnd = (text: string, from: number): number => {
  let quote: string | undefined;
  for (let i = from; i < text.length; i++) {
    const char = text[i]!;
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return i + 1;
    }
  }
  return -1;
};

const rootStart = (svg: string): number => {
  let i = 0;
  for (;;) {
    while (i < svg.length && /\s/.test(svg[i]!)) i++;
    const close = svg.startsWith("<?", i)
      ? "?>"
      : svg.startsWith("<!--", i)
        ? "-->"
        : /^<!doctype/i.test(svg.slice(i, i + 9))
          ? ">"
          : undefined;
    const end = close === undefined ? -1 : svg.indexOf(close, i);
    if (close === undefined || end === -1) return i;
    i = end + close.length;
  }
};

/**
 * `svg` with the theme declared on its root, as the first thing inside it so the drawing's own
 * styles still win. A value is dropped if it could close the style element it is written into.
 */
export const themedSvg = (svg: string, theme: Partial<WidgetTheme>): string => {
  const declarations = Object.entries(theme)
    .filter(([, value]) => !/[<>{}]/.test(value))
    .map(([name, value]) => `${name}:${value}`)
    .join(";");
  if (declarations === "") return svg;
  const start = rootStart(svg);
  if (!/^<svg[\s>/]/i.test(svg.slice(start, start + 5))) return svg;
  const at = tagEnd(svg, start);
  if (at === -1 || svg[at - 2] === "/") return svg;
  return `${svg.slice(0, at)}<style>:root{${declarations}}</style>${svg.slice(at)}`;
};

/** An SVG document as an `<img>` source. */
export const svgDataUrl = (svg: string): string =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
