import { describe, expect, it } from "vitest";
import { offSiteAddress, onListedSite, siteOf } from "./browser-scope.ts";

describe("browser scope", () => {
  it("reads the host an address is on", () => {
    expect(siteOf("https://GitHub.com/a/b?c")).toBe("github.com");
    expect(siteOf("github.com/pulls")).toBe("github.com");
    expect(siteOf("http://localhost:3000/")).toBe("localhost:3000");
    expect(siteOf("")).toBeUndefined();
  });

  it("matches a listed host exactly", () => {
    expect(onListedSite("https://github.com/x", ["github.com"])).toBe(true);
    expect(onListedSite("https://gist.github.com/x", ["github.com"])).toBe(false);
    expect(onListedSite("https://github.com.evil.example/x", ["github.com"])).toBe(false);
    expect(onListedSite("https://user@evil.example/github.com", ["github.com"])).toBe(false);
  });

  it("names the address a call opens outside the list", () => {
    const sites = ["github.com"];
    expect(offSiteAddress({ url: "https://example.com", tabId: 1 }, sites)).toBe(
      "https://example.com",
    );
    expect(offSiteAddress({ url: "https://github.com/pulls" }, sites)).toBeUndefined();
    expect(offSiteAddress({ url: "back" }, sites)).toBeUndefined();
    expect(offSiteAddress({ coordinate: [1, 2] }, sites)).toBeUndefined();
    expect(offSiteAddress({ url: "javascript:alert(1)" }, sites)).toBe("javascript:alert(1)");
  });
});
