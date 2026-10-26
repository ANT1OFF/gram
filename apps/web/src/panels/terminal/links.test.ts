import { describe, expect, it } from "vitest";

import { findPathLinks } from "./links";

const ROOT = "/Users/dev/code/api";

describe("findPathLinks", () => {
  it("links relative and in-checkout absolute path:line references", () => {
    const text =
      "src/retry.ts:12:5 - error TS2322, see ./test/a.test.ts:3 and /Users/dev/code/api/b.ts:40";
    expect(findPathLinks(text, ROOT)).toEqual([
      { start: 0, end: 17, path: `${ROOT}/src/retry.ts`, line: 12, column: 5 },
      { start: 38, end: 56, path: `${ROOT}/test/a.test.ts`, line: 3 },
      { start: 61, end: 88, path: `${ROOT}/b.ts`, line: 40 },
    ]);
  });

  it("skips URLs, paths outside the checkout, .. escapes and references without a line", () => {
    expect(findPathLinks("https://example.test/src/a.ts:3", ROOT)).toEqual([]);
    expect(findPathLinks("/etc/hosts.conf:1", ROOT)).toEqual([]);
    expect(findPathLinks("../other/a.ts:2", ROOT)).toEqual([]);
    expect(findPathLinks("src/retry.ts", ROOT)).toEqual([]);
    expect(findPathLinks("src/retry.ts:12", undefined)).toEqual([]);
  });

  it("handles Windows checkouts and backslash paths", () => {
    expect(findPathLinks("C:\\code\\api\\src\\a.ts:7", "C:\\code\\api")).toEqual([
      { start: 0, end: 22, path: "C:/code/api/src/a.ts", line: 7 },
    ]);
  });
});
