import { describe, expect, it } from "vitest";
import {
  HOSTED_LOGO_MOST,
  hostedLogoFromData,
  hostedLogoOf,
  isHostedLogo,
  sniffHostedLogo,
} from "./hosted-logo.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const SVG = '<?xml version="1.0"?>\n<!-- mark -->\n<svg xmlns="http://www.w3.org/2000/svg"></svg>';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

describe("a hosted server's mark", () => {
  it("is an image by its own bytes, never by its label", () => {
    expect(sniffHostedLogo(bytes(SVG))).toBe("image/svg+xml");
    expect(sniffHostedLogo(PNG)).toBe("image/png");
    expect(sniffHostedLogo(bytes("<html><svg></svg></html>"))).toBeUndefined();
    expect(sniffHostedLogo(bytes("<svgx>"))).toBeUndefined();
    expect(hostedLogoOf(PNG, "image/png")).toMatch(/^data:image\/png;base64,/);
    expect(hostedLogoOf(PNG, "image/svg+xml")).toBeUndefined();
    expect(hostedLogoOf(bytes(SVG), "text/html")).toBeUndefined();
    expect(hostedLogoOf(bytes(SVG), "image/svg+xml; charset=utf-8")).toMatch(/^data:image\/svg/);
  });

  it("is kept no larger than a small mark", () => {
    const big = bytes(`<svg>${" ".repeat(HOSTED_LOGO_MOST)}</svg>`);
    expect(hostedLogoOf(big, "image/svg+xml")).toBeUndefined();
  });

  it("reads a data: image base64 or percent-encoded, and keeps it base64", () => {
    const encoded = `data:image/svg+xml,${encodeURIComponent(SVG)}`;
    const kept = hostedLogoFromData(encoded);
    expect(kept).toBe(`data:image/svg+xml;base64,${btoa(SVG)}`);
    expect(hostedLogoFromData(kept ?? "")).toBe(kept);
    expect(isHostedLogo(kept)).toBe(true);
    expect(isHostedLogo(encoded)).toBe(false);
    expect(hostedLogoFromData("data:image/svg+xml;base64,not base64!")).toBeUndefined();
    expect(hostedLogoFromData("https://gram.example.com/favicon.svg")).toBeUndefined();
  });
});
