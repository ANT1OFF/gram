// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { focusPaneComposer, gridShown } from "./pane-focus";

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

const addPane = (index: number, ...children: HTMLElement[]) => {
  const pane = document.createElement("div");
  pane.dataset.paneIndex = String(index);
  pane.append(...children);
  document.body.append(pane);
  return pane;
};

const composer = () => {
  const textarea = document.createElement("textarea");
  textarea.setAttribute("aria-label", "Message");
  return textarea;
};

const button = (text: string) => {
  const element = document.createElement("button");
  element.textContent = text;
  return element;
};

afterEach(() => {
  document.body.replaceChildren();
});

describe("gridShown", () => {
  it("is true only while panes are rendered", () => {
    expect(gridShown()).toBe(false);
    addPane(0, composer());
    expect(gridShown()).toBe(true);
  });
});

describe("focusPaneComposer", () => {
  it("moves focus into the pane's composer, and leaves focus already in the pane alone", async () => {
    const first = composer();
    const second = composer();
    const header = button("Header");
    addPane(0, first);
    addPane(1, header, second);
    first.focus();

    focusPaneComposer(1);
    await frame();
    expect(document.activeElement).toBe(second);

    header.focus();
    focusPaneComposer(1);
    await frame();
    expect(document.activeElement).toBe(header);

    focusPaneComposer(1, { always: true });
    await frame();
    expect(document.activeElement).toBe(second);
  });

  it("falls back to the first control of a pane without a composer", async () => {
    const first = composer();
    addPane(0, first);
    addPane(1, button("New thread here"));
    first.focus();

    focusPaneComposer(1);
    await frame();
    expect(document.activeElement?.textContent).toBe("New thread here");
  });
});
