import type { GramUIMessage } from "@gram/contracts";
import { longTranscript } from "@gram/contracts/testing";
import { describe, expect, it } from "vitest";

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
