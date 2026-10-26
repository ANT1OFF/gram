import { describe, expect, it } from "vitest";

import { draftedThreads, draftPresenceReporter } from "./draft-presence";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("draft presence", () => {
  it("names only the threads whose draft has more than whitespace", () => {
    expect(draftedThreads({ b: "hello", a: "  ", c: "\n x" })).toEqual(["b", "c"]);
  });

  it("reports changes once, repeats a waiting draft on the heartbeat, and says when it goes", async () => {
    const sent: Array<readonly string[]> = [];
    const { report } = draftPresenceReporter(async (ids) => void sent.push(ids));
    report(["a"]);
    report(["a"]);
    report(["a"], true);
    report([]);
    report([], true);
    await flush();
    expect(sent).toEqual([["a"], ["a"], []]);
  });
});
