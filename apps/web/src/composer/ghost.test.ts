import { describe, expect, it } from "vitest";

import type { SuggestionEntry } from "@/stores/suggestions";

import { ghostOf, nextWord, stepped } from "./ghost";

const entry = (patch: Partial<SuggestionEntry> = {}): SuggestionEntry => ({
  turnId: "turn-1",
  replies: ["Run the e2e suite", "Commit this", "Run it again"],
  chosen: undefined,
  dismissed: false,
  counted: false,
  taken: false,
  stale: false,
  takenBack: 0,
  ...patch,
});

const at = (text: string, patch: Partial<SuggestionEntry> = {}, caretAtEnd = true) =>
  ghostOf({ text, entry: entry(patch), caretAtEnd, blocked: false });

describe("ghostOf", () => {
  it("shows the first suggestion in an empty box, or the one stepped to", () => {
    expect(at("")).toMatchObject({ suggestion: "Run the e2e suite", position: 0, count: 3 });
    expect(at("", { chosen: "Run it again" })).toMatchObject({
      suggestion: "Run it again",
      position: 2,
    });
    const ghost = at("")!;
    expect(stepped(ghost, 1)).toBe("Commit this");
    expect(stepped(ghost, -1)).toBe("Run it again");
    expect(stepped(at("", { chosen: "Run it again" })!, 1)).toBe("Run the e2e suite");
  });

  it("follows a typed prefix, whatever its case, among the suggestions it fits", () => {
    expect(at("run ")).toMatchObject({
      suggestion: "Run the e2e suite",
      rest: "the e2e suite",
      count: 2,
    });
    expect(at("Ship")).toBeUndefined();
    // Typed out in full, there is nothing left to suggest.
    expect(at("Commit this")).toBeUndefined();
  });

  it("keeps to the chosen suggestion while what's typed fits it, as taking a word leaves it", () => {
    // Taking "Run" of the third fits the first as well; the third is still the one shown.
    expect(at("Run", { chosen: "Run it again" })).toMatchObject({ rest: " it again", position: 1 });
    // Typed past it, the first that fits shows instead.
    expect(at("Run the", { chosen: "Run it again" })?.suggestion).toBe("Run the e2e suite");
  });

  it("stays away from a caret mid-text, a dismissal and anything else holding the keys", () => {
    expect(at("Run", {}, false)).toBeUndefined();
    expect(at("", { dismissed: true })).toBeUndefined();
    expect(ghostOf({ text: "", entry: entry(), caretAtEnd: true, blocked: true })).toBeUndefined();
    expect(
      ghostOf({ text: "", entry: undefined, caretAtEnd: true, blocked: false }),
    ).toBeUndefined();
  });
});

describe("nextWord", () => {
  it("takes the next word with the space before it", () => {
    expect(nextWord("2e suite against")).toBe("2e");
    expect(nextWord(" suite against")).toBe(" suite");
    expect(nextWord("last")).toBe("last");
  });
});
