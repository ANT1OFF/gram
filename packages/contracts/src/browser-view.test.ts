import { describe, expect, it } from "vitest";

import {
  VIEW_INPUT_BATCH,
  viewHostMessage,
  viewInput,
  viewInputTakes,
  viewServerMessage,
} from "./browser-view.ts";

const down = {
  type: "pointer",
  action: "down",
  x: 10,
  y: 20,
  button: "left",
  buttons: 1,
  clickCount: 1,
  modifiers: 0,
};

describe("viewInput", () => {
  it("keeps a pointer, a wheel and a key, and nothing else of them", () => {
    expect(viewInput({ ...down, extra: "dropped" })).toEqual(down);
    expect(viewInput({ type: "wheel", x: 1, y: 2, deltaX: 0, deltaY: -120, modifiers: 8 })).toEqual(
      { type: "wheel", x: 1, y: 2, deltaX: 0, deltaY: -120, modifiers: 8 },
    );
    expect(
      viewInput({
        type: "key",
        action: "down",
        key: "a",
        code: "KeyA",
        keyCode: 65,
        text: "a",
        modifiers: 0,
        repeat: false,
      }),
    ).toEqual({
      type: "key",
      action: "down",
      key: "a",
      code: "KeyA",
      keyCode: 65,
      text: "a",
      modifiers: 0,
    });
  });

  it("refuses what is out of bounds or the wrong shape", () => {
    for (const bad of [
      null,
      "click",
      { ...down, x: Number.NaN },
      { ...down, x: -1 },
      { ...down, y: 1e9 },
      { ...down, button: "fourth" },
      { ...down, buttons: 99 },
      { ...down, clickCount: 12 },
      { ...down, modifiers: 16 },
      { ...down, action: "drag" },
      { type: "wheel", x: 1, y: 2, deltaX: 0, deltaY: Number.POSITIVE_INFINITY, modifiers: 0 },
      { type: "key", action: "down", key: "a".repeat(33), code: "KeyA", keyCode: 65, modifiers: 0 },
      { type: "key", action: "down", key: "a", code: "KeyA", keyCode: 999, modifiers: 0 },
      {
        type: "key",
        action: "down",
        key: "a",
        code: "KeyA",
        keyCode: 65,
        text: "x".repeat(9),
        modifiers: 0,
      },
      { type: "key", action: "press", key: "a", code: "KeyA", keyCode: 65, modifiers: 0 },
      { type: "touch", x: 1, y: 1, modifiers: 0 },
    ])
      expect(viewInput(bad)).toBeUndefined();
  });

  it("takes the page over with a press, a key going down or a scroll, and nothing else", () => {
    const key = { type: "key", key: "a", code: "KeyA", keyCode: 65, modifiers: 0 } as const;
    expect(viewInputTakes(viewInput(down)!)).toBe(true);
    expect(viewInputTakes(viewInput({ ...down, action: "up" })!)).toBe(false);
    expect(viewInputTakes(viewInput({ ...down, action: "move" })!)).toBe(false);
    expect(viewInputTakes({ ...key, action: "down" })).toBe(true);
    expect(viewInputTakes({ ...key, action: "up" })).toBe(false);
    expect(viewInputTakes({ type: "wheel", x: 0, y: 0, deltaX: 0, deltaY: 1, modifiers: 0 })).toBe(
      true,
    );
  });
});

describe("viewServerMessage", () => {
  it("reads a watch, a control and inputs, dropping the inputs that aren't", () => {
    expect(viewServerMessage({ type: "pane.view.watch", threadId: "t" })).toEqual({
      type: "pane.view.watch",
      threadId: "t",
    });
    expect(viewServerMessage({ type: "pane.view.control", threadId: "t", op: "reload" })).toEqual({
      type: "pane.view.control",
      threadId: "t",
      op: "reload",
    });
    expect(
      viewServerMessage({ type: "pane.view.input", threadId: "t", inputs: [down, { type: "x" }] }),
    ).toEqual({ type: "pane.view.input", threadId: "t", inputs: [down] });
  });

  it("refuses an unknown control, a thread with no name and too many inputs", () => {
    expect(viewServerMessage({ type: "pane.view.control", threadId: "t", op: "navigate" })).toBe(
      undefined,
    );
    expect(viewServerMessage({ type: "pane.view.watch", threadId: "" })).toBeUndefined();
    expect(viewServerMessage({ type: "pane.view.watch" })).toBeUndefined();
    expect(viewServerMessage({ type: "pane.request", threadId: "t" })).toBeUndefined();
    expect(
      viewServerMessage({
        type: "pane.view.input",
        threadId: "t",
        inputs: Array.from({ length: VIEW_INPUT_BATCH + 1 }, () => down),
      }),
    ).toBeUndefined();
  });
});

describe("viewHostMessage", () => {
  it("reads a page and a frame, and nothing else", () => {
    expect(viewHostMessage({ type: "pane.view.page", threadId: "t", page: null })).toBeDefined();
    expect(
      viewHostMessage({
        type: "pane.view.frame",
        threadId: "t",
        jpeg: "/9j/",
        width: 800,
        height: 600,
      }),
    ).toBeDefined();
    expect(
      viewHostMessage({ type: "pane.view.frame", threadId: "t", jpeg: 1, width: 800, height: 600 }),
    ).toBe(undefined);
    expect(
      viewHostMessage({ type: "pane.view.frame", threadId: "t", jpeg: "", width: 0, height: 600 }),
    ).toBe(undefined);
    expect(viewHostMessage({ type: "pane.view.page", threadId: "t", page: "x" })).toBeUndefined();
    expect(viewHostMessage({ type: "pane.response", id: "a" })).toBeUndefined();
  });
});
