import type { GramUIMessage } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { latestSaid } from "./review-strip";

const message = (role: "user" | "assistant", ...texts: string[]): GramUIMessage =>
  ({
    id: `${role}-${texts.join()}`,
    role,
    parts: texts.map((text) => ({ type: "text", text })),
  }) as unknown as GramUIMessage;

describe("latestSaid", () => {
  it("is the newest message with words, whoever said it", () => {
    expect(
      latestSaid([message("user", "Fix it"), message("assistant", "Done.", "Tests pass.")]),
    ).toEqual({ role: "assistant", text: "Done.\n\nTests pass." });
    expect(latestSaid([message("assistant", "Done."), message("user", "Open the PR.")])).toEqual({
      role: "user",
      text: "Open the PR.",
    });
  });

  it("passes over a message with no words, such as a run of tools", () => {
    expect(latestSaid([message("assistant", "Done."), message("assistant", "  ")])).toEqual({
      role: "assistant",
      text: "Done.",
    });
    expect(latestSaid([])).toBeUndefined();
  });
});
