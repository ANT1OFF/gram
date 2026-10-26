import { describe, expect, it } from "vitest";

import { createPromptHistory } from "./history";

describe("createPromptHistory seed", () => {
  it("puts stored prompts below this session's, newest stored first", () => {
    const history = createPromptHistory();
    history.push("sent just now");
    history.seed(["newest stored", "older stored", "sent just now"]);

    expect(history.previous("")).toBe("sent just now");
    expect(history.previous("")).toBe("newest stored");
    expect(history.previous("")).toBe("older stored");
    expect(history.previous("")).toBeUndefined();
  });

  it("collapses a prompt sent again, and caps the list", () => {
    const history = createPromptHistory(3);
    history.seed(["b", "a", "c", "a"]);
    history.push("a");
    expect(history.previous("")).toBe("a");
    expect(history.previous("")).toBe("b");
    expect(history.previous("")).toBe("c");
    expect(history.previous("")).toBeUndefined();
  });

  it("ignores a seed that lands while stepping through prompts", () => {
    const history = createPromptHistory();
    history.push("one");
    expect(history.previous("draft")).toBe("one");
    history.seed(["stored"]);
    expect(history.previous("one")).toBeUndefined();
    expect(history.next()).toBe("draft");
    history.seed(["stored"]);
    expect(history.previous("")).toBe("one");
    expect(history.previous("")).toBe("stored");
  });
});
