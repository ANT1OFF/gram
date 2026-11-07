// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { aboveComposer } from "./above-composer";
import { DEFAULT_EFFORT_OPTION } from "./options";
import { ValueWords } from "./picker-trigger";

afterEach(cleanup);

const words = (props: Parameters<typeof ValueWords>[0]) => {
  const { container } = render(
    <span>
      <ValueWords {...props} />
    </span>,
  );
  return {
    full: container.querySelector("[data-toolbar-label]")?.textContent,
    short: container.querySelector("[data-toolbar-compact]")?.textContent,
  };
};

/** The words a size shows: the one span that isn't screen-reader only. */
const shown = (props: Parameters<typeof ValueWords>[0]) => {
  const { container } = render(
    <span>
      <ValueWords {...props} />
    </span>,
  );
  const visible = [...container.querySelectorAll("span > span")].filter(
    (span) => !span.className.includes("sr-only") && span.parentElement === container.firstChild,
  );
  return visible.map((span) => span.textContent);
};

// "Model default" and "CLI default" beside the model picker read as the model's own; a chip names
// what it picks before its value, short of room too, so its meaning never changes with context.
describe("ValueWords with a dimension", () => {
  it("says the dimension before the value, in full and compact", () => {
    expect(
      words({ value: "Extra high", compact: "X-high", labelled: true, dimension: "Effort" }),
    ).toEqual({ full: "Effort: Extra high", short: "Effort: X-high" });
  });

  // Round 12 (124): the narrow composer read "Effort" and "Speed", values gone. A default keeps
  // its value short of room; a dimension never shows without one.
  it("keeps a default's value short of room, never the dimension alone", () => {
    expect(
      words({
        value: DEFAULT_EFFORT_OPTION.word,
        compact: DEFAULT_EFFORT_OPTION.compact,
        labelled: "short",
        dimension: "Effort",
      }),
    ).toEqual({ full: "Effort: Default", short: undefined });
    expect(
      shown({
        value: DEFAULT_EFFORT_OPTION.word,
        compact: DEFAULT_EFFORT_OPTION.compact,
        labelled: "short",
        dimension: "Effort",
      }),
    ).toEqual(["Effort: Default"]);
    // A compact word that is empty or the dimension itself stands for the value.
    expect(
      words({ value: "Standard", compact: "", labelled: "short", dimension: "Speed" }),
    ).toEqual({ full: "Speed: Standard", short: undefined });
    expect(
      shown({ value: "Standard", compact: "Std", labelled: "short", dimension: "Speed" }),
    ).toEqual(["Speed: Std"]);
  });

  it("shows the value alone, tighter than compact words", () => {
    expect(
      shown({ value: "Extra high", compact: "X-high", labelled: "value", dimension: "Effort" }),
    ).toEqual(["X-high"]);
    expect(shown({ value: "High", labelled: "value", dimension: "Effort" })).toEqual(["High"]);
    expect(
      shown({ value: "Standard", compact: "Std", labelled: "value", dimension: "Speed" }),
    ).toEqual(["Std"]);
    // The model picker has no dimension: its compact name is its value alone.
    expect(shown({ value: "Claude Opus", compact: "Opus", labelled: "value" })).toEqual(["Opus"]);
    expect(shown({ value: "High", labelled: "icon", dimension: "Effort" })).toEqual([]);
  });

  it("has nothing compact to show when the compact words are the full ones", () => {
    expect(words({ value: "Ask", labelled: "short", dimension: "Mode" })).toEqual({
      full: "Mode: Ask",
      short: undefined,
    });
  });

  it("says the value alone without a dimension, as the model picker does", () => {
    expect(words({ value: "Claude Opus", compact: "Opus", labelled: true })).toEqual({
      full: "Claude Opus",
      short: "Opus",
    });
  });
});

const box = (top: number, left: number, width: number, height: number) =>
  DOMRect.fromRect({ x: left, y: top, width, height });

// The model picker opened over the draft being written; its list now clears the whole composer.
describe("aboveComposer", () => {
  it("spans the trigger's column from the composer's top down to the trigger", () => {
    const slab = document.createElement("div");
    slab.dataset["surface"] = "composer";
    const trigger = document.createElement("button");
    slab.append(trigger);
    document.body.append(slab);
    slab.getBoundingClientRect = () => box(600, 100, 700, 140);
    trigger.getBoundingClientRect = () => box(700, 220, 120, 32);
    const anchor = aboveComposer(trigger);
    expect(anchor).not.toBe(trigger);
    const rect = (anchor as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect();
    expect([rect.left, rect.top, rect.width, rect.bottom]).toEqual([220, 600, 120, 732]);
    slab.remove();
  });

  it("is the trigger itself outside a composer", () => {
    const trigger = document.createElement("button");
    expect(aboveComposer(trigger)).toBe(trigger);
    expect(aboveComposer(null)).toBeNull();
  });
});
