import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, projectNamesOn, voiceVocabularyOf } from "./settings.ts";
import { distinctiveTerm, isCommonWord, termKey, termParts } from "./vocabulary.ts";

const key = (term: string) => termKey(termParts(term));

describe("termKey", () => {
  it("spells camel, snake and kebab case the same, and keeps a spoken dot or slash", () => {
    expect(key("useDictation")).toBe("usedictation");
    expect(key("use_dictation")).toBe("usedictation");
    expect(key("use-dictation")).toBe("usedictation");
    expect(key("use dictation")).toBe("usedictation");
    expect(key("dictation.ts")).toBe("dictation.ts");
    expect(key("feat/voice-vocab")).toBe("feat/voicevocab");
    expect(key("HTMLParser")).toBe("htmlparser");
  });

  it("splits case runs and digits into words", () => {
    expect(termParts("HTMLParser2")).toEqual([{ word: "HTML" }, { word: "Parser" }, { word: "2" }]);
  });
});

describe("distinctiveTerm", () => {
  it("keeps names a speaker can only mean as code", () => {
    for (const term of ["useDictation", "index.ts", "feat/voice-vocab", "sherpa-onnx", "README.md"])
      expect(distinctiveTerm(term), term).toBe(true);
  });

  it("leaves out single words and names made only of everyday words", () => {
    for (const term of ["README", "Effect", "setState", "planClip", "listFileNames", "v2", "a.b"])
      expect(distinctiveTerm(term), term).toBe(false);
  });
});

describe("isCommonWord", () => {
  it("knows a common word with an ending on it", () => {
    expect(isCommonWord("files")).toBe(true);
    expect(isCommonWord("Loaded")).toBe(true);
    expect(isCommonWord("dictation")).toBe(false);
    expect(isCommonWord("")).toBe(false);
  });
});

describe("voice vocabulary settings", () => {
  it("uses the project's names unless turned off, with an empty list of the user's own", () => {
    expect(projectNamesOn(DEFAULT_SETTINGS)).toBe(true);
    expect(voiceVocabularyOf(DEFAULT_SETTINGS)).toEqual([]);
    expect(projectNamesOn({ ...DEFAULT_SETTINGS, voice: { projectNames: false } })).toBe(false);
  });
});
