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

const keyDown = (init: Record<string, unknown>) =>
  viewInput({
    type: "key",
    action: "down",
    key: "a",
    code: "KeyA",
    keyCode: 65,
    modifiers: 0,
    ...init,
  });

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

  it("lets Control and Command go with editing keys only, never a browser's own shortcut", () => {
    // Select all, undo, redo, a word back, deleting a word.
    expect(keyDown({ modifiers: 2 })).toMatchObject({ key: "a", modifiers: 2 });
    expect(keyDown({ modifiers: 4, key: "z", code: "KeyZ", keyCode: 90 })).toBeDefined();
    expect(keyDown({ modifiers: 10, key: "Z", code: "KeyZ", keyCode: 90 })).toBeDefined();
    expect(
      keyDown({ modifiers: 2, key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 }),
    ).toBeDefined();
    expect(
      keyDown({ modifiers: 2, key: "Backspace", code: "Backspace", keyCode: 8 }),
    ).toBeDefined();
    // A new window, an incognito one, closing the page, the developer tools, clearing data.
    for (const [name, code, keyCode, modifiers] of [
      ["n", "KeyN", 78, 2],
      ["N", "KeyN", 78, 10],
      ["w", "KeyW", 87, 2],
      ["t", "KeyT", 84, 2],
      ["I", "KeyI", 73, 10],
      ["J", "KeyJ", 74, 10],
      ["Delete", "Delete", 46, 10],
      ["r", "KeyR", 82, 2],
      ["l", "KeyL", 76, 4],
      // The one clipboard of the server's browser is every thread's.
      ["c", "KeyC", 67, 2],
      ["v", "KeyV", 86, 2],
      ["x", "KeyX", 88, 4],
    ] as const)
      expect(keyDown({ key: name, code, keyCode, modifiers })).toBeUndefined();
    // A shortcut's key code under an editing key's name is still the shortcut.
    expect(keyDown({ key: "a", code: "KeyA", keyCode: 78, modifiers: 2 })).toBeUndefined();
    expect(keyDown({ key: "n", code: "KeyN", keyCode: 65, modifiers: 2 })).toBeUndefined();
    // And an editing key's code names itself, whatever was sent.
    expect(keyDown({ key: "a", code: "KeyN", keyCode: 65, modifiers: 2 })).toMatchObject({
      code: "KeyA",
    });
    // A shortcut types nothing.
    expect(keyDown({ modifiers: 2, text: "a" })).not.toHaveProperty("text");
  });

  it("sends no function key, no browser key, and Alt only with a character", () => {
    expect(keyDown({ key: "F12", code: "F12", keyCode: 123 })).toBeUndefined();
    expect(keyDown({ key: "F5", code: "F5", keyCode: 116 })).toBeUndefined();
    expect(keyDown({ key: "a", code: "KeyA", keyCode: 123 })).toBeUndefined();
    expect(keyDown({ key: "BrowserBack", code: "BrowserBack", keyCode: 166 })).toBeUndefined();
    expect(
      keyDown({ key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, modifiers: 1 }),
    ).toBeUndefined();
    expect(keyDown({ key: "F4", code: "F4", keyCode: 115, modifiers: 1 })).toBeUndefined();
    expect(keyDown({ key: "Home", code: "Home", keyCode: 36, modifiers: 1 })).toBeUndefined();
    // AltGr (Control and Alt) and Option type a character, which goes as that character alone.
    expect(keyDown({ key: "@", code: "KeyQ", keyCode: 81, text: "@", modifiers: 3 })).toMatchObject(
      {
        text: "@",
        modifiers: 0,
      },
    );
    expect(keyDown({ key: "É", code: "KeyE", keyCode: 69, text: "É", modifiers: 9 })).toMatchObject(
      {
        text: "É",
        modifiers: 8,
      },
    );
    // A control character is no text.
    expect(keyDown({ text: "\u000e" })).not.toHaveProperty("text");
    // Plain keys go as they are.
    expect(keyDown({ key: "Tab", code: "Tab", keyCode: 9 })).toBeDefined();
    expect(keyDown({ key: "Escape", code: "Escape", keyCode: 27 })).toBeDefined();
    expect(keyDown({ key: "Enter", code: "Enter", keyCode: 13, text: "\r" })).toMatchObject({
      text: "\r",
    });
  });

  it("sends no copy, cut or paste, by any of their keys", () => {
    expect(keyDown({ modifiers: 2, key: "c", code: "KeyC", keyCode: 67 })).toBeUndefined();
    expect(keyDown({ modifiers: 2, key: "x", code: "KeyX", keyCode: 88 })).toBeUndefined();
    expect(keyDown({ modifiers: 4, key: "v", code: "KeyV", keyCode: 86 })).toBeUndefined();
    expect(keyDown({ modifiers: 8, key: "Insert", code: "Insert", keyCode: 45 })).toBeUndefined();
    expect(keyDown({ modifiers: 2, key: "Insert", code: "Insert", keyCode: 45 })).toBeUndefined();
    expect(keyDown({ modifiers: 8, key: "Delete", code: "Delete", keyCode: 46 })).toBeUndefined();
    expect(keyDown({ key: "Delete", code: "Delete", keyCode: 46 })).toBeDefined();
  });

  it("sends only a keyboard's ordinary keys, by code and by name", () => {
    // Names a browser runs as commands whatever the key code.
    for (const name of ["Copy", "Cut", "Paste", "Undo", "BrowserBack", "ContextMenu", "F12"])
      expect(keyDown({ key: name, code: "", keyCode: 0 })).toBeUndefined();
    expect(keyDown({ key: "Copy", code: "KeyA", keyCode: 65 })).toBeUndefined();
    // Codes a browser reads as its own: closing the page, a new window.
    for (const keyCode of [0, 93, 112, 166, 229, 235, 236, 255])
      expect(keyDown({ key: "Unidentified", code: "", keyCode })).toBeUndefined();
    expect(keyDown({ key: "å", code: "BracketLeft", keyCode: 221, text: "å" })).toBeDefined();
    // A character typed with AltGr goes down and comes up as that character.
    expect(
      keyDown({ key: "@", code: "Digit2", keyCode: 50, text: "@", modifiers: 3 }),
    ).toMatchObject({
      text: "@",
      modifiers: 0,
    });
    expect(
      keyDown({ action: "up", key: "@", code: "Digit2", keyCode: 50, modifiers: 3 }),
    ).toMatchObject({ modifiers: 0 });
    expect(
      keyDown({ action: "up", key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, modifiers: 1 }),
    ).toBeUndefined();
  });

  it("takes no middle button, which pastes the selection where the browser runs", () => {
    const press = { type: "pointer", action: "down", x: 1, y: 1, clickCount: 1, modifiers: 0 };
    expect(viewInput({ ...press, button: "middle", buttons: 4 })).toBeUndefined();
    expect(viewInput({ ...press, button: "left", buttons: 5 })).toBeUndefined();
    expect(viewInput({ ...press, button: "left", buttons: 1 })).toBeDefined();
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
    expect(viewServerMessage({ type: "pane.view.watch", threadId: "t", fresh: true })).toEqual({
      type: "pane.view.watch",
      threadId: "t",
      fresh: true,
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
