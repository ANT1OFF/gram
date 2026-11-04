import { describe, expect, it, vi } from "vitest";
import { createKeepAwake } from "./keep-awake.ts";

const electronBlocker = () => ({ start: vi.fn(() => 0), stop: vi.fn() });

describe("desktop keep awake", () => {
  it("holds one app-suspension blocker until the server reports the last turn ended", () => {
    const blocker = electronBlocker();
    const awake = createKeepAwake(blocker);
    awake.accept({ type: "keepAwake", active: false });
    expect(blocker.start).not.toHaveBeenCalled();
    awake.accept({ type: "keepAwake", active: true });
    awake.accept({ type: "keepAwake", active: true });
    expect(blocker.start).toHaveBeenCalledExactlyOnceWith("prevent-app-suspension");
    expect(blocker.stop).not.toHaveBeenCalled();
    awake.accept({ type: "keepAwake", active: false });
    expect(blocker.stop).toHaveBeenCalledExactlyOnceWith(0);
    awake.dispose();
    expect(blocker.stop).toHaveBeenCalledTimes(1);
  });

  it("releases on server exit and can acquire again after recovery", () => {
    const blocker = electronBlocker();
    const awake = createKeepAwake(blocker);
    awake.accept({ type: "keepAwake", active: true });
    awake.dispose();
    expect(blocker.stop).toHaveBeenCalledExactlyOnceWith(0);
    awake.accept({ type: "keepAwake", active: true });
    expect(blocker.start).toHaveBeenCalledTimes(2);
  });

  it("ignores other and malformed server messages", () => {
    const blocker = electronBlocker();
    const awake = createKeepAwake(blocker);
    for (const message of [null, "keepAwake", {}, { type: "keepAwake", active: "true" }])
      awake.accept(message);
    expect(blocker.start).not.toHaveBeenCalled();
  });
});
