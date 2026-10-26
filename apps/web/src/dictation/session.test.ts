import type { SpeechClientMessage, SpeechServerMessage } from "@gram/contracts";
import { describe, expect, it, vi } from "vitest";

import { createPushToTalk, HOLD_MS, releasesChord } from "./push-to-talk";
import {
  createDictation,
  LEAD_SILENCE_FRAMES,
  loudness,
  spacedAfter,
  type DictationDeps,
  type DictationPort,
  type DictationState,
} from "./session";

/** The page's end of a session, recording what was posted and delivering what the "process" says. */
const fakePort = () => {
  const sent: SpeechClientMessage[] = [];
  let listener: ((event: MessageEvent) => void) | undefined;
  let closed = false;
  const port: DictationPort = {
    postMessage: (message) => sent.push(message),
    addEventListener: (_type, l) => {
      listener = l;
    },
    removeEventListener: () => {
      listener = undefined;
    },
    start: () => {},
    close: () => {
      closed = true;
    },
  };
  return {
    port,
    sent,
    closed: () => closed,
    say: (message: SpeechServerMessage) => listener?.({ data: message } as MessageEvent),
  };
};

const setup = (overrides: Partial<DictationDeps> = {}) => {
  const session = fakePort();
  let frame: ((samples: Float32Array) => void) | undefined;
  const capture = { stop: vi.fn() };
  const states: DictationState[] = [];
  const partials: string[] = [];
  const commits: string[] = [];
  const open = vi.fn(async () => ({ ok: true as const, port: session.port }));
  const dictation = createDictation(
    {
      open,
      startCapture: async (onFrame) => {
        frame = onFrame;
        return capture;
      },
      newSessionId: () => "s1",
      ...overrides,
    },
    {
      onState: (state) => states.push(state),
      onPartial: (text) => partials.push(text),
      onCommit: (text) => commits.push(text),
    },
  );
  return {
    dictation,
    session,
    capture,
    open,
    states,
    partials,
    commits,
    frame: (samples: Float32Array) => frame?.(samples),
  };
};

it("ends a rejected open with an error and permits retry instead of staying in starting", async () => {
  let fail = true;
  const port = fakePort();
  const { dictation, states } = setup({
    open: async () => {
      if (fail) throw new Error("private transport error");
      return { ok: true, port: port.port };
    },
  });
  await dictation.start({ modelId: "m" });
  expect(states.map((state) => state.phase)).toEqual(["starting", "error"]);
  expect(dictation.state()).toMatchObject({
    code: "unavailable",
    message: expect.stringContaining("Couldn't start dictation"),
  });
  fail = false;
  await dictation.start({ modelId: "m" });
  expect(dictation.state().phase).toBe("listening");
  dictation.cancel();
});

describe("dictation", () => {
  it("leads with silence, streams frames, shows partials and commits each pause and the stop", async () => {
    const t = setup();
    await t.dictation.start({ modelId: "m" });
    expect(t.open).toHaveBeenCalledWith({ sessionId: "s1", modelId: "m" });
    expect(t.dictation.state()).toEqual({ phase: "listening" });
    expect(t.session.sent).toHaveLength(LEAD_SILENCE_FRAMES);
    expect(t.session.sent.every((m) => m.type === "audio" && m.samples.every((v) => v === 0))).toBe(
      true,
    );

    const samples = new Float32Array(1600).fill(0.25);
    t.frame(samples);
    expect(t.session.sent.at(-1)).toEqual({ type: "audio", samples });

    t.session.say({ type: "partial", text: "Hello" });
    t.session.say({ type: "partial", text: "Hello world" });
    t.session.say({ type: "final", text: "Hello world.", reason: "endpoint" });
    expect(t.partials).toEqual(["Hello", "Hello world", ""]);
    expect(t.commits).toEqual(["Hello world."]);
    expect(t.dictation.state().phase).toBe("listening");

    t.session.say({ type: "partial", text: "Again" });
    t.dictation.stop();
    expect(t.capture.stop).toHaveBeenCalled();
    expect(t.session.sent.at(-1)).toEqual({ type: "stop" });
    expect(t.dictation.state().phase).toBe("stopping");
    t.session.say({ type: "final", text: " Again. ", reason: "stop" });
    expect(t.commits).toEqual(["Hello world.", "Again."]);
    expect(t.dictation.state()).toEqual({ phase: "idle" });
    expect(t.session.closed()).toBe(true);
  });

  it("says how loud the latest frame was while listening, for the bars, and nothing once stopped", async () => {
    const t = setup();
    expect(t.dictation.level()).toBe(0);
    await t.dictation.start({ modelId: "m" });
    // The lead silence the session sends itself is not the microphone.
    expect(t.dictation.level()).toBe(0);
    t.frame(new Float32Array(1600).fill(0.1));
    expect(t.dictation.level()).toBeCloseTo(0.5);
    t.frame(new Float32Array(1600));
    expect(t.dictation.level()).toBe(0);
    t.frame(new Float32Array(1600).fill(0.1));
    t.dictation.stop();
    expect(t.dictation.level()).toBe(0);
  });

  it("measures loudness as the frame's RMS, scaled so speech reaches the top", () => {
    expect(loudness(new Float32Array(0))).toBe(0);
    expect(loudness(new Float32Array(160))).toBe(0);
    expect(loudness(new Float32Array(160).fill(0.04))).toBeCloseTo(0.2);
    expect(loudness(new Float32Array(160).fill(-0.04))).toBeCloseTo(0.2);
    expect(loudness(new Float32Array(160).fill(0.9))).toBe(1);
  });

  it("throws away the partial on cancel, and an empty final commits nothing", async () => {
    const t = setup();
    await t.dictation.start({ modelId: "m" });
    t.session.say({ type: "final", text: "  ", reason: "endpoint" });
    t.session.say({ type: "partial", text: "never mind" });
    t.dictation.cancel();
    expect(t.session.sent.at(-1)).toEqual({ type: "cancel" });
    expect(t.commits).toEqual([]);
    expect(t.partials.at(-1)).toBe("");
    expect(t.session.closed()).toBe(true);
    expect(t.dictation.state()).toEqual({ phase: "idle" });
  });

  it("keeps what it showed when the last message never comes", async () => {
    vi.useFakeTimers();
    try {
      const t = setup({ stopTimeoutMs: 1000 });
      await t.dictation.start({ modelId: "m" });
      t.session.say({ type: "partial", text: "almost there" });
      t.dictation.stop();
      await vi.advanceTimersByTimeAsync(1000);
      expect(t.commits).toEqual(["almost there"]);
      expect(t.dictation.state()).toEqual({ phase: "idle" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops on the speech process's error, releasing the microphone", async () => {
    const t = setup();
    await t.dictation.start({ modelId: "m" });
    t.session.say({ type: "error", code: "crashed", message: "The speech process stopped." });
    expect(t.dictation.state()).toEqual({
      phase: "error",
      code: "crashed",
      message: "The speech process stopped.",
    });
    expect(t.capture.stop).toHaveBeenCalled();
  });

  it("says why it couldn't start: no microphone permission, no model, no device", async () => {
    const denied = setup({ requestMicrophone: async () => "denied" });
    await denied.dictation.start({ modelId: "m" });
    expect(denied.dictation.state()).toMatchObject({ phase: "error", code: "microphone-denied" });
    expect(denied.open).not.toHaveBeenCalled();

    const missing = setup({
      open: async () => ({ ok: false, code: "model-missing", message: "Not installed." }),
    });
    await missing.dictation.start({ modelId: "m" });
    expect(missing.dictation.state()).toMatchObject({ phase: "error", code: "model-missing" });

    const noDevice = setup({
      startCapture: () =>
        Promise.reject(Object.assign(new Error("none"), { name: "NotFoundError" })),
    });
    await noDevice.dictation.start({ modelId: "m" });
    expect(noDevice.dictation.state()).toEqual({
      phase: "error",
      code: "microphone-unavailable",
      message: "No microphone was found.",
    });
    expect(noDevice.session.closed()).toBe(true);
  });

  it("drops a start that a cancel overtook, closing the port it opened late", async () => {
    const late = fakePort();
    const { promise, resolve } = Promise.withResolvers<{ ok: true; port: DictationPort }>();
    let asked = false;
    const t = setup({
      open: () => {
        asked = true;
        return promise;
      },
    });
    const starting = t.dictation.start({ modelId: "m" });
    await vi.waitFor(() => expect(asked).toBe(true));
    t.dictation.cancel();
    resolve({ ok: true, port: late.port });
    await starting;
    expect(t.dictation.state()).toEqual({ phase: "idle" });
    expect(late.closed()).toBe(true);
    expect(late.sent).toEqual([]);
  });

  it("checks before anything opens, and a cancel during that check leaves the microphone off", async () => {
    const missing = setup({
      preflight: async () => ({ ok: false, code: "model-missing", message: "Not downloaded." }),
    });
    await missing.dictation.start({ modelId: "m" });
    expect(missing.dictation.state()).toMatchObject({ phase: "error", code: "model-missing" });
    expect(missing.open).not.toHaveBeenCalled();

    const { promise, resolve } = Promise.withResolvers<{ ok: true }>();
    const slow = setup({ preflight: () => promise });
    const starting = slow.dictation.start({ modelId: "m" });
    expect(slow.dictation.state().phase).toBe("starting");
    slow.dictation.cancel();
    resolve({ ok: true });
    await starting;
    expect(slow.open).not.toHaveBeenCalled();
    expect(slow.dictation.state()).toEqual({ phase: "idle" });
  });

  it("spaces dictated text after a word but not after a space or newline", () => {
    expect(spacedAfter("", "Hi.")).toBe("Hi.");
    expect(spacedAfter("Fix", "the bug.")).toBe(" the bug.");
    expect(spacedAfter("Fix ", "it.")).toBe("it.");
    expect(spacedAfter("Line\n", "Next.")).toBe("Next.");
  });
});

/** The machine over a fake clock and a dictation that is only on or off. */
const pushToTalk = () => {
  let clock = 0;
  let on = false;
  const calls: string[] = [];
  const talk = createPushToTalk({
    now: () => clock,
    active: () => on,
    toggle: () => {
      on = !on;
      calls.push(on ? "start" : "stop");
    },
    stop: () => {
      on = false;
      calls.push("stop");
    },
  });
  return { talk, calls, wait: (ms: number) => (clock += ms), on: () => on };
};

// The node environment has no `KeyboardEvent`; these are the fields a match reads.
const keyUp = (init: Partial<KeyboardEvent>) =>
  ({
    code: "",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...init,
  }) as KeyboardEvent;
describe("push to talk", () => {
  it("toggles on a tap, as before, and stops what a hold started when it's let go", () => {
    const tap = pushToTalk();
    tap.talk.press(false);
    tap.wait(HOLD_MS - 1);
    tap.talk.release();
    expect(tap.on()).toBe(true);
    tap.wait(5_000);
    tap.talk.press(false);
    tap.talk.release();
    expect(tap.calls).toEqual(["start", "stop"]);

    const hold = pushToTalk();
    hold.talk.press(false);
    expect(hold.talk.held()).toBe(true);
    hold.wait(HOLD_MS);
    hold.talk.release();
    expect(hold.calls).toEqual(["start", "stop"]);
    expect(hold.talk.held()).toBe(false);
  });

  it("ignores key repeat, and a press that stopped dictation holds nothing", () => {
    const { talk, calls, wait } = pushToTalk();
    talk.press(false);
    for (let i = 0; i < 10; i++) talk.press(true);
    wait(HOLD_MS - 1);
    talk.release();
    expect(calls).toEqual(["start"]);
    talk.press(false);
    wait(2_000);
    talk.release();
    expect(calls).toEqual(["start", "stop"]);
  });

  it("stops on a blur while held, however short, keeping what was heard; Escape lets go of it", () => {
    const blur = pushToTalk();
    blur.talk.press(false);
    blur.talk.blur();
    expect(blur.calls).toEqual(["start", "stop"]);

    const escape = pushToTalk();
    escape.talk.press(false);
    escape.wait(HOLD_MS * 2);
    // Escape cancels the dictation itself, and the release after it stops nothing more.
    escape.talk.reset();
    escape.talk.release();
    expect(escape.calls).toEqual(["start"]);
  });

  it("starts afresh on a press whose key-up never came", () => {
    const { talk, calls, wait } = pushToTalk();
    talk.press(false);
    wait(HOLD_MS - 1);
    talk.press(false);
    talk.release();
    expect(calls).toEqual(["start", "stop"]);
  });

  it("ends a hold on the chord's key or any of its modifiers coming up", () => {
    const keys = "mod+shift+space";
    const held = { metaKey: true, shiftKey: true };
    expect(releasesChord(keys, keyUp({ key: " ", code: "Space", ...held }), true)).toBe(true);
    expect(releasesChord(keys, keyUp({ key: "Meta", shiftKey: true }), true)).toBe(true);
    expect(releasesChord(keys, keyUp({ key: "Shift", metaKey: true }), true)).toBe(true);
    expect(releasesChord(keys, keyUp({ key: "Alt", ...held }), true)).toBe(false);
    expect(releasesChord(keys, keyUp({ key: "a", code: "KeyA", ...held }), true)).toBe(false);
    // The chord's key ends it with another modifier pressed on the way, or one already let go.
    const extra = { key: " ", code: "Space", ctrlKey: true, shiftKey: true, altKey: true };
    expect(releasesChord(keys, keyUp(extra), false)).toBe(true);
    expect(releasesChord(keys, keyUp({ key: " ", code: "Space" }), true)).toBe(true);
    // A chord rebound to `=` ends on the `+` its Shift types, as it starts on it.
    const plus = { key: "+", code: "Equal", ctrlKey: true, shiftKey: true };
    expect(releasesChord("mod+=", keyUp(plus), false)).toBe(true);
    expect(releasesChord("mod+=", keyUp({ key: "=", code: "Equal" }), false)).toBe(true);
    expect(releasesChord("mod+=", keyUp({ key: "-", code: "Minus" }), false)).toBe(false);
    // Off macOS, Control is `mod`, and the Windows key is no part of it.
    expect(releasesChord(keys, keyUp({ key: "Control", shiftKey: true }), false)).toBe(true);
    expect(releasesChord(keys, keyUp({ key: "Meta", ctrlKey: true, shiftKey: true }), false)).toBe(
      false,
    );
  });
});
