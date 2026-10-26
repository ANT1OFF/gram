/**
 * The theme values a widget may use, by the name it uses them under. An SVG inside `<img>` is its
 * own document and inherits nothing from the page, so the values are resolved here and written into
 * it; that isolation is also why the markup needs no sanitising.
 */
const WIDGET_TOKENS = {
  "--fg": "--fg",
  "--fg-muted": "--fg-muted",
  "--bg": "--surface-2",
  "--surface": "--surface-3",
  "--border": "--border-subtle",
  "--accent": "--accent",
  "--success": "--success-text",
  "--warning": "--warning-text",
  "--danger": "--danger-text",
  "--info": "--info-text",
  "--font": "--font-ui",
} as const;

export type WidgetTheme = Readonly<Record<keyof typeof WIDGET_TOKENS, string>>;

/** The page's current values for `WIDGET_TOKENS`; a token the theme leaves unset is dropped. */
export const readWidgetTheme = (root: Element): Partial<WidgetTheme> => {
  const style = getComputedStyle(root);
  const theme: Partial<Record<keyof typeof WIDGET_TOKENS, string>> = {};
  for (const [name, source] of Object.entries(WIDGET_TOKENS)) {
    const value = style.getPropertyValue(source).trim();
    if (value !== "") theme[name as keyof typeof WIDGET_TOKENS] = value;
  }
  return theme;
};

/**
 * Where the tag opening at `from` ends (exclusive), or -1. Quote-aware, because an attribute value
 * may hold a `>`: cutting at the one in `aria-label="latency > target"` would put the style inside
 * the attribute and leave `<img>` with malformed XML and nothing to draw.
 */
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

/**
 * Where the root element starts: past the XML declaration, comments and a doctype. Searching the
 * text for `<svg` instead would find the one in `<!-- source: <svg> -->` and theme the comment.
 */
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
  // A self-closing root has nowhere to put a style, and nothing to colour either.
  if (at === -1 || svg[at - 2] === "/") return svg;
  return `${svg.slice(0, at)}<style>:root{${declarations}}</style>${svg.slice(at)}`;
};

/** An SVG document as an `<img>` source. */
export const svgDataUrl = (svg: string): string =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
