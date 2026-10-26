import { describe, expect, it } from "vitest";

import { parsePrRef } from "./pr-ref";

describe("parsePrRef", () => {
  it("reads a bare number, with or without #", () => {
    expect(parsePrRef("12")).toEqual({ number: 12 });
    expect(parsePrRef(" #412 ")).toEqual({ number: 412 });
  });

  it("reads owner/repo#N", () => {
    expect(parsePrRef("example/api#12")).toEqual({ repo: "example/api", number: 12 });
    expect(parsePrRef("my-org/my.repo_2#7")).toEqual({ repo: "my-org/my.repo_2", number: 7 });
  });

  it("reads a GitHub PR URL, with a trailing slash, a tab or an anchor", () => {
    const ref = { repo: "example/api", number: 412 };
    expect(parsePrRef("https://github.com/example/api/pull/412")).toEqual(ref);
    expect(parsePrRef("https://github.com/example/api/pull/412/")).toEqual(ref);
    expect(parsePrRef("https://github.com/example/api/pull/412/files")).toEqual(ref);
    expect(parsePrRef("https://github.com/example/api/pull/412/files/")).toEqual(ref);
    expect(parsePrRef("https://github.com/example/api/pull/412#discussion_r1")).toEqual(ref);
  });

  it("rejects anything else", () => {
    for (const input of [
      "",
      "#",
      "0",
      "twelve",
      "example#12",
      "example/api",
      "https://github.com/example/api/issues/12",
      "https://github.com/example/api/pull/",
      "https://organization.example.invalid/example/api/pull/12",
    ]) {
      expect(parsePrRef(input), input).toBeUndefined();
    }
  });
});
