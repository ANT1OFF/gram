import { readFileSync } from "node:fs";

import { LOOKS } from "@gram/themes";
import { describe, expect, it } from "vitest";

import { barScale } from "./level-bars";
import { glides, REPEAT_MS } from "./list-highlight";
import { initialSegments, nextSegments } from "./streaming-text";
import { stepsEasing, toTransition } from "./transitions";

describe("stepsEasing", () => {
  it("matches CSS steps(4, end)", () => {
    const ease = stepsEasing(4, "end");
    expect([0, 0.2, 0.26, 0.74, 0.99, 1].map(ease)).toEqual([0, 0, 0.25, 0.5, 0.75, 1]);
  });

  it("matches CSS steps(3, jump-none)", () => {
    const ease = stepsEasing(3, "jump-none");
    expect([0.1, 0.5, 0.9, 1].map(ease)).toEqual([0, 0.5, 1, 1]);
  });
});

describe("toTransition", () => {
  it("maps springs and stepped tweens", () => {
    expect(toTransition(LOOKS.glass.motion.springs.snappy, "full")).toMatchObject({
      type: "spring",
    });
    const terminal = toTransition(
      { type: "tween", duration: 120, easing: { type: "steps", count: 4, position: "end" } },
      "full",
    );
    expect(terminal).toMatchObject({ type: "tween", duration: 0.12 });
    expect(typeof (terminal as { ease: unknown }).ease).toBe("function");
  });

  it("is instant when motion is off", () => {
    expect(toTransition(LOOKS.glass.motion.springs.bouncy, "off")).toEqual({ duration: 0 });
  });
});

describe("nextSegments", () => {
  it("adds appended text as an animated segment", () => {
    let state = initialSegments("Hello");
    state = nextSegments(state, "Hello, wor");
    state = nextSegments(state, "Hello, world");
    expect(state).toEqual({
      text: "Hello, world",
      head: "Hello",
      segments: [
        { start: 5, text: ", wor" },
        { start: 10, text: "ld" },
      ],
    });
  });

  it("returns the same object when nothing changed", () => {
    const state = initialSegments("a");
    expect(nextSegments(state, "a")).toBe(state);
  });

  it("settles non-append changes", () => {
    const state = nextSegments(initialSegments("abc"), "abcd");
    expect(nextSegments(state, "xyz")).toEqual(initialSegments("xyz"));
  });

  it("folds old segments into the head", () => {
    let state = initialSegments("");
    for (const ch of "abcdef") state = nextSegments(state, state.text + ch, 3);
    expect(state.head).toBe("abc");
    expect(state.segments.map((s) => s.text)).toEqual(["d", "e", "f"]);
  });
});

describe("the shimmer's CSS", () => {
  it("lights only the glyphs: its gradient is clipped to the text, with no overlay box", () => {
    // An overlay over the span's box showed as a rectangle sweeping across the label.
    const css = readFileSync(new URL("../styles/motion.css", import.meta.url), "utf8");
    const rules = css.match(/[^{}]*\.gram-shimmer[^{}]*\{[^}]*\}/g) ?? [];
    expect(rules.some((rule) => rule.includes("::after") || rule.includes("::before"))).toBe(false);
    const lit = rules.find((rule) => rule.includes("background-image"));
    expect(lit).toContain("background-clip: text");
    expect(lit).toContain("-webkit-background-clip: text");
    expect(lit).toContain("-webkit-text-fill-color: transparent");
    expect(lit).toContain('[data-motion="full"]');
    // Forced colours drop background images, so the fill has to come back or the label vanishes.
    expect(css).toMatch(
      /@media \(forced-colors: active\) \{[^}]*\.gram-shimmer[^}]*-webkit-text-fill-color: currentColor/,
    );
  });
});

describe("the segment slab's CSS", () => {
  it("outlines the selection under forced colours, which drop the slab's background", () => {
    const css = readFileSync(new URL("../styles/motion.css", import.meta.url), "utf8");
    expect(css).toMatch(
      /@media \(forced-colors: active\) \{\s*\.gram-segment-slab \{[^}]*outline: 1px solid Highlight/,
    );
  });
});

describe("the draw-on's CSS", () => {
  const css = readFileSync(new URL("../styles/motion.css", import.meta.url), "utf8");

  it("rests drawn, so Off, which drops every animation, still shows the whole check", () => {
    expect(css).toMatch(
      /\.gram-draw \{[^}]*stroke-dashoffset: 0;[^}]*animation: gram-draw calc\(var\(--dur-move-/,
    );
    expect(css).toMatch(/\[data-motion="reduced"\] \.gram-draw \{[^}]*gram-fade-in/);
    expect(css).toMatch(
      /\[data-motion="reduced"\] \.gram-draw \{[^}]*animation-delay: 0s !important/,
    );
  });
});

describe("the listening bars", () => {
  it("stand at rest in silence, rise with loudness, the middle most, and ease half the way a step", () => {
    expect(barScale(1, 0, 0.7)).toBe(0.7);
    expect(barScale(0, 0, 0.45)).toBe(0.45);
    expect(barScale(1, 1, 1)).toBe(1);
    expect(barScale(1, 1, 0.7)).toBeCloseTo(0.85);
    expect(barScale(1, 0.5, 0.85)).toBeGreaterThan(barScale(0, 0.5, 0.85) - 0.2);
    for (const index of [0, 1, 2] as const) expect(barScale(index, 1, 1)).toBeLessThanOrEqual(1);
  });
});

describe("the list highlight", () => {
  it("glides only a move made after a pause longer than a key's repeat", () => {
    expect(glides(undefined)).toBe(false);
    expect(glides(33)).toBe(false);
    expect(glides(REPEAT_MS - 1)).toBe(false);
    expect(glides(REPEAT_MS)).toBe(true);
    expect(glides(600)).toBe(true);
  });

  it("outlines the option under forced colours", () => {
    const css = readFileSync(new URL("../styles/motion.css", import.meta.url), "utf8");
    expect(css).toMatch(
      /@media \(forced-colors: active\) \{\s*\.gram-list-highlight \{[^}]*outline: 1px solid Highlight/,
    );
  });
});
