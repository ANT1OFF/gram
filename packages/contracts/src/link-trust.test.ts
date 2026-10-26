import { describe, expect, it } from "vitest";
import { isTrustableHost, isTrustedLink, linkHost, trustedHostsOf } from "./link-trust.ts";

const TRUSTED = ["docs.example.com"];

describe("isTrustedLink", () => {
  it("opens an https link to a trusted host", () => {
    expect(isTrustedLink("https://docs.example.com/wiki/spaces/AI", TRUSTED)).toBe(true);
    expect(isTrustedLink("https://docs.example.com", TRUSTED)).toBe(true);
  });

  it("matches the exact host, never a sibling, a parent or a suffix", () => {
    expect(isTrustedLink("https://evil.example.com/", TRUSTED)).toBe(false);
    expect(isTrustedLink("https://example.com/", TRUSTED)).toBe(false);
    expect(isTrustedLink("https://docs.example.com.evil.com/", TRUSTED)).toBe(false);
    expect(isTrustedLink("https://evildocs.example.com/", TRUSTED)).toBe(false);
    expect(isTrustedLink("https://www.docs.example.com/", TRUSTED)).toBe(false);
    expect(isTrustedLink("https://docs.example.com./", TRUSTED)).toBe(false);
  });

  it("asks for a link whose user name only looks like the trusted host", () => {
    expect(isTrustedLink("https://docs.example.com@evil.com/", TRUSTED)).toBe(false);
    expect(isTrustedLink("https://docs.example.com:pw@evil.com/", TRUSTED)).toBe(false);
  });

  it("asks for userinfo, a non-default port or http, even on a trusted host", () => {
    expect(isTrustedLink("https://me@docs.example.com/", TRUSTED)).toBe(false);
    expect(isTrustedLink("https://docs.example.com:8443/", TRUSTED)).toBe(false);
    expect(isTrustedLink("http://docs.example.com/", TRUSTED)).toBe(false);
    // 443 is https's own port, which the parser drops.
    expect(isTrustedLink("https://docs.example.com:443/", TRUSTED)).toBe(true);
  });

  it("never opens another scheme", () => {
    for (const url of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "ftp://docs.example.com/",
      "mailto:a@docs.example.com",
      "data:text/html,hi",
      "docs.example.com/wiki",
    ]) {
      expect(isTrustedLink(url, TRUSTED), url).toBe(false);
    }
  });

  it("matches an uppercase link on its lowercased host", () => {
    expect(isTrustedLink("HTTPS://DOCS.Example.COM/Wiki", TRUSTED)).toBe(true);
  });

  it("compares an IDN in punycode, so a look-alike is a different host", () => {
    // A Cyrillic "а" in place of the Latin one.
    expect(isTrustedLink("https://dоcs.example.com/", TRUSTED)).toBe(false);
    expect(isTrustedLink("https://bücher.example/", ["xn--bcher-kva.example"])).toBe(true);
  });
});

describe("linkHost", () => {
  it("shows the host a link goes to, and why it can't be trusted", () => {
    expect(linkHost("https://docs.example.com/wiki")).toEqual({
      host: "docs.example.com",
    });
    expect(linkHost("https://docs.example.com@evil.com/")).toEqual({
      host: "evil.com",
      untrustable: "userinfo",
    });
    expect(linkHost("https://organization.example.invalid:8443/")?.untrustable).toBe("port");
    expect(linkHost("http://organization.example.invalid/")?.untrustable).toBe("http");
    expect(linkHost("mailto:a@organization.example.invalid")).toBeNull();
    expect(linkHost("not a url")).toBeNull();
  });

  it("gives the written form beside the punycode only when they differ past case", () => {
    expect(linkHost("https://DOCS.example.com/")).toEqual({ host: "docs.example.com" });
    expect(linkHost("https://dоcs.example.com/")).toEqual({
      host: "xn--dcs-sed.example.com",
      written: "dоcs.example.com",
    });
    expect(linkHost("https://%65vil.com/")).toEqual({ host: "evil.com", written: "%65vil.com" });
    // No authority slashes after the scheme: a `//` later in the path isn't one.
    expect(linkHost("https:foo//bar")).toEqual({ host: "foo" });
    expect(linkHost("https:\\\\evil.com/")).toEqual({ host: "evil.com" });
  });
});

describe("stored hosts", () => {
  it("keeps only exact hosts a link can be trusted by", () => {
    expect(isTrustableHost("docs.example.com")).toBe(true);
    expect(isTrustableHost("xn--bcher-kva.example")).toBe(true);
    for (const host of [
      "*.organization.example.invalid",
      "ORGANIZATION.example.invalid",
      "bücher.example",
      "organization.example.invalid:8443",
      "me@organization.example.invalid",
      "organization.example.invalid/path",
      "",
      42,
    ]) {
      expect(isTrustableHost(host), String(host)).toBe(false);
    }
  });

  it("cleans a stored list to unique, sorted, trustable hosts", () => {
    expect(trustedHostsOf(["b.example", "a.example", "b.example", "*.x", 1])).toEqual([
      "a.example",
      "b.example",
    ]);
    expect(trustedHostsOf("a.example")).toEqual([]);
  });
});
