import type { SpeechClientMessage, SpeechServerMessage } from "@gram/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createModifierHold,
  createPushToTalk,
  DOUBLE_TAP_MS,
  HOLD_MS,
  releasesChord,
} from "./push-to-talk";
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
  const order: string[] = [];
  const capture = {
    flush: vi.fn(async () => {
      order.push("flush");
    }),
    stop: vi.fn(() => {
      order.push("capture stopped");
    }),
  };
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
      stopTailMs: 0,
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
    order,
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
    expect(t.dictation.state().phase).toBe("stopping");
    await vi.waitFor(() => expect(t.session.sent.at(-1)).toEqual({ type: "stop" }));
    expect(t.capture.stop).toHaveBeenCalled();
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
      await vi.advanceTimersByTimeAsync(0);
      expect(t.commits).toEqual([]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(t.commits).toEqual(["almost there"]);
      expect(t.dictation.state()).toEqual({ phase: "idle" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps capturing past a stop, takes the short last frame, and only then says stop", async () => {
    vi.useFakeTimers();
    try {
      const t = setup({ stopTailMs: 200 });
      await t.dictation.start({ modelId: "m" });
      t.frame(new Float32Array(1600).fill(0.1));
      const beforeStop = t.session.sent.length;

      t.dictation.stop();
      // The status changes on the release; the microphone doesn't.
      expect(t.dictation.state().phase).toBe("stopping");
      expect(t.dictation.level()).toBe(0);
      await vi.advanceTimersByTimeAsync(199);
      t.frame(new Float32Array(1600).fill(0.2));
      expect(t.dictation.level()).toBe(0);
      expect(t.session.sent).toHaveLength(beforeStop + 1);
      expect(t.capture.flush).not.toHaveBeenCalled();
      expect(t.capture.stop).not.toHaveBeenCalled();

      t.capture.flush.mockImplementationOnce(async () => {
        t.order.push("flush");
        t.frame(new Float32Array(40).fill(0.3));
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(t.session.sent.at(-2)).toMatchObject({ type: "audio", samples: { length: 40 } });
      expect(t.session.sent.at(-1)).toEqual({ type: "stop" });
      expect(t.order).toEqual(["flush", "capture stopped"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives Escape no tail, even one that comes during a stop's", async () => {
    vi.useFakeTimers();
    try {
      const during = setup({ stopTailMs: 200 });
      await during.dictation.start({ modelId: "m" });
      during.dictation.stop();
      await vi.advanceTimersByTimeAsync(100);
      during.dictation.cancel();
      expect(during.capture.stop).toHaveBeenCalledOnce();
      expect(during.session.sent.at(-1)).toEqual({ type: "cancel" });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(during.capture.flush).not.toHaveBeenCalled();
      expect(during.session.sent.some((m) => m.type === "stop")).toBe(false);
      expect(during.dictation.state()).toEqual({ phase: "idle" });

      const direct = setup({ stopTailMs: 200 });
      await direct.dictation.start({ modelId: "m" });
      direct.dictation.cancel();
      expect(direct.capture.stop).toHaveBeenCalledOnce();
      expect(direct.capture.flush).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops at once when a stop overtakes the start: a tap that never got to listen", async () => {
    const { promise, resolve } = Promise.withResolvers<{ ok: true }>();
    const t = setup({ preflight: () => promise, stopTailMs: 200 });
    const starting = t.dictation.start({ modelId: "m" });
    t.dictation.stop();
    expect(t.dictation.state()).toEqual({ phase: "idle" });
    resolve({ ok: true });
    await starting;
    expect(t.open).not.toHaveBeenCalled();
  });

  it("commits a pause heard during the tail, and an error then ends it", async () => {
    vi.useFakeTimers();
    try {
      const t = setup({ stopTailMs: 200 });
      await t.dictation.start({ modelId: "m" });
      t.dictation.stop();
      t.session.say({ type: "final", text: "Before the end.", reason: "endpoint" });
      expect(t.commits).toEqual(["Before the end."]);
      expect(t.dictation.state().phase).toBe("stopping");

      t.session.say({ type: "error", code: "crashed", message: "The speech process stopped." });
      expect(t.dictation.state().phase).toBe("error");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(t.capture.flush).not.toHaveBeenCalled();
      expect(t.dictation.state().phase).toBe("error");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a second stop during the tail, and a cancel while the flush is out wins", async () => {
    vi.useFakeTimers();
    try {
      const { promise, resolve } = Promise.withResolvers<void>();
      const t = setup({ stopTailMs: 200 });
      await t.dictation.start({ modelId: "m" });
      t.capture.flush.mockReturnValueOnce(promise);
      t.dictation.stop();
      await vi.advanceTimersByTimeAsync(100);
      t.dictation.stop();
      await vi.advanceTimersByTimeAsync(100);
      expect(t.capture.flush).toHaveBeenCalledOnce();
      t.dictation.cancel();
      resolve();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(t.session.sent.some((m) => m.type === "stop")).toBe(false);
      expect(t.capture.stop).toHaveBeenCalledOnce();
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

  it("runs the microphone while the session opens, keeping what it hears until the port is there", async () => {
    const { promise, resolve } = Promise.withResolvers<{ ok: true; port: DictationPort }>();
    const session = fakePort();
    let frame: ((samples: Float32Array) => void) | undefined;
    const t = setup({
      open: () => promise,
      startCapture: async (onFrame) => {
        frame = onFrame;
        onFrame(new Float32Array(1600).fill(0.1));
        return { flush: async () => {}, stop: () => {} };
      },
    });
    const starting = t.dictation.start({ modelId: "m" });
    await vi.waitFor(() => expect(frame).toBeDefined());
    frame!(new Float32Array(1600).fill(0.2));
    expect(t.dictation.state().phase).toBe("starting");
    expect(t.dictation.level()).toBe(0);

    resolve({ ok: true, port: session.port });
    await starting;
    const levels = session.sent.flatMap((m) => (m.type === "audio" ? [m.samples[0]] : []));
    expect(levels).toEqual([
      ...Array.from({ length: LEAD_SILENCE_FRAMES }, () => 0),
      expect.closeTo(0.1),
      expect.closeTo(0.2),
    ]);
    expect(t.dictation.state().phase).toBe("listening");
  });

  it("lets go of the microphone at once when a cancel overtakes a session still opening", async () => {
    const { promise, resolve } = Promise.withResolvers<{ ok: true; port: DictationPort }>();
    const late = fakePort();
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
    await vi.waitFor(() => expect(t.capture.stop).toHaveBeenCalledOnce());
    resolve({ ok: true, port: late.port });
    await starting;
    expect(late.closed()).toBe(true);
    expect(t.dictation.state()).toEqual({ phase: "idle" });
  });

  it("releases each side when the other fails: the microphone on a refused open, the port on a dead mic", async () => {
    const refused = setup({
      open: async () => ({ ok: false, code: "model-missing", message: "Not installed." }),
    });
    await refused.dictation.start({ modelId: "m" });
    expect(refused.capture.stop).toHaveBeenCalledOnce();
    expect(refused.dictation.state()).toMatchObject({ phase: "error", code: "model-missing" });

    const dead = setup({
      startCapture: () =>
        Promise.reject(Object.assign(new Error("no"), { name: "NotAllowedError" })),
    });
    await dead.dictation.start({ modelId: "m" });
    expect(dead.session.closed()).toBe(true);
    expect(dead.dictation.state()).toMatchObject({ phase: "error", code: "microphone-denied" });
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

/** The modifier-alone machine over a fake clock, with dictation as calls and an on/off state. */
const modifierHold = () => {
  vi.useFakeTimers();
  let on = false;
  const calls: string[] = [];
  const hold = createModifierHold({
    now: () => performance.now(),
    active: () => on,
    start: () => {
      on = true;
      calls.push("start");
    },
    confirm: () => calls.push("confirm"),
    stop: () => {
      on = false;
      calls.push("stop");
    },
    cancel: () => {
      on = false;
      calls.push("cancel");
    },
  });
  return {
    hold,
    calls,
    wait: (ms: number) => vi.advanceTimersByTime(ms),
    on: () => on,
    /** Dictation started elsewhere, by the mic button. */
    clicked: () => (on = true),
  };
};

describe("one modifier held alone", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts at the press, confirms once held long enough, and stops on release", () => {
    const { hold, calls, wait } = modifierHold();
    hold.down(false);
    expect(calls).toEqual(["start"]);
    wait(HOLD_MS - 1);
    expect(calls).toEqual(["start"]);
    wait(1);
    expect(calls).toEqual(["start", "confirm"]);
    hold.down(true);
    wait(2_000);
    hold.up();
    expect(calls).toEqual(["start", "confirm", "stop"]);
  });

  it("throws away a tap, silently, and anything held with another key, so shortcuts still work", () => {
    const tap = modifierHold();
    tap.hold.down(false);
    tap.wait(HOLD_MS - 1);
    tap.hold.up();
    expect(tap.calls).toEqual(["start", "cancel"]);

    const chord = modifierHold();
    chord.hold.down(false);
    chord.wait(50);
    chord.hold.other();
    chord.wait(1_000);
    chord.hold.up();
    expect(chord.calls).toEqual(["start", "cancel"]);
    // Another key after the hold has confirmed still makes it a shortcut, thrown away.
    const long = modifierHold();
    long.hold.down(false);
    long.wait(HOLD_MS * 2);
    long.hold.other();
    long.hold.up();
    expect(long.calls).toEqual(["start", "confirm", "cancel"]);
  });

  it("locks on a double tap, and the next press stops it", () => {
    const { hold, calls, wait, on } = modifierHold();
    hold.down(false);
    wait(80);
    hold.up();
    wait(DOUBLE_TAP_MS - 80);
    hold.down(false);
    wait(80);
    hold.up();
    expect(calls).toEqual(["start", "cancel", "start", "confirm"]);
    wait(10_000);
    expect(on()).toBe(true);
    hold.down(false);
    expect(calls.at(-1)).toBe("stop");
    hold.up();
    expect(calls).toHaveLength(5);
  });

  it("doesn't lock on taps too far apart, or on a tap after a shortcut", () => {
    const apart = modifierHold();
    apart.hold.down(false);
    apart.hold.up();
    apart.wait(DOUBLE_TAP_MS + 1);
    apart.hold.down(false);
    apart.hold.up();
    expect(apart.calls).toEqual(["start", "cancel", "start", "cancel"]);

    const shortcut = modifierHold();
    shortcut.hold.down(false);
    shortcut.hold.up();
    shortcut.hold.other();
    shortcut.hold.down(false);
    shortcut.hold.up();
    expect(shortcut.calls).toEqual(["start", "cancel", "start", "cancel"]);
  });

  it("stops what the mic button started, and a blur keeps a hold but drops a tap", () => {
    const running = modifierHold();
    running.hold.down(false);
    running.wait(HOLD_MS);
    running.hold.blur();
    expect(running.calls).toEqual(["start", "confirm", "stop"]);

    const short = modifierHold();
    short.hold.down(false);
    short.hold.blur();
    expect(short.calls).toEqual(["start", "cancel"]);

    const button = modifierHold();
    button.clicked();
    button.hold.down(false);
    button.wait(HOLD_MS * 2);
    button.hold.up();
    expect(button.calls).toEqual(["stop"]);
  });

  it("lets go of a press that Escape discarded: its release does nothing", () => {
    const { hold, calls, wait } = modifierHold();
    hold.down(false);
    wait(HOLD_MS);
    hold.reset();
    hold.up();
    expect(calls).toEqual(["start", "confirm"]);
  });
});
