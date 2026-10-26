import { describe, expect, it } from "vitest";

import { svgDataUrl, themedSvg } from "./widget-svg";

describe("themedSvg", () => {
  it("declares the theme first inside the root, so the drawing's own styles still win", () => {
    const svg =
      '<?xml version="1.0"?>\n<svg viewBox="0 0 10 10"><style>text{fill:red}</style></svg>';
    expect(
      themedSvg(svg, { "--fg": "oklch(0.9 0 0)", "--font": '"Geist Variable", sans-serif' }),
    ).toBe(
      '<?xml version="1.0"?>\n<svg viewBox="0 0 10 10">' +
        '<style>:root{--fg:oklch(0.9 0 0);--font:"Geist Variable", sans-serif}</style>' +
        "<style>text{fill:red}</style></svg>",
    );
  });

  it("finds the end of the root tag past a `>` inside a quoted attribute", () => {
    expect(
      themedSvg(`<svg aria-label="latency > target" data-x='a>b'><rect/></svg>`, {
        "--fg": "#fff",
      }),
    ).toBe(
      `<svg aria-label="latency > target" data-x='a>b'><style>:root{--fg:#fff}</style><rect/></svg>`,
    );
    expect(themedSvg('<svg aria-label="never closed', { "--fg": "#fff" })).toBe(
      '<svg aria-label="never closed',
    );
  });

  it("themes the root element, not an `<svg` that a leading comment mentions", () => {
    expect(
      themedSvg('<?xml version="1.0"?><!-- source: <svg> --><svg><rect/></svg>', {
        "--fg": "#fff",
      }),
    ).toBe(
      '<?xml version="1.0"?><!-- source: <svg> --><svg><style>:root{--fg:#fff}</style><rect/></svg>',
    );
  });

  it("drops a value that could break out of the style element", () => {
    expect(themedSvg("<svg><g/></svg>", { "--fg": "red}</style><script>", "--bg": "#000" })).toBe(
      "<svg><style>:root{--bg:#000}</style><g/></svg>",
    );
  });

  it("leaves a self-closing root, a themeless page and non-SVG text as they are", () => {
    expect(themedSvg('<svg viewBox="0 0 1 1"/>', { "--fg": "#fff" })).toBe(
      '<svg viewBox="0 0 1 1"/>',
    );
    expect(themedSvg("<svg></svg>", {})).toBe("<svg></svg>");
    expect(themedSvg("hello", { "--fg": "#fff" })).toBe("hello");
  });
});

describe("svgDataUrl", () => {
  it("encodes the document so quotes, hashes and non-ASCII survive", () => {
    const url = svgDataUrl('<svg fill="#fff">é</svg>');
    expect(url.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(url.slice(url.indexOf(",") + 1))).toBe('<svg fill="#fff">é</svg>');
    expect(url).not.toContain("#");
  });
});
