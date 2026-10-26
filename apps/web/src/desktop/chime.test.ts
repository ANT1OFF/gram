// @vitest-environment happy-dom
import { chimeOf } from "@gram/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { themeStore } from "@/theme/store";

import { CHIME_GAP_MS, resetChimeThrottle, scheduleChime } from "./chime";

const oscillators: { frequency: { value: number } }[] = [];

class FakeAudioContext {
  currentTime = 0;
  destination = {};
  createOscillator() {
    const oscillator = {
      type: "sine",
      frequency: { value: 0 },
      connect: (node: unknown) => node,
      start: vi.fn(),
      stop: vi.fn(),
    };
    oscillators.push(oscillator);
    return oscillator;
  }
  createGain() {
    return {
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: (node: unknown) => node,
    };
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("AudioContext", FakeAudioContext);
  oscillators.length = 0;
  resetChimeThrottle();
  themeStore.setState({ motion: "system" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("scheduleChime", () => {
  it("plays the chosen sound on a later task, once per burst", () => {
    scheduleChime("marimba", 10_000);
    expect(oscillators).toHaveLength(0);
    vi.runAllTimers();
    expect(oscillators.map((o) => o.frequency.value)).toEqual([523.25, 659.25, 783.99]);

    scheduleChime("marimba", 10_000 + CHIME_GAP_MS - 1);
    vi.runAllTimers();
    expect(oscillators).toHaveLength(3);
    scheduleChime("pop", 10_000 + CHIME_GAP_MS);
    vi.runAllTimers();
    expect(oscillators).toHaveLength(4);
  });

  it("stays silent for None and Motion Off, and plays one note under Reduced", () => {
    scheduleChime(undefined, 10_000);
    themeStore.setState({ motion: "off" });
    scheduleChime("chime", 20_000);
    vi.runAllTimers();
    expect(oscillators).toHaveLength(0);

    themeStore.setState({ motion: "reduced" });
    scheduleChime("chime", 30_000);
    vi.runAllTimers();
    expect(oscillators.map((o) => o.frequency.value)).toEqual([880]);
  });
});

describe("chimeOf", () => {
  it("is None while sounds are off, and the default without a choice", () => {
    expect(chimeOf({ sounds: false, chime: "bell" })).toBeUndefined();
    expect(chimeOf({ sounds: true })).toBe("chime");
    expect(chimeOf({ sounds: true, chime: "bell" })).toBe("bell");
  });
});
