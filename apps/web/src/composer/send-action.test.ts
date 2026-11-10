import { describe, expect, it } from "vitest";

import { sendAction } from "./send-action";

const at = (over: Partial<Parameters<typeof sendAction>[0]>) =>
  sendAction({
    hasDraft: false,
    busy: false,
    background: false,
    steerable: false,
    held: undefined,
    ...over,
  });

describe("sendAction", () => {
  it("sends at rest, draft or not, whatever is held", () => {
    expect(at({})).toBe("send");
    expect(at({ hasDraft: true })).toBe("send");
    expect(at({ hasDraft: true, held: "interrupt" })).toBe("send");
  });

  it("stops what is running while the composer is empty", () => {
    expect(at({ busy: true })).toBe("stop");
    expect(at({ background: true })).toBe("stop");
    expect(at({ busy: true, steerable: true, held: "interrupt" })).toBe("stop");
  });

  it("steers a draft into a turn that takes input; ⌥ queues it and ⌘ interrupts", () => {
    const running = { busy: true, hasDraft: true, steerable: true };
    expect(at(running)).toBe("steer");
    expect(at({ ...running, held: "queue" })).toBe("queue");
    expect(at({ ...running, held: "interrupt" })).toBe("interrupt");
  });

  it("queues a draft for a turn that can't take input, whatever is held", () => {
    expect(at({ busy: true, hasDraft: true })).toBe("queue");
    expect(at({ busy: true, hasDraft: true, held: "interrupt" })).toBe("queue");
  });

  it("sends a draft to a thread whose only work is in the background", () => {
    expect(at({ background: true, hasDraft: true })).toBe("send");
  });
});
