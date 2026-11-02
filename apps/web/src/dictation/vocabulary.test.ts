import type { ProjectTerm, VocabularyEntry } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { postprocess } from "./postprocess";
import { applyVocabulary, buildVocabularyIndex, EMPTY_VOCABULARY } from "./vocabulary";

const PROJECT: ProjectTerm[] = [
  { term: "useDictation", kind: "symbol" },
  { term: "createSpeechService", kind: "symbol" },
  { term: "createSherpaRecogniser", kind: "symbol" },
  { term: "loadSherpaRuntime", kind: "symbol" },
  { term: "listFileNames", kind: "symbol" },
  { term: "SpeechModelPaths", kind: "symbol" },
  { term: "applySettingsPatch", kind: "symbol" },
  { term: "VoiceInputSection", kind: "symbol" },
  { term: "planClip", kind: "symbol" },
  { term: "setState", kind: "symbol" },
  { term: "use-dictation.ts", kind: "file" },
  { term: "use-dictation", kind: "file" },
  { term: "dictation.ts", kind: "file" },
  { term: "sherpa.ts", kind: "file" },
  { term: "index.ts", kind: "file" },
  { term: "worktree-gc.ts", kind: "file" },
  { term: "voice-input-section.tsx", kind: "file" },
  { term: "speech-process", kind: "folder" },
  { term: "feat/voice-vocab", kind: "branch" },
];

const USER: VocabularyEntry[] = [
  { term: "Parakeet", soundsLike: ["para keet", "parakit"] },
  { term: "Nemotron" },
  { term: "Gram", soundsLike: ["grahm"] },
];

const index = buildVocabularyIndex(USER, PROJECT);
const spell = (text: string) => applyVocabulary(text, index);

describe("applyVocabulary", () => {
  it("joins spoken words into the identifier they name", () => {
    expect(spell("Open use dictation and check it.")).toBe("Open useDictation and check it.");
    expect(spell("Rename create sherpa recogniser, please")).toBe(
      "Rename createSherpaRecogniser, please",
    );
    expect(spell("Call load sherpa runtime first")).toBe("Call loadSherpaRuntime first");
  });

  it("spells file names said with a dot, and ones the recogniser already dotted", () => {
    expect(spell("Look at dictation dot TS.")).toBe("Look at dictation.ts.");
    expect(spell("Look at dictation.ts.")).toBe("Look at dictation.ts.");
    expect(spell("Open use dictation dot ts now")).toBe("Open use-dictation.ts now");
    expect(spell("Worktree GC dot TS removes folders")).toBe("worktree-gc.ts removes folders");
    expect(spell("in voice input section dot tsx")).toBe("in voice-input-section.tsx");
  });

  it("spells names after the clean-up has turned spoken symbols into characters", () => {
    const cleanup = { fillers: true, formatting: true, symbols: true };
    const spoken = "Um, open use dictation dot ts and check out feat slash voice vocab.";
    expect(spell(postprocess(spoken, cleanup))).toBe(
      "Open use-dictation.ts and check out feat/voice-vocab.",
    );
  });

  it("spells a branch said with a slash", () => {
    expect(spell("Check out feat slash voice vocab.")).toBe("Check out feat/voice-vocab.");
  });

  it("prefers a symbol to a file stem that sounds the same", () => {
    expect(spell("use dictation")).toBe("useDictation");
    expect(spell("the voice input section component")).toBe("the voice input section component");
  });

  it("uses the user's spellings and sounds-likes", () => {
    expect(spell("parakeet runs after nemotron")).toBe("Parakeet runs after Nemotron");
    expect(spell("Para keet is the offline model")).toBe("Parakeet is the offline model");
    expect(spell("open grahm settings")).toBe("open Gram settings");
  });

  it("takes a near miss for a long name, one letter off", () => {
    expect(spell("Call load sherpa runtine first")).toBe("Call loadSherpaRuntime first");
    expect(spell("Nematron is the streaming one")).toBe("Nemotron is the streaming one");
    expect(spell("in worktree gee see dot ts")).toBe("in worktree gee see dot ts");
  });

  it("never turns ordinary words into a name", () => {
    for (const prose of [
      "We should plan clip lengths more carefully.",
      "Set state before you go.",
      "Set the state of the index before you run the tests.",
      "The speech process is slow today.",
      "The voice input section needs a row.",
      "Index the files and update the tree.",
      "She bought three parakeets.",
      "Dot your i's and cross your t's.",
      "The model paths are wrong.",
      "Rename create speech service, please.",
      "Can you list file names in this folder?",
      "Apply settings patch notes later.",
      "We should plan clips.",
    ]) {
      expect(spell(prose)).toBe(prose);
    }
  });

  it("takes a name of several common words when the user listed it", () => {
    const own = buildVocabularyIndex([{ term: "createSpeechService" }], []);
    expect(applyVocabulary("Rename create speech service.", own)).toBe(
      "Rename createSpeechService.",
    );
  });

  it("leaves a common word the user listed alone, unless it was listed as a sounds-like", () => {
    const own = buildVocabularyIndex([{ term: "Effect", soundsLike: ["effect ts"] }], []);
    expect(applyVocabulary("What effect does it have?", own)).toBe("What effect does it have?");
    expect(applyVocabulary("We use effect ts here", own)).toBe("We use Effect here");
  });

  it("keeps plurals and other endings as they are", () => {
    expect(spell("two Parakeets and a Nemotrons")).toBe("two Parakeets and a Nemotrons");
  });

  it("does not run a name across punctuation", () => {
    expect(spell("use, dictation")).toBe("use, dictation");
    expect(spell("dictation. TS is next")).toBe("dictation. TS is next");
    expect(spell("use\ndictation")).toBe("use\ndictation");
    expect(spell("\n")).toBe("\n");
  });

  it("drops two names of the same kind that sound alike", () => {
    const tied = buildVocabularyIndex(
      [],
      [
        { term: "fooBarBaz", kind: "symbol" },
        { term: "foo_bar_baz", kind: "symbol" },
      ],
    );
    expect(applyVocabulary("call foo bar baz", tied)).toBe("call foo bar baz");
  });

  it("leaves text alone with no vocabulary", () => {
    expect(applyVocabulary("use dictation dot ts", EMPTY_VOCABULARY)).toBe("use dictation dot ts");
  });

  it("is quick enough for a few thousand names", () => {
    const many: ProjectTerm[] = Array.from({ length: 3_000 }, (_, i) => ({
      term: `someLongName${i}Thing`,
      kind: "symbol" as const,
    }));
    const big = buildVocabularyIndex(USER, [...PROJECT, ...many]);
    const text = "Open use dictation dot ts and then call some long name 42 thing. ".repeat(4);
    const started = performance.now();
    const out = applyVocabulary(text, big);
    expect(performance.now() - started).toBeLessThan(200);
    expect(out).toContain("someLongName42Thing");
  });
});
