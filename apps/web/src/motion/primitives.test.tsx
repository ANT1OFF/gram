// @vitest-environment happy-dom
import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { domMax, LazyMotion } from "motion/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSlabHandoff } from "@/composer/slab-handoff";
import { focusWhenAble } from "@/orchestration/use-focus-on-open";
import { themeStore } from "@/theme/store";

import { arrivalsOf, useArrivals } from "./arrivals";
import { drawOn, strokeDelay } from "./draw-on";
import { DrawnCheck } from "./drawn-check";
import { expandPresence, type ExpandPresenceState } from "./expand-presence";
import { PulseOnce } from "./pulse-once";
import { SegmentSlab } from "./segment-slab";
import { SharedSlab } from "./shared-slab";
import { SlotPresence, slotMotion } from "./slot-presence";
import { clockPhase, spin, spinAngle } from "./spin";
import { RingSpinner, Spinner } from "./spinner";
import { isMarkPhase } from "./status-mark";
import { Swap, useChangeCount } from "./swap";
import { playTurnCompleteSheen, TurnCompleteSheen } from "./turn-complete-sheen";

afterEach(cleanup);

// What these primitives share is a gate: they mark a change, never what was already there when the
// screen appeared. That gate is what is tested; the movement itself is CSS.

describe("useChangeCount", () => {
  it("is zero at mount and counts each change, not each render", () => {
    const { result, rerender } = renderHook(({ value }) => useChangeCount(value), {
      initialProps: { value: "idle" },
    });
    expect(result.current).toBe(0);
    rerender({ value: "idle" });
    expect(result.current).toBe(0);
    rerender({ value: "running" });
    expect(result.current).toBe(1);
    rerender({ value: "idle" });
    expect(result.current).toBe(2);
  });
});

describe("Swap", () => {
  it("shows what is there at mount still, and animates only what replaces it", () => {
    const { rerender } = render(<Swap swapKey="copy">copy</Swap>);
    expect(screen.getByText("copy").className).not.toContain("gram-swap");
    rerender(<Swap swapKey="copied">copied</Swap>);
    expect(screen.getByText("copied").className).toContain("gram-swap");
    expect(screen.queryByText("copy")).toBeNull();
  });

  it("shows nothing without a key, and animates what then appears", () => {
    const { container, rerender } = render(<Swap swapKey={undefined}>dot</Swap>);
    expect(container.textContent).toBe("");
    rerender(<Swap swapKey="unread">dot</Swap>);
    expect(screen.getByText("dot").className).toContain("gram-swap");
  });
});

const pulses = () => screen.queryAllByTestId("pulse-once");
const checksBadge = (checks: string) => (
  <PulseOnce trigger={checks} when={checks === "passing"} tone="success" burst>
    ok
  </PulseOnce>
);

describe("PulseOnce", () => {
  it("never pulses for the state it mounted in", () => {
    render(
      <PulseOnce trigger="passing" when tone="success">
        ok
      </PulseOnce>,
    );
    expect(pulses()).toHaveLength(0);
  });

  it("pulses when the trigger changes to a value worth marking, and only then", () => {
    const { rerender } = render(checksBadge("pending"));
    rerender(checksBadge("failing"));
    expect(pulses()).toHaveLength(0);
    rerender(checksBadge("passing"));
    expect(pulses()).toHaveLength(1);
    expect(pulses()[0]?.dataset).toMatchObject({ tone: "success", burst: "true" });
    // A re-render with nothing changed keeps the same element: the ring doesn't replay.
    const ring = pulses()[0];
    rerender(checksBadge("passing"));
    expect(pulses()[0]).toBe(ring);
  });
});

describe("arrivals", () => {
  it("are the ids that weren't there, and none while the list fills from empty", () => {
    expect([...arrivalsOf(new Set(["a"]), ["a", "b", "c"])]).toEqual(["b", "c"]);
    expect(arrivalsOf(new Set(["a", "b"]), ["b"]).size).toBe(0);
    expect(arrivalsOf(new Set(), ["a", "b"]).size).toBe(0);
    // Unless the list is one that starts empty and is added to.
    expect([...arrivalsOf(new Set(), ["a"], true)]).toEqual(["a"]);
  });

  it("hold for the render that mounts the item, and clear with the next change", () => {
    const { result, rerender } = renderHook(({ ids }) => useArrivals(ids), {
      initialProps: { ids: ["a", "b"] },
    });
    expect(result.current.size).toBe(0);
    rerender({ ids: ["a", "b", "c"] });
    expect([...result.current]).toEqual(["c"]);
    // Reordering is not arriving.
    rerender({ ids: ["c", "a", "b"] });
    expect(result.current.size).toBe(0);
  });
});

describe("expandPresence", () => {
  const closed: ExpandPresenceState = { mounted: false, shown: false };
  const open: ExpandPresenceState = { mounted: true, shown: true };

  it("mounts folded, then unfolds a frame later", () => {
    const mounted = expandPresence(closed, { type: "open" });
    expect(mounted).toEqual({ mounted: true, shown: false });
    expect(expandPresence(mounted, { type: "frame" })).toEqual(open);
    // Open from the start is simply open.
    expect(expandPresence(open, { type: "open" })).toEqual(open);
  });

  it("folds before it unmounts, unless nothing animates", () => {
    const folding = expandPresence(open, { type: "close", animated: true });
    expect(folding).toEqual({ mounted: true, shown: false });
    expect(expandPresence(folding, { type: "closed" })).toEqual(closed);
    expect(expandPresence(open, { type: "close", animated: false })).toEqual(closed);
  });

  it("keeps what is mounted when reopened mid-fold", () => {
    const folding = expandPresence(open, { type: "close", animated: true });
    const reopened = expandPresence(folding, { type: "open" });
    expect(reopened).toEqual(open);
    expect(expandPresence(reopened, { type: "closed" })).toEqual(open);
  });
});

/** An input in a box, and frames that run only when the test says so. */
const setUp = (inert: boolean) => {
  const box = document.createElement("div");
  if (inert) box.setAttribute("inert", "");
  const input = document.createElement("input");
  box.append(input);
  document.body.append(box);
  let queued: (() => void)[] = [];
  const frames = { asked: 0, cancelled: 0 };
  return {
    box,
    input,
    frames,
    nextFrame: () => {
      const run = queued;
      queued = [];
      for (const callback of run) callback();
    },
    options: {
      frame: (callback: () => void) => {
        frames.asked += 1;
        queued.push(callback);
        return frames.asked;
      },
      cancelFrame: () => {
        frames.cancelled += 1;
        queued = [];
      },
    },
  };
};
/** Long enough for a `MutationObserver` to have been told. */
const observed = () => new Promise((resolve) => setTimeout(resolve, 0));

// What `ExpandPresence` does to a form that wants the focus as it opens: it is mounted under an
// `inert` box, and how long that lasts is the machine's business.
describe("focusWhenAble", () => {
  afterEach(() => document.body.replaceChildren());

  it("focuses at once what can take it, and asks for no frame", () => {
    const { input, frames, options } = setUp(false);
    focusWhenAble(input, options);
    expect(document.activeElement).toBe(input);
    expect(frames.asked).toBe(0);
  });

  it("waits out an inert ancestor however many frames it lasts, then focuses", async () => {
    const { box, input, frames, nextFrame, options } = setUp(true);
    focusWhenAble(input, options);
    for (let frame = 0; frame < 50; frame++) nextFrame();
    await observed();
    expect(document.activeElement).not.toBe(input);
    box.removeAttribute("inert");
    await observed();
    expect(document.activeElement).toBe(input);
    // The attribute was the signal; no frame was counted to guess at it.
    expect(frames.asked).toBe(0);
  });

  it("waits for each inert ancestor in turn", async () => {
    const { box, input, options } = setUp(true);
    const outer = document.createElement("section");
    outer.setAttribute("inert", "");
    document.body.append(outer);
    outer.append(box);
    focusWhenAble(input, options);
    box.removeAttribute("inert");
    await observed();
    expect(document.activeElement).not.toBe(input);
    outer.removeAttribute("inert");
    await observed();
    expect(document.activeElement).toBe(input);
  });

  it("leaves alone an element that left the page before inert was lifted", async () => {
    const { box, input, options } = setUp(true);
    const other = document.createElement("button");
    document.body.append(other);
    other.focus();
    focusWhenAble(input, options);
    input.remove();
    box.removeAttribute("inert");
    await observed();
    expect(document.activeElement).toBe(other);
  });

  it("stops watching when told to, as the hook does on unmount", async () => {
    const { box, input, options } = setUp(true);
    const stop = focusWhenAble(input, options);
    stop();
    box.removeAttribute("inert");
    await observed();
    expect(document.activeElement).not.toBe(input);
  });

  it("tries a focus that didn't hold again on the next frame, a bounded number of times", () => {
    const { input, frames, nextFrame, options } = setUp(false);
    // Something else keeps the focus for two frames, as a closing menu handing it back would.
    let refusals = 2;
    const focus = input.focus.bind(input);
    input.focus = () => {
      if (refusals > 0) refusals -= 1;
      else focus();
    };
    focusWhenAble(input, { ...options, attempts: 5 });
    expect(document.activeElement).not.toBe(input);
    nextFrame();
    expect(document.activeElement).not.toBe(input);
    nextFrame();
    expect(document.activeElement).toBe(input);
    expect(frames.asked).toBe(2);

    const never = setUp(false);
    never.input.focus = () => {};
    focusWhenAble(never.input, { ...never.options, attempts: 5 });
    for (let frame = 0; frame < 20; frame++) never.nextFrame();
    // The first try and four more; the fifth failure asks for nothing further.
    expect(never.frames.asked).toBe(4);
  });
});

describe("spin", () => {
  it("steps every spinner through one angle, a turn a second", () => {
    expect([0, 49, 50, 250, 999, 1000, 1275].map(spinAngle)).toEqual([0, 0, 18, 90, 342, 0, 90]);
  });

  it("steps a longer cycle's phase on the same clock", () => {
    expect([0, 49, 500, 1999, 2000, 2525].map((now) => clockPhase(now, 2000))).toEqual([
      0, 0, 0.25, 0.975, 0, 0.25,
    ]);
  });

  it("runs one timer while a spinner is on screen, the window shown and motion Full", async () => {
    let report: ((entries: { target: Element; isIntersecting: boolean }[]) => void) | undefined;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: typeof report) {
          report = callback;
        }
        observe() {}
        unobserve() {}
      },
    );
    vi.useFakeTimers();
    const root = document.documentElement;
    root.setAttribute("data-motion", "full");
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    try {
      const { rerender, unmount } = render(
        <>
          <span data-testid="a" ref={spin} />
          <span data-testid="b" ref={spin} />
        </>,
      );
      const a = screen.getByTestId("a");
      const b = screen.getByTestId("b");
      // Nothing turns until it is seen.
      expect(vi.getTimerCount()).toBe(0);
      report!([
        { target: a, isIntersecting: true },
        { target: b, isIntersecting: false },
      ]);
      expect(vi.getTimerCount()).toBe(1);
      const first = a.style.rotate;
      vi.advanceTimersByTime(50);
      expect(a.style.rotate).not.toBe(first);
      expect(b.style.rotate).toBe("");
      report!([{ target: b, isIntersecting: true }]);
      vi.advanceTimersByTime(50);
      expect(b.style.rotate).toBe(a.style.rotate);

      hidden.mockReturnValue(true);
      document.dispatchEvent(new Event("visibilitychange"));
      expect(vi.getTimerCount()).toBe(0);
      hidden.mockReturnValue(false);
      document.dispatchEvent(new Event("visibilitychange"));
      expect(vi.getTimerCount()).toBe(1);

      root.setAttribute("data-motion", "off");
      // The attribute is watched with a MutationObserver, whose callback is a microtask.
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(0);
      expect(a.style.rotate).toBe("");
      root.setAttribute("data-motion", "full");
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(1);

      report!([{ target: a, isIntersecting: false }]);
      expect(vi.getTimerCount()).toBe(1);
      rerender(<span data-testid="a" />);
      expect(vi.getTimerCount()).toBe(0);
      expect(screen.getByTestId("a").style.rotate).toBe("");
      unmount();
    } finally {
      hidden.mockRestore();
      root.removeAttribute("data-motion");
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("draws a RingSpinner as a faint track and one arc, turning only under Full motion", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    vi.useFakeTimers();
    const root = document.documentElement;
    root.setAttribute("data-motion", "full");
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    try {
      const { unmount } = render(
        <RingSpinner data-testid="r" role="img" aria-label="Checks running" />,
      );
      const icon = screen.getByTestId("r");
      expect(icon.getAttribute("aria-label")).toBe("Checks running");
      expect(icon.getAttribute("stroke-width")).toBe("1.5");
      const track = icon.querySelector("circle");
      const arc = icon.querySelector("path");
      expect(track?.getAttribute("opacity")).toBe("0.25");
      expect(track?.getAttribute("vector-effect")).toBe("non-scaling-stroke");
      expect(arc?.getAttribute("d")).toBe("M12 2a10 10 0 0 1 10 10");
      expect(arc?.getAttribute("vector-effect")).toBe("non-scaling-stroke");
      expect(vi.getTimerCount()).toBe(1);
      const first = icon.style.rotate;
      vi.advanceTimersByTime(50);
      expect(icon.style.rotate).not.toBe(first);
      // One turn is a second: twenty steps of 18 degrees.
      vi.advanceTimersByTime(950);
      expect(icon.style.rotate).toBe(first);

      root.setAttribute("data-motion", "reduced");
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(0);
      expect(icon.style.rotate).toBe("");
      unmount();
    } finally {
      hidden.mockRestore();
      root.removeAttribute("data-motion");
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("turns a Spinner wherever it is drawn, with no ref asked of the caller", () => {
    // Without an observer every spinner counts as on screen, so what is left to test is the clock.
    vi.stubGlobal("IntersectionObserver", undefined);
    vi.useFakeTimers();
    const root = document.documentElement;
    root.setAttribute("data-motion", "full");
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    try {
      const ref = createRef<SVGSVGElement>();
      const { unmount } = render(<Spinner data-testid="s" ref={ref} />);
      const icon = screen.getByTestId("s");
      expect(ref.current).toBe(icon);
      expect(vi.getTimerCount()).toBe(1);
      const first = icon.style.rotate;
      vi.advanceTimersByTime(50);
      expect(icon.style.rotate).not.toBe(first);
      unmount();
      expect(vi.getTimerCount()).toBe(0);
      expect(ref.current).toBeNull();
    } finally {
      hidden.mockRestore();
      root.removeAttribute("data-motion");
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("leaves a status mark's arc where it stopped, so it closes into the check in place", async () => {
    let report: ((entries: { target: Element; isIntersecting: boolean }[]) => void) | undefined;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: typeof report) {
          report = callback;
        }
        observe() {}
        unobserve() {}
      },
    );
    vi.useFakeTimers();
    const root = document.documentElement;
    root.setAttribute("data-motion", "full");
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    // A fresh clock, so its observer is this stub rather than one an earlier test made.
    vi.resetModules();
    const { StatusMark } = await import("./status-mark");
    try {
      const { container, rerender } = render(<StatusMark phase="running" />);
      const ring = container.querySelector<SVGElement>(".gram-mark-ring")!;
      report!([{ target: ring, isIntersecting: true }]);
      vi.advanceTimersByTime(250);
      const angle = ring.style.rotate;
      expect(angle).not.toBe("");
      rerender(<StatusMark phase="done" />);
      expect(container.querySelector("svg")!.dataset["phase"]).toBe("done");
      expect(vi.getTimerCount()).toBe(0);
      expect(ring.style.rotate).toBe(angle);
    } finally {
      hidden.mockRestore();
      root.removeAttribute("data-motion");
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("draws a status mark only for the phases it knows", () => {
    expect(["todo", "pending", "running", "active", "done", "error"].every(isMarkPhase)).toBe(true);
    expect(["awaiting", "denied", "cancelled"].some(isMarkPhase)).toBe(false);
  });

  it("is how every spinner turns: none is left on a CSS spin", () => {
    // A CSS spinner can't tell it is off screen or the window hidden, and a stalled request keeps
    // one drawing at 60 frames a second for as long as it waits.
    const sources = import.meta.glob<string>(["../**/*.ts", "../**/*.tsx", "!../**/*.test.*"], {
      query: "?raw",
      import: "default",
      eager: true,
    });
    const css = Object.entries(sources)
      .filter(([, text]) => text.includes("animate-spin"))
      .map(([file]) => file);
    expect(css).toEqual([]);
  });
});

describe("Shimmer", () => {
  it("moves its band on the shared clock while active, and holds it when not", async () => {
    let report: ((entries: { target: Element; isIntersecting: boolean }[]) => void) | undefined;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: typeof report) {
          report = callback;
        }
        observe() {}
        unobserve() {}
      },
    );
    vi.useFakeTimers();
    const root = document.documentElement;
    root.setAttribute("data-motion", "full");
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    // A fresh clock, so its observer is this stub rather than one an earlier test made.
    vi.resetModules();
    const { Shimmer } = await import("./shimmer");
    try {
      const { rerender, unmount } = render(<Shimmer>Thinking…</Shimmer>);
      const label = screen.getByText("Thinking…");
      report!([{ target: label, isIntersecting: true }]);
      expect(vi.getTimerCount()).toBe(1);
      const first = label.style.backgroundPositionX;
      vi.advanceTimersByTime(400);
      expect(label.style.backgroundPositionX).not.toBe(first);
      rerender(<Shimmer active={false}>Thinking…</Shimmer>);
      expect(vi.getTimerCount()).toBe(0);
      expect(label.style.backgroundPositionX).toBe("");
      unmount();
    } finally {
      hidden.mockRestore();
      root.removeAttribute("data-motion");
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

const sheenSurface = () => screen.getByTestId("sheen-surface");
const sheenView = (status: Parameters<typeof TurnCompleteSheen>[0]["status"]) => (
  <TurnCompleteSheen status={status}>
    <div data-testid="sheen-surface" data-surface="composer" />
  </TurnCompleteSheen>
);

describe("TurnCompleteSheen", () => {
  const cancel = vi.fn();
  const animation = { cancel, onfinish: null as (() => void) | null };
  const animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => animation);
  let intersect: ((entries: { isIntersecting: boolean }[]) => void) | undefined;
  let visible = true;

  beforeEach(() => {
    visible = true;
    animate.mockClear();
    cancel.mockClear();
    themeStore.setState({ motion: "system" });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      top: 10,
      bottom: 110,
      left: 10,
      right: 510,
    } as DOMRect);
    vi.spyOn(HTMLElement.prototype, "checkVisibility").mockImplementation(() => visible);
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: typeof intersect) {
          intersect = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    // happy-dom has no Web Animations implementation; capture what the browser is asked to play.
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  });
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(HTMLElement.prototype, "animate");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    themeStore.setState({ motion: "system" });
  });

  it.each(["needsApproval", "needsInput"] as const)(
    "does not mark an idle thread's %s request as a completed turn",
    (waiting) => {
      const { rerender } = render(sheenView("idle"));
      rerender(sheenView(waiting));
      rerender(sheenView("idle"));
      expect(animate).not.toHaveBeenCalled();
    },
  );

  it.each(["needsApproval", "needsInput"] as const)(
    "does not mark a request mounted in %s as a completed turn",
    (waiting) => {
      const { rerender } = render(sheenView(waiting));
      rerender(sheenView("idle"));
      expect(animate).not.toHaveBeenCalled();
    },
  );

  it.each(["cold", "starting", "error", "ended"] as const)(
    "discards the running turn when it becomes %s",
    (status) => {
      const { rerender } = render(sheenView("running"));
      rerender(sheenView(status));
      rerender(sheenView("needsApproval"));
      rerender(sheenView("idle"));
      expect(animate).not.toHaveBeenCalled();
    },
  );

  it("plays once for a live completion, removes the overlay, and never replays an idle render", () => {
    const { rerender } = render(sheenView("idle"));
    expect(animate).not.toHaveBeenCalled();
    rerender(sheenView("running"));
    rerender(sheenView("needsApproval"));
    rerender(sheenView("needsInput"));
    expect(animate).not.toHaveBeenCalled();
    rerender(sheenView("idle"));
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.calls[0]?.[1]).toMatchObject({ iterations: 1 });
    expect(screen.getByTestId("turn-complete-sheen").getAttribute("aria-hidden")).toBe("true");
    animation.onfinish?.();
    expect(screen.queryByTestId("turn-complete-sheen")).toBeNull();
    rerender(sheenView("idle"));
    expect(animate).toHaveBeenCalledTimes(1);
    rerender(sheenView("needsApproval"));
    rerender(sheenView("idle"));
    expect(animate).toHaveBeenCalledTimes(1);
    rerender(sheenView("error"));
    rerender(sheenView("idle"));
    expect(animate).toHaveBeenCalledTimes(1);
  });

  it("fades only in Reduced and creates nothing in Off", () => {
    render(sheenView("idle"));
    const stop = playTurnCompleteSheen(sheenSurface(), "reduced");
    expect(animate.mock.calls[0]?.[0]).toEqual([{ opacity: 0 }, { opacity: 0.5 }, { opacity: 0 }]);
    stop();
    playTurnCompleteSheen(sheenSurface(), "off");
    expect(animate).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("turn-complete-sheen")).toBeNull();
  });

  it("discards hidden completions and cancels a pass when its pane leaves view", () => {
    const { rerender } = render(sheenView("running"));
    visible = false;
    rerender(sheenView("idle"));
    visible = true;
    rerender(sheenView("idle"));
    expect(animate).not.toHaveBeenCalled();
    rerender(sheenView("running"));
    rerender(sheenView("idle"));
    intersect?.([{ isIntersecting: false }]);
    expect(cancel).toHaveBeenCalled();
    expect(screen.queryByTestId("turn-complete-sheen")).toBeNull();
    intersect?.([{ isIntersecting: true }]);
    expect(animate).toHaveBeenCalledTimes(1);
  });

  it("cancels when the window is hidden or motion turns off, without replaying on return", () => {
    const { rerender } = render(sheenView("running"));
    rerender(sheenView("idle"));
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(screen.queryByTestId("turn-complete-sheen")).toBeNull();
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(animate).toHaveBeenCalledTimes(1);
    rerender(sheenView("running"));
    rerender(sheenView("idle"));
    themeStore.setState({ motion: "off" });
    rerender(sheenView("idle"));
    expect(screen.queryByTestId("turn-complete-sheen")).toBeNull();
    themeStore.setState({ motion: "system" });
    rerender(sheenView("idle"));
    expect(animate).toHaveBeenCalledTimes(2);
  });
});

describe("SharedSlab", () => {
  afterEach(() => themeStore.setState({ motion: themeStore.getInitialState().motion }));

  it("arrives at once, unmoved, when motion is off", () => {
    themeStore.setState({ motion: "off" });
    const onArrived = vi.fn();
    render(
      <SharedSlab data-testid="slab" from={{ x: 0, y: 400 }} onArrived={onArrived}>
        prompt
      </SharedSlab>,
    );
    expect(onArrived).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("slab").style.transform).toBe("");
  });

  it("just sits without an origin", () => {
    const onArrived = vi.fn();
    render(<SharedSlab onArrived={onArrived}>prompt</SharedSlab>);
    expect(onArrived).not.toHaveBeenCalled();
  });

  it("hands one thread the move, and drops it if the composer never takes it", () => {
    vi.useFakeTimers();
    const { hand, done } = useSlabHandoff.getState();
    hand("t-new" as never, { x: 10, y: 20 });
    expect(useSlabHandoff.getState()).toMatchObject({ threadId: "t-new", from: { x: 10, y: 20 } });
    done();
    expect(useSlabHandoff.getState().threadId).toBeUndefined();
    hand("t-new" as never, { x: 10, y: 20 });
    vi.advanceTimersByTime(3000);
    expect(useSlabHandoff.getState().from).toBeUndefined();
    vi.useRealTimers();
  });
});

const stopSlot = (shown: boolean) => (
  <LazyMotion features={domMax}>
    <SlotPresence shown={shown}>
      <button type="button">Stop</button>
    </SlotPresence>
  </LazyMotion>
);

describe("SlotPresence", () => {
  afterEach(() => themeStore.setState({ motion: themeStore.getInitialState().motion }));
  const snappy = { type: "spring", stiffness: 700 } as const;

  it("opens and settles under Full, only fades under Reduced, and is instant under Off", () => {
    expect(slotMotion("full", 6, snappy)).toEqual({
      closed: { opacity: 0, width: 0, scale: 0.6, marginInlineEnd: -6 },
      transition: snappy,
    });
    const reduced = slotMotion("reduced", 6, snappy);
    expect(reduced.closed).toMatchObject({ scale: 1 });
    expect(reduced.transition).toEqual({
      duration: 0.12,
      width: { duration: 0 },
      marginInlineEnd: { duration: 0 },
    });
    expect(slotMotion("off", 6, snappy).transition).toMatchObject({ duration: 0 });
  });

  it("shows what is there at mount as it is, and takes it away when hidden", async () => {
    themeStore.setState({ motion: "off" });
    const { rerender } = render(
      <SlotPresence shown>
        <button type="button">Stop</button>
      </SlotPresence>,
    );
    const slot = screen.getByRole("button", { name: "Stop" }).parentElement!;
    expect(slot.style.opacity).not.toBe("0");
    rerender(
      <SlotPresence shown={false}>
        <button type="button">Stop</button>
      </SlotPresence>,
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop" })).toBeNull());
  });

  it("is inert while it leaves, so a press meant for its neighbour can't land on it", () => {
    themeStore.setState({ motion: "system" });
    const { rerender } = render(stopSlot(true));
    const leaving = screen.getByRole("button", { name: "Stop" }).parentElement!;
    expect(leaving.inert).toBe(false);
    rerender(stopSlot(false));
    expect(leaving.isConnected).toBe(true);
    expect(leaving.inert).toBe(true);
  });
});

const Segments = ({ value }: { value: string }) => (
  <div role="radiogroup" className="isolate flex">
    {["status", "project"].map((option) => (
      <button key={option} type="button" role="radio" aria-checked={option === value}>
        {option === value && <SegmentSlab group="g" />}
        {option}
      </button>
    ))}
  </div>
);

describe("SegmentSlab", () => {
  it("sits under the selected segment only, and follows the selection", () => {
    const { rerender } = render(<Segments value="status" />);
    expect(screen.getAllByTestId("segment-slab")).toHaveLength(1);
    expect(
      screen.getByRole("radio", { name: "status" }).contains(screen.getByTestId("segment-slab")),
    ).toBe(true);
    rerender(<Segments value="project" />);
    expect(screen.getAllByTestId("segment-slab")).toHaveLength(1);
    expect(
      screen.getByRole("radio", { name: "project" }).contains(screen.getByTestId("segment-slab")),
    ).toBe(true);
  });

  it("is hidden from assistive tech, which reads the selection from aria-checked", () => {
    render(<Segments value="status" />);
    expect(screen.getByTestId("segment-slab").getAttribute("aria-hidden")).toBe("true");
  });
});

describe("DrawnCheck", () => {
  it("draws one stroke as it mounts, and takes an icon's size for Streamdown", () => {
    const { container, rerender } = render(<DrawnCheck />);
    expect(container.querySelectorAll("path.gram-draw")).toHaveLength(1);
    expect(container.querySelector("svg")!.getAttribute("class")).toContain("size-4");
    rerender(<DrawnCheck size={14} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("14");
    expect(svg.getAttribute("class")).not.toContain("size-4");
  });
});

describe("drawOn", () => {
  it("draws each stroke of an icon as one unit, one after another, and no slower for a busy icon", () => {
    const { container } = render(
      <svg ref={drawOn}>
        <path d="M0 0h1" />
        <circle r="1" />
        <line x2="1" />
        <rect width="1" height="1" />
        <polyline points="0 0 1 1" />
        <path d="M1 1h1" />
      </svg>,
    );
    const shapes = [
      ...container.querySelectorAll<SVGElement>("path, circle, line, rect, polyline"),
    ];
    expect(shapes.every((shape) => shape.getAttribute("pathLength") === "1")).toBe(true);
    expect(shapes.every((shape) => shape.classList.contains("gram-draw"))).toBe(true);
    expect(shapes.map((shape) => shape.style.animationDelay)).toEqual([
      "0ms",
      "40ms",
      "80ms",
      "120ms",
      "160ms",
      "160ms",
    ]);
    expect(strokeDelay(20)).toBe(160);
  });
});

describe("LevelBars", () => {
  it("follows the loudness on the shared clock, and stands at rest when it stops", async () => {
    let report: ((entries: { target: Element; isIntersecting: boolean }[]) => void) | undefined;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: typeof report) {
          report = callback;
        }
        observe() {}
        unobserve() {}
      },
    );
    vi.useFakeTimers();
    const root = document.documentElement;
    root.setAttribute("data-motion", "full");
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    // A fresh clock, so its observer is this stub rather than one an earlier test made.
    vi.resetModules();
    const { LevelBars } = await import("./level-bars");
    try {
      let level = 0;
      const { unmount } = render(<LevelBars level={() => level} />);
      const svg = screen.getByTestId("level-bars");
      const middle = svg.querySelectorAll<SVGElement>(".gram-level-bar")[1]!;
      report!([{ target: svg, isIntersecting: true }]);
      expect(vi.getTimerCount()).toBe(1);
      // Silence holds the bars where they rest.
      vi.advanceTimersByTime(100);
      expect(middle.style.scale).toBe("1 0.7");
      level = 1;
      vi.advanceTimersByTime(250);
      expect(Number(middle.style.scale.split(" ")[1])).toBeGreaterThan(0.95);
      root.setAttribute("data-motion", "reduced");
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(0);
      expect(middle.style.scale).toBe("");
      unmount();
    } finally {
      hidden.mockRestore();
      root.removeAttribute("data-motion");
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
