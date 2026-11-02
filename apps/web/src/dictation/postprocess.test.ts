import { describe, expect, it } from "vitest";

import {
  applyFormatting,
  applySymbols,
  postprocess,
  removeFillers,
  SYMBOLS,
  type PostprocessOptions,
} from "./postprocess";

const ALL: PostprocessOptions = { fillers: true, formatting: true, symbols: true };
const NONE: PostprocessOptions = { fillers: false, formatting: false, symbols: false };

describe("removeFillers", () => {
  it("takes a filler's comma and spaces with it", () => {
    expect(removeFillers("So, um, we should go.")).toBe("So, we should go.");
    expect(removeFillers("I think uh we should go.")).toBe("I think we should go.");
    expect(removeFillers("I think, um.")).toBe("I think.");
    expect(removeFillers("Well umm... maybe")).toBe("Well maybe");
    expect(removeFillers("It was, er, erm, fine")).toBe("It was, fine");
    expect(removeFillers("Done, uh")).toBe("Done");
    expect(removeFillers("(um, aside)")).toBe("(aside)");
    expect(removeFillers("Then uhm, the tests")).toBe("Then the tests");
  });

  it("hands a sentence-starting filler's capital to the next word", () => {
    expect(removeFillers("Um, so I think")).toBe("So I think");
    expect(removeFillers("Hello. Uh, we left. Ah. Then")).toBe("Hello. We left. Then");
    expect(removeFillers("Uh, um, okay")).toBe("Okay");
    // Mid-sentence, a capitalised filler passes nothing on.
    expect(removeFillers("and Um then")).toBe("and then");
  });

  it("keeps line breaks", () => {
    expect(removeFillers("First line.\nUm, second")).toBe("First line.\nSecond");
    expect(removeFillers("one um\ntwo")).toBe("one\ntwo");
  });

  it("leaves real words, including ones that are only sometimes fillers", () => {
    for (const text of [
      "The umbrella is ahead of the error.",
      "Uhura said uh-huh.",
      "Take him to the ER.",
      "UM is a university.",
      "drum, Ahab, ermine",
      "It's like, so good, you know.",
      "Plain text, nothing to do.",
      "um_count is 3",
      "",
    ])
      expect(removeFillers(text)).toBe(text);
  });

  it("keeps numbers next to a removed filler", () => {
    expect(removeFillers("about, uh, 42 files")).toBe("about, 42 files");
    expect(removeFillers("Version um 3.2")).toBe("Version 3.2");
  });
});

describe("applyFormatting", () => {
  it("turns break phrases into line breaks and drops the punctuation round them", () => {
    expect(applyFormatting("Hello. New line. Next")).toBe("Hello.\nNext");
    expect(applyFormatting("One. New paragraph. Two.")).toBe("One.\n\nTwo.");
    expect(applyFormatting("one, line break, two")).toBe("one\ntwo");
    expect(applyFormatting("first NEW LINE new line second")).toBe("first\n\nsecond");
    expect(applyFormatting("new line")).toBe("\n");
  });

  it("turns quote phrases into quotation marks", () => {
    expect(applyFormatting("He said open quote hi close quote.")).toBe('He said "hi".');
    expect(applyFormatting("He said, Open quote, hello, close quote, and left.")).toBe(
      'He said, "hello", and left.',
    );
    expect(applyFormatting("open quote yes close quote then")).toBe('"yes" then');
  });

  it("leaves a phrase after a determiner, or after literal, as spoken", () => {
    expect(applyFormatting("Start a new paragraph about tests")).toBe(
      "Start a new paragraph about tests",
    );
    expect(applyFormatting("the new line breaks it")).toBe("the new line breaks it");
    expect(applyFormatting("type literal new line here")).toBe("type new line here");
  });

  it("leaves other words alone", () => {
    for (const text of [
      "The newline character",
      "a new liner",
      "renew line items",
      "line breaker",
      "open quotes",
      "new-line handling",
      "Plain text, nothing to do.",
      "",
    ])
      expect(applyFormatting(text)).toBe(text);
  });
});

describe("applySymbols", () => {
  it("joins the words either side for joining symbols", () => {
    expect(applySymbols("foo underscore bar")).toBe("foo_bar");
    expect(applySymbols("foo underscore bar underscore baz")).toBe("foo_bar_baz");
    expect(applySymbols("well hyphen known")).toBe("well-known");
    expect(applySymbols("my dash component")).toBe("my-component");
    expect(applySymbols("and slash or")).toBe("and/or");
    expect(applySymbols("index dot ts")).toBe("index.ts");
    expect(applySymbols("std double colon vec")).toBe("std::vec");
    expect(applySymbols("C colon backslash temp")).toBe("C:\\temp");
  });

  it("writes code-like runs as code", () => {
    expect(applySymbols("open src slash components slash button dot tsx")).toBe(
      "open src/components/button.tsx",
    );
    expect(applySymbols("Src, slash, components, slash, button dot tsx.")).toBe(
      "Src/components/button.tsx.",
    );
    expect(applySymbols("look at at sign src slash index dot ts")).toBe("look at @src/index.ts");
    expect(applySymbols("run npm install dash dash save dash dev")).toBe(
      "run npm install --save-dev",
    );
    expect(applySymbols("glob src slash asterisk asterisk slash asterisk dot ts")).toBe(
      "glob src/**/*.ts",
    );
    expect(applySymbols("tilde slash code")).toBe("~/code");
    expect(applySymbols("dot env")).toBe(".env");
    expect(applySymbols("this dot props")).toBe("this.props");
    expect(applySymbols("my underscore variable")).toBe("my_variable");
    expect(applySymbols("slash review")).toBe("/review");
  });

  it("handles numbers", () => {
    expect(applySymbols("version 1 dot 2 dot 3")).toBe("version 1.2.3");
    expect(applySymbols("pages 5 dash 10")).toBe("pages 5-10");
    expect(applySymbols("x equals sign 42")).toBe("x = 42");
    expect(applySymbols("if x triple equals 0")).toBe("if x === 0");
  });

  it("attaches prefixes to the next word", () => {
    expect(applySymbols("ask at sign claude")).toBe("ask @claude");
    expect(applySymbols("hashtag release")).toBe("#release");
    expect(applySymbols("issue hash sign 42")).toBe("issue #42");
    expect(applySymbols("echo dollar sign HOME")).toBe("echo $HOME");
  });

  it("puts one space after punctuation symbols", () => {
    expect(applySymbols("done comma thanks")).toBe("done, thanks");
    expect(applySymbols("one semicolon two")).toBe("one; two");
    expect(applySymbols("the list colon apples")).toBe("the list: apples");
    expect(applySymbols("Done, Comma, thanks.")).toBe("Done, thanks.");
    expect(applySymbols("really question mark")).toBe("really?");
  });

  it("spaces operators", () => {
    expect(applySymbols("x fat arrow y")).toBe("x => y");
    expect(applySymbols("x ampersand y")).toBe("x & y");
    expect(applySymbols("x double equals y")).toBe("x == y");
  });

  it("pairs brackets, braces and parens", () => {
    expect(applySymbols("call foo open paren close paren")).toBe("call foo()");
    expect(applySymbols("call foo open paren x close paren dot then")).toBe("call foo (x).then");
    expect(applySymbols("type string open bracket close bracket")).toBe("type string[]");
    expect(applySymbols("an aside open paren really close paren then")).toBe(
      "an aside (really) then",
    );
    expect(applySymbols("open brace x close brace")).toBe("{x}");
    expect(applySymbols("open curly brace close curly brace")).toBe("{}");
    expect(applySymbols("Array open angle bracket string close angle bracket")).toBe(
      "Array <string>",
    );
  });

  it("opens and closes backticks in turn", () => {
    expect(applySymbols("run backtick bun test backtick now")).toBe("run `bun test` now");
    expect(applySymbols("backtick foo backtick, then backtick bar backtick.")).toBe(
      "`foo`, then `bar`.",
    );
    expect(applySymbols("triple backtick ts")).toBe("```ts");
  });

  it("makes a dash at the start of a line a list item", () => {
    expect(applySymbols("dash milk")).toBe("- milk");
    expect(applySymbols("eggs\ndash milk")).toBe("eggs\n- milk");
    expect(applySymbols("dash dash verbose")).toBe("--verbose");
  });

  it("leaves a symbol word after a determiner as spoken: dot in a real sentence", () => {
    for (const text of [
      "There is a dot on the screen.",
      "It starts on the dot.",
      "She wore a polka dot dress.",
      "Add a dash of salt.",
      "Put a comma there.",
      "the colon is inflamed",
      "Use an underscore, not a hyphen.",
      "Which slash do I need?",
      "if a fat arrow is used",
    ])
      expect(applySymbols(text)).toBe(text);
  });

  it("writes a phrase after literal as spoken", () => {
    expect(applySymbols("the word literal dot is short")).toBe("the word dot is short");
    expect(applySymbols("say literal backtick and literal at sign")).toBe(
      "say backtick and at sign",
    );
    expect(applySymbols("literal underscore foo underscore bar")).toBe("underscore foo_bar");
  });

  it("leaves other words alone", () => {
    for (const text of [
      "connect the dots",
      "dotted lines",
      "commas and colons",
      "slashed prices",
      "hashtags everywhere",
      "a hash browns sign",
      "the colonel",
      "it equals four",
      "pipe the output to grep",
      "a period of time",
      "star the repo",
      "hash the password",
      "dot-com era",
      "Plain text, nothing to do.",
      "",
    ])
      expect(applySymbols(text)).toBe(text);
  });

  it("lists longer phrases before the shorter ones they start with", () => {
    for (const [index, phrase] of SYMBOLS.entries())
      for (const later of SYMBOLS.slice(index + 1))
        expect(
          phrase.words.length >= later.words.length ||
            later.words.slice(0, phrase.words.length).join(" ") !== phrase.words.join(" "),
          `${later.words.join(" ")} after ${phrase.words.join(" ")}`,
        ).toBe(true);
  });
});

describe("postprocess", () => {
  it("runs fillers, then formatting, then symbols", () => {
    expect(postprocess("Um, rename foo um underscore bar. New line. Uh, thanks", ALL)).toBe(
      "Rename foo_bar.\nThanks",
    );
    expect(postprocess("uh new paragraph dash first item", ALL)).toBe("\n\n- first item");
  });

  it("runs only the rules turned on", () => {
    const text = "Um, foo underscore bar new line done";
    expect(postprocess(text, NONE)).toBe(text);
    expect(postprocess(text, { ...NONE, fillers: true })).toBe("Foo underscore bar new line done");
    expect(postprocess(text, { ...NONE, formatting: true })).toBe("Um, foo underscore bar\ndone");
    expect(postprocess(text, { ...NONE, symbols: true })).toBe("Um, foo_bar new line done");
  });

  it("can remove everything", () => {
    expect(postprocess("Um, uh.", ALL)).toBe("");
  });
});
