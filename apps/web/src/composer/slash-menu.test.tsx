// @vitest-environment happy-dom
import type { SlashCommand } from "@gram/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SlashMenu } from "./slash-menu";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const commands: SlashCommand[] = Array.from({ length: 12 }, (_, i) => ({
  name: `command-${i}`,
  description: `Command ${i}`,
}));

const at = (activeIndex: number) => (
  <SlashMenu id="slash" commands={commands} activeIndex={activeIndex} onChoose={() => {}} />
);
const glide = () => screen.getByTestId("list-highlight").dataset["glide"];

describe("SlashMenu", () => {
  it("scrolls the active command into view as it changes", () => {
    const scrolled: string[] = [];
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (
      this: HTMLElement,
    ) {
      scrolled.push(this.id);
    });
    const { rerender } = render(
      <SlashMenu id="slash" commands={commands} activeIndex={0} onChoose={() => {}} />,
    );
    rerender(<SlashMenu id="slash" commands={commands} activeIndex={11} onChoose={() => {}} />);
    expect(scrolled).toEqual(["slash-0", "slash-11"]);
  });

  it("heads Gram's commands when they end the list, and marks each when they don't", () => {
    const agent = { name: "deploy", description: "The user's" };
    const native = { name: "new", description: "New thread", action: "newThread" as const };
    const { rerender } = render(
      <SlashMenu id="slash" commands={[agent, native]} activeIndex={0} onChoose={() => {}} />,
    );
    expect(screen.getByText("Gram")).toBeTruthy();
    expect(screen.queryAllByTitle("Gram does this")).toHaveLength(0);
    rerender(
      <SlashMenu id="slash" commands={[native, agent]} activeIndex={0} onChoose={() => {}} />,
    );
    expect(screen.queryByText("Gram")).toBeNull();
    expect(screen.getAllByTitle("Gram does this")).toHaveLength(1);
    expect(screen.getByRole("option", { name: /new/ }).getAttribute("aria-description")).toBe(
      "Gram does this",
    );
  });

  it("glides the highlight for a deliberate move, and jumps it for a held key's repeats", () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { rerender } = render(at(0));
    // Where it opens it is simply placed.
    expect(glide()).toBe("false");
    now = 600;
    rerender(at(1));
    expect(glide()).toBe("true");
    // A held arrow repeats about every 33 ms: each one lands at once, never trailing the key.
    for (const index of [2, 3, 4]) {
      now += 33;
      rerender(at(index));
      expect(glide()).toBe("false");
      expect(screen.getByRole("option", { selected: true }).id).toBe(`slash-${index}`);
    }
    now += 400;
    rerender(at(5));
    expect(glide()).toBe("true");
  });

  it("places the highlight again, without gliding, when the list changes under the same option", () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { rerender } = render(
      <SlashMenu id="slash" commands={commands} activeIndex={0} onChoose={() => {}} />,
    );
    now = 600;
    rerender(
      <SlashMenu id="slash" commands={commands.slice(3)} activeIndex={0} onChoose={() => {}} />,
    );
    expect(screen.getByTestId("list-highlight").dataset["glide"]).toBe("false");
  });

  it("follows the active option when the menu resizes, at once", () => {
    let resize: (() => void) | undefined;
    const observed: Element[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe(target: Element) {
          observed.push(target);
        }
        disconnect() {}
      },
    );
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const { rerender } = render(at(0));
      const option = document.getElementById("slash-0")!;
      expect(observed).toContain(option);
      // The report an observer makes as it starts, with nothing changed, leaves a glide alone.
      now = 600;
      rerender(at(1));
      expect(glide()).toBe("true");
      resize!();
      expect(glide()).toBe("true");
      const moved = document.getElementById("slash-1")!;
      vi.spyOn(moved, "offsetWidth", "get").mockReturnValue(320);
      resize!();
      const highlight = screen.getByTestId("list-highlight");
      expect(highlight.style.width).toBe("320px");
      expect(highlight.dataset["glide"]).toBe("false");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
