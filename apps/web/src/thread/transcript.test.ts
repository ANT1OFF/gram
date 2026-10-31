import type { GramUIMessage } from "@gram/contracts";
import { longTranscript } from "@gram/contracts/testing";
import { describe, expect, it } from "vitest";

import type { MessageFold } from "./tool-group-model";
import { estimateRowHeight } from "./transcript";

const reply = (text: string): GramUIMessage => ({
  id: `m-${text.length}`,
  role: "assistant",
  parts: [{ type: "text", text, state: "done" }],
});

describe("estimateRowHeight", () => {
  it("grows with the text and counts each tool card as a collapsed header", () => {
    const short = estimateRowHeight(reply("Done."));
    const long = estimateRowHeight(reply("word ".repeat(400)));
    expect(long).toBeGreaterThan(short * 5);

    const [, assistant] = longTranscript({ threadId: "t", turns: 1 });
    const withTools = estimateRowHeight(assistant!);
    const withoutTools = estimateRowHeight({
      ...assistant!,
      parts: assistant!.parts.filter((part) => !part.type.startsWith("tool-")),
    });
    expect(withTools - withoutTools).toBe(80);
  });

  it("estimates each message once", () => {
    const message = reply("Measured once.");
    const first = estimateRowHeight(message);
    (message.parts[0] as { text: string }).text = "word ".repeat(1_000);
    expect(estimateRowHeight(message)).toBe(first);
  });
});

const message: GramUIMessage = {
  id: "m",
  role: "assistant",
  parts: [
    { type: "text", text: "word ".repeat(400), state: "done" },
    { type: "text", text: "Done.", state: "done" },
  ],
};
const fold = (over: Partial<MessageFold> = {}): MessageFold => ({
  turn: "t",
  hidden: new Set([0]),
  apart: new Set([0]),
  under: new Set(),
  empty: false,
  row: undefined,
  ...over,
});

describe("estimateRowHeight of a closed fold", () => {
  it("leaves out what the fold hides", () => {
    expect(estimateRowHeight(message, fold())).toBeLessThan(estimateRowHeight(message) / 2);
  });

  it("takes no room for a reply the fold empties", () => {
    expect(estimateRowHeight(message, fold({ empty: true }))).toBe(0);
  });
});
