import { describe, expect, it } from "vitest";

import { parseSoundsLike, withVocabularyEntry } from "./voice-vocabulary-model";

describe("parseSoundsLike", () => {
  it("splits at commas, tidies spaces and drops repeats", () => {
    expect(parseSoundsLike(" para keet,parakit ,, para  keet ")).toEqual(["para keet", "parakit"]);
  });
});

describe("withVocabularyEntry", () => {
  it("adds a word with its spellings", () => {
    expect(withVocabularyEntry([], " Parakeet ", "para keet, parakit")).toEqual({
      ok: true,
      entries: [{ term: "Parakeet", soundsLike: ["para keet", "parakit"] }],
    });
  });

  it("merges spellings into a word already listed", () => {
    const edit = withVocabularyEntry(
      [{ term: "Parakeet", soundsLike: ["para keet"] }],
      "Parakeet",
      "parakit",
    );
    expect(edit).toEqual({
      ok: true,
      entries: [{ term: "Parakeet", soundsLike: ["para keet", "parakit"] }],
    });
  });

  it("says why it can't add an empty word", () => {
    expect(withVocabularyEntry([], "  ", "x")).toEqual({
      ok: false,
      message: "Type the word as it should be written.",
    });
  });
});
