import { describe, expect, it } from "vitest";
import { isExternalUrl, localPortUrl } from "./ports.ts";

describe("ports", () => {
  it("allows only http(s) URLs out", () => {
    expect(isExternalUrl(localPortUrl(3000))).toBe(true);
    expect(isExternalUrl("https://example.test/a")).toBe(true);
    expect(isExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isExternalUrl("not a url")).toBe(false);
  });
});
