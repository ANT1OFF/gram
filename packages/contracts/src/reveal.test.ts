import { describe, expect, it } from "vitest";

import { approvalHidesText, approvalSubject } from "./domain.ts";
import { hidesText, revealHidden, valueHidesText } from "./reveal.ts";

describe("revealHidden", () => {
  it("shows every character that hides or reorders text as its code point", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      // A right-to-left override that makes `rm -rf ~ #` read backwards after it.
      ["echo ok ‮# ~ fr- mr", "echo ok ⟨U+202E⟩# ~ fr- mr"],
      ["a⁦b⁧c⁨d⁩e", "a⟨U+2066⟩b⟨U+2067⟩c⟨U+2068⟩d⟨U+2069⟩e"],
      ["git​push", "git⟨U+200B⟩push"],
      ["x‌y‍z⁠w﻿", "x⟨U+200C⟩y⟨U+200D⟩z⟨U+2060⟩w⟨U+FEFF⟩"],
      // Tag characters spell out text nobody sees.
      ["ls\u{E0063}\u{E0075}\u{E0072}\u{E006C}", "ls⟨U+E0063⟩⟨U+E0075⟩⟨U+E0072⟩⟨U+E006C⟩"],
      ["a️b\u{E0100}", "a⟨U+FE0F⟩b⟨U+E0100⟩"],
      ["ㅤ ᅟ", "⟨U+3164⟩ ⟨U+115F⟩"],
      ["one\rtwo\u0007 ", "one⟨U+000D⟩two⟨U+0007⟩⟨U+2028⟩"],
    ];
    for (const [text, shown] of cases) {
      expect(revealHidden(text)).toBe(shown);
      expect(hidesText(text)).toBe(true);
    }
  });

  it("leaves plain text, line breaks, tabs and non-Latin scripts as they are", () => {
    const plain = "git commit -m 'café ✓ 日本語 עברית'\n\tnext";
    expect(revealHidden(plain)).toBe(plain);
    expect(hidesText(plain)).toBe(false);
    // Asked twice, the answer stays the same (the pattern is global).
    expect(hidesText("a‮b")).toBe(true);
    expect(hidesText("a‮b")).toBe(true);
  });

  it("finds hidden text anywhere in an approval, and its subject shows the markers", () => {
    expect(valueHidesText({ a: [{ b: "ok" }, 1, null] })).toBe(false);
    expect(valueHidesText({ a: [{ b: "o​k" }] })).toBe(true);
    expect(valueHidesText({ ["k‮"]: "v" })).toBe(true);

    const request = {
      input: { command: "ls", timeout: 5, env: { PATH: "/bin⁦" } },
      displayName: "Bash",
    };
    expect(approvalHidesText(request)).toBe(true);
    expect(approvalHidesText({ ...request, input: { command: "ls" } })).toBe(false);
    expect(
      approvalHidesText({ input: { command: "ls" }, displayName: "Bash", description: "‮" }),
    ).toBe(true);
    expect(approvalSubject({ input: { command: "rm‮ x" } })).toBe("rm⟨U+202E⟩ x");
    expect(approvalSubject({ input: { file_path: "/a​/b" } })).toBe("/a⟨U+200B⟩/b");
  });
});
