import type { GramUIMessage } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { firstUnseen } from "./unread";

const at = (minutes: number) => minutes * 60_000;

const message = (
  id: string,
  role: "user" | "assistant",
  minutes: number,
  fromThread = false,
): GramUIMessage =>
  ({
    id,
    role,
    metadata: { createdAt: at(minutes) },
    parts: [
      { type: "text", text: id },
      ...(fromThread
        ? [{ type: "data-thread-origin", id, data: { threadId: "t-o", title: "O", depth: 1 } }]
        : []),
    ],
  }) as GramUIMessage;

describe("firstUnseen", () => {
  const messages = [
    message("brief", "user", 1, true),
    message("reply", "assistant", 2),
    message("mine", "user", 6),
    message("after", "assistant", 7),
    message("later", "assistant", 8),
  ];

  it("is the first message after the user last looked, past their own words", () => {
    expect(firstUnseen(messages, at(5))).toBe("after");
    expect(firstUnseen(messages, at(1))).toBe("reply");
  });

  it("counts another thread's message as unseen: it isn't the user's", () => {
    const withSteer = [...messages.slice(0, 3), message("steer", "user", 6.5, true)];
    expect(firstUnseen(withSteer, at(5))).toBe("steer");
  });

  it("draws nothing when nothing is new, nothing was seen, or all of it is new", () => {
    expect(firstUnseen(messages, at(9))).toBeUndefined();
    expect(firstUnseen(messages, undefined)).toBeUndefined();
    expect(firstUnseen(messages, 0)).toBeUndefined();
  });
});
