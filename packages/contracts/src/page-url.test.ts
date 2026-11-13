import { describe, expect, it } from "vitest";

import {
  isPinnedPageUrl,
  pagePolicyHeaders,
  pagesOriginFromMessage,
  pinnedPageOn,
} from "./page-url.ts";

const ORIGIN = "http://127.0.0.1:4100";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWx";

describe("pinned page URLs", () => {
  it("names every loopback URL under the segment, whatever its port, case or escapes", () => {
    for (const url of [
      `${ORIGIN}/gram-pages/${TOKEN}/index.html`,
      `http://localhost:9/gram-pages/x/y`,
      `http://[::1]:9/GRAM-PAGES/x`,
      `http://127.0.0.1:9/%67ram-pages/x`,
      `http://127.0.0.1:9/%E0%A4%A/x`,
    ]) {
      expect(isPinnedPageUrl(url), url).toBe(true);
    }
    for (const url of [
      `${ORIGIN}/gram-preview-files/${TOKEN}/index.html`,
      `https://example.com/gram-pages/x`,
      `${ORIGIN}/x/gram-pages/y`,
      "not a url",
    ]) {
      expect(isPinnedPageUrl(url), url).toBe(false);
    }
  });

  it("takes a page apart only on the listener's exact origin, with a token and a file", () => {
    expect(pinnedPageOn(ORIGIN, `${ORIGIN}/gram-pages/${TOKEN}/index.html#board`)).toEqual({
      token: TOKEN,
      prefix: `${ORIGIN}/gram-pages/${TOKEN}/`,
    });
    for (const url of [
      `http://127.0.0.1:4101/gram-pages/${TOKEN}/index.html`,
      `http://localhost:4100/gram-pages/${TOKEN}/index.html`,
      `https://127.0.0.1:4100/gram-pages/${TOKEN}/index.html`,
      `${ORIGIN}/gram-pages/${TOKEN}/index.html?x=1`,
      `http://user@127.0.0.1:4100/gram-pages/${TOKEN}/index.html`,
      `${ORIGIN}/gram-pages/short/index.html`,
      `${ORIGIN}/gram-pages/${TOKEN}/`,
      `${ORIGIN}/gram-pages/${TOKEN}/.env`,
      `${ORIGIN}/%67ram-pages/${TOKEN}/index.html`,
      `${ORIGIN}/gram-preview-files/${TOKEN}/index.html`,
    ]) {
      expect(pinnedPageOn(ORIGIN, url), url).toBeUndefined();
    }
  });

  it("reads the server's origin message and nothing else", () => {
    expect(pagesOriginFromMessage({ type: "pages.origin", origin: ORIGIN })).toBe(ORIGIN);
    expect(pagesOriginFromMessage({ type: "boot", origin: ORIGIN })).toBeUndefined();
    expect(pagesOriginFromMessage(null)).toBeUndefined();
  });

  it("holds a page to a sandbox with scripts, its own listener and no connection", () => {
    const csp = pagePolicyHeaders(ORIGIN)["content-security-policy"]!.split("; ");
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp.find((d) => d.startsWith("script-src"))).toBe(
      `script-src ${ORIGIN} 'unsafe-inline' 'unsafe-eval' data: blob:`,
    );
    // No directive names a source but the listener, data: and blob:.
    for (const directive of csp) {
      for (const source of directive.split(" ").slice(1)) {
        expect([
          ORIGIN,
          "'none'",
          "'unsafe-inline'",
          "'unsafe-eval'",
          "data:",
          "blob:",
          "allow-scripts",
        ]).toContain(source);
      }
    }
  });
});
