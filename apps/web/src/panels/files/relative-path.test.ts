import { describe, expect, it } from "vitest";

import { isImagePath, isMarkdownPath, resolveInCheckout } from "./relative-path";

const ROOT = "/repo";
const FILE = "/repo/docs/guide/README.md";

describe("resolveInCheckout", () => {
  it("resolves relative and root-relative paths inside the checkout", () => {
    expect(resolveInCheckout("setup.md", FILE, ROOT)).toBe("/repo/docs/guide/setup.md");
    expect(resolveInCheckout("./img/logo.png", FILE, ROOT)).toBe("/repo/docs/guide/img/logo.png");
    expect(resolveInCheckout("../../src/retry.ts#L4", FILE, ROOT)).toBe("/repo/src/retry.ts");
    expect(resolveInCheckout("/package.json?raw", FILE, ROOT)).toBe("/repo/package.json");
    expect(resolveInCheckout("my%20notes.md", FILE, ROOT)).toBe("/repo/docs/guide/my notes.md");
  });

  it("rejects external links, anchors and escapes", () => {
    for (const href of [
      "https://organization.example.invalid",
      "mailto:a@b.c",
      "data:image/png;base64,AAAA",
      "javascript:alert(1)",
      "//organization.example.invalid/x.png",
      "#install",
      "",
      "../../../../etc/passwd",
      "%E0%A4%A",
    ]) {
      expect(resolveInCheckout(href, FILE, ROOT), href).toBeUndefined();
    }
  });

  it("does not treat a sibling prefix as inside", () => {
    expect(resolveInCheckout("../../../repo-other/x.md", FILE, ROOT)).toBeUndefined();
  });
});

describe("file kinds", () => {
  it("recognises previewable images and markdown", () => {
    expect(["a.png", "b.JPG", "c.jpeg", "d.gif", "e.svg", "f.webp"].every(isImagePath)).toBe(true);
    expect(isImagePath("g.bmp")).toBe(false);
    expect(isMarkdownPath("README.md")).toBe(true);
    expect(isMarkdownPath("notes.txt")).toBe(false);
  });
});
