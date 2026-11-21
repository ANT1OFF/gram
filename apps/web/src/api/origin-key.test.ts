import { describe, expect, it } from "vitest";
import { originKey, originKeyProtocols, takeOriginKey, withOriginKey } from "./origin-key";

const KEY = "ab".repeat(32);

const memory = () => {
  const items = new Map<string, string>();
  return {
    getItem: (name: string) => items.get(name) ?? null,
    setItem: (name: string, value: string) => void items.set(name, value),
  };
};

const at = (hash: string) => {
  const replaced: Array<string> = [];
  return {
    location: { hash, pathname: "/settings", search: "?tab=1" },
    history: {
      state: null,
      replaceState: (_: unknown, __: string, url: string) => replaced.push(url),
    },
    replaced,
  };
};

describe("the origin key", () => {
  it("is kept from the boot redirect's fragment, which then leaves the address", () => {
    const storage = memory();
    const page = at(`#gram-key=${KEY}`);
    takeOriginKey(page.location, page.history, storage);
    expect(originKey(storage)).toBe(KEY);
    expect(page.replaced).toEqual(["/settings?tab=1"]);
  });

  it("is not taken from a fragment that isn't one, which stays where it is", () => {
    const storage = memory();
    for (const hash of ["#questions", "#gram-key=short", ""]) {
      const page = at(hash);
      takeOriginKey(page.location, page.history, storage);
      if (hash !== "#gram-key=short") expect(page.replaced).toEqual([]);
    }
    expect(originKey(storage)).toBeUndefined();
  });

  it("goes on every request as a header and on the socket as a subprotocol", () => {
    const init = withOriginKey(
      { method: "POST", headers: { "content-type": "application/json" } },
      KEY,
    );
    const headers = new Headers(init.headers);
    expect(headers.get("x-gram-key")).toBe(KEY);
    expect(headers.get("content-type")).toBe("application/json");
    expect(init.method).toBe("POST");
    expect(originKeyProtocols(KEY)).toEqual([`gram-key.${KEY}`]);
    expect(withOriginKey({ method: "GET" }, undefined)).toEqual({ method: "GET" });
    expect(originKeyProtocols(undefined)).toBeUndefined();
  });
});
