import { describe, expect, it } from "vitest";

import { sendAction } from "./send-action";

const at = (over: Partial<Parameters<typeof sendAction>[0]>) =>
  sendAction({ hasDraft: false, busy: false, background: false, steering: false, ...over });

describe("sendAction", () => {
  it("sends at rest, draft or not", () => {
    expect(at({})).toBe("send");
    expect(at({ hasDraft: true })).toBe("send");
  });

  it("stops what is running while the composer is empty", () => {
    expect(at({ busy: true })).toBe("stop");
    expect(at({ background: true })).toBe("stop");
  });

  it("queues a draft during a turn, and steers it with the modifier", () => {
    expect(at({ busy: true, hasDraft: true })).toBe("queue");
    expect(at({ busy: true, hasDraft: true, steering: true })).toBe("steer");
  });

  it("sends a draft to a thread whose only work is in the background", () => {
    expect(at({ background: true, hasDraft: true })).toBe("send");
  });

  it("never stops with the modifier and nothing to steer", () => {
    expect(at({ busy: true, steering: true })).toBe("stop");
  });
});
