import { describe, expect, it } from "vitest";

import { createPromptHistory } from "./history";

describe("createPromptHistory", () => {
  it("walks back through prompts and forward to the saved draft", () => {
    const history = createPromptHistory();
    history.push("one");
    history.push("two");

    expect(history.previous("dra")).toBe("two");
    expect(history.navigating).toBe(true);
    expect(history.previous("two")).toBe("one");
    expect(history.previous("one")).toBeUndefined();
    expect(history.next()).toBe("two");
    expect(history.next()).toBe("dra");
    expect(history.navigating).toBe(false);
    expect(history.next()).toBeUndefined();
  });

  it("skips blank and consecutive duplicate prompts", () => {
    const history = createPromptHistory();
    history.push("same");
    history.push("same");
    history.push("   ");
    expect(history.previous("")).toBe("same");
    expect(history.previous("same")).toBeUndefined();
  });

  it("drops the oldest entries past the limit and resets on push", () => {
    const history = createPromptHistory(2);
    history.push("a");
    history.push("b");
    history.previous("");
    history.push("c");
    expect(history.navigating).toBe(false);
    expect(history.previous("")).toBe("c");
    expect(history.previous("")).toBe("b");
    expect(history.previous("")).toBeUndefined();
  });

  it("starts from the newest prompt again once navigation is reset, and takes a seed then", () => {
    const history = createPromptHistory();
    history.push("only");
    expect(history.previous("")).toBe("only");
    expect(history.previous("only")).toBeUndefined();
    // The composer resets when the text is edited, e.g. cleared after recalling a prompt.
    history.reset();
    expect(history.previous("")).toBe("only");
    history.reset();
    history.seed(["from the server"]);
    expect(history.previous("")).toBe("only");
    expect(history.previous("only")).toBe("from the server");
  });

  it("does nothing when empty", () => {
    const history = createPromptHistory();
    expect(history.previous("draft")).toBeUndefined();
    expect(history.navigating).toBe(false);
  });
});
