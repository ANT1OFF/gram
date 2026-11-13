import { describe, expect, it } from "vitest";

import { previewNavigation, previewRequest } from "./preview-rules.ts";
import {
  isPageKey,
  pageListenerOrigin,
  pageNavigation,
  pagePrefixOf,
  pageRequest,
} from "./page-rules.ts";

const ORIGIN = "http://127.0.0.1:4100";
const PREFIX = `${ORIGIN}/gram-pages/AbCdEfGhIjKlMnOpQrStUvWx/`;
const OTHER = `${ORIGIN}/gram-pages/ZyXwVuTsRqPoNmLkJiHgFeDc/`;

describe("pinned pages' session", () => {
  it("takes the listener's origin only as the server spells it", () => {
    expect(pageListenerOrigin(ORIGIN)).toBe(ORIGIN);
    for (const raw of [
      `${ORIGIN}/`,
      "http://localhost:4100",
      "https://127.0.0.1:4100",
      "http://127.0.0.1:0",
      "http://127.0.0.1:70000",
      "http://10.0.0.1:4100",
      4100,
      undefined,
    ]) {
      expect(pageListenerOrigin(raw), String(raw)).toBeUndefined();
    }
  });

  it("opens a page only on the announced origin", () => {
    expect(pagePrefixOf(ORIGIN, `${PREFIX}index.html`)).toBe(PREFIX);
    expect(pagePrefixOf(undefined, `${PREFIX}index.html`)).toBeUndefined();
    expect(pagePrefixOf("http://127.0.0.1:4101", `${PREFIX}index.html`)).toBeUndefined();
    expect(isPageKey("release-radar-3f9a2c")).toBe(true);
    for (const key of ["", "../x", "A", "a/b", 1]) expect(isPageKey(key)).toBe(false);
  });

  it("lets a page load its own files and data, and nothing else", () => {
    const get = (url: string) => pageRequest(PREFIX, { url, method: "GET" });
    expect(get(`${PREFIX}index.html`)).toBe("allow");
    expect(get(`${PREFIX}assets/app.js`)).toBe("allow");
    expect(get("data:text/plain,x")).toBe("allow");
    expect(get("blob:null/1234")).toBe("allow");
    for (const url of [
      `${OTHER}secret.js`,
      `${PREFIX}../ZyXwVuTsRqPoNmLkJiHgFeDc/secret.js`,
      `${PREFIX}%2e%2e/ZyXwVuTsRqPoNmLkJiHgFeDc/secret.js`,
      `${PREFIX}x.js?leak=1`,
      PREFIX,
      `${ORIGIN}/api/threads`,
      "http://127.0.0.1:4101/gram-pages/AbCdEfGhIjKlMnOpQrStUvWx/x",
      "ws://127.0.0.1:4100/gram-pages/AbCdEfGhIjKlMnOpQrStUvWx/x",
      "https://example.com/",
      "file:///etc/hosts",
    ]) {
      expect(get(url), url).toBe("block");
    }
    expect(pageRequest(PREFIX, { url: `${PREFIX}x`, method: "POST" })).toBe("block");
    expect(pageRequest(undefined, { url: `${PREFIX}x`, method: "GET" })).toBe("block");
  });

  it("navigates a page within its own files only", () => {
    expect(pageNavigation(PREFIX, `${PREFIX}second.html#board`)).toBe("load");
    for (const url of [
      `${OTHER}index.html`,
      "https://example.com/",
      "about:blank",
      "javascript:1",
    ]) {
      expect(pageNavigation(PREFIX, url), url).toBe("block");
    }
  });

  it("never loads a pinned page in the Preview tab's local session", () => {
    expect(previewNavigation(`${PREFIX}index.html`)).toBe("refuse");
    expect(previewRequest(`${PREFIX}index.html`)).toBe("block");
    expect(previewRequest("http://localhost:4100/%67ram-pages/x/y")).toBe("block");
    // A loopback page elsewhere still loads.
    expect(previewRequest("http://127.0.0.1:3000/")).toBe("allow");
  });
});
