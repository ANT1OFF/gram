import { afterEach, describe, expect, it } from "vitest";

import { appBasePath, basePathOf, setAppBasePath, withoutBasePath } from "./app-path";

afterEach(() => setAppBasePath(undefined));

describe("the app's base path", () => {
  it("is nothing on its own", () => {
    expect(appBasePath()).toBe("");
    expect(withoutBasePath("/t/abc")).toBe("/t/abc");
  });

  it("is taken off a path under it, and only there", () => {
    setAppBasePath("/w/acme/");
    expect(appBasePath()).toBe("/w/acme");
    expect(withoutBasePath("/w/acme/t/abc")).toBe("/t/abc");
    expect(withoutBasePath("/w/acme")).toBe("/");
    expect(withoutBasePath("/w/acme-two/t/abc")).toBe("/w/acme-two/t/abc");
  });

  it("refuses what isn't a path on this origin", () => {
    expect(() => basePathOf("w/acme")).toThrow(/base path/);
    expect(() => basePathOf("//other.example/w")).toThrow(/base path/);
    expect(() => basePathOf("/w?x=1")).toThrow(/base path/);
  });
});
