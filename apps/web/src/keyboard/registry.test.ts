// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { dispatchShortcut, formatKeys, matches, registerShortcut, runShortcut } from "./registry";

const key = (init: KeyboardEventInit & { code?: string }, target?: EventTarget) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  if (target) Object.defineProperty(event, "target", { value: target });
  return event;
};

const cmd1 = (target: EventTarget) => key({ key: "1", code: "Digit1", metaKey: true }, target);

const cmdF = () => key({ key: "f", code: "KeyF", metaKey: true });

const cmd = (letter: string, target: EventTarget) =>
  key({ key: letter, code: `Key${letter.toUpperCase()}`, metaKey: true }, target);

/** Dispatches an Enter press at `target`, returning whether a shortcut took it. */
const pressEnter = (target: EventTarget, init: KeyboardEventInit = {}) =>
  dispatchShortcut(key({ key: "Enter", code: "Enter", ...init }, target), true);

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("matches", () => {
  it("reads ctrl as the Control key on macOS and as mod elsewhere", () => {
    const ctrlTab = key({ key: "Tab", code: "Tab", ctrlKey: true });
    expect(matches("ctrl+tab", ctrlTab, true)).toBe(true);
    expect(matches("mod+tab", ctrlTab, true)).toBe(false);
    expect(matches("ctrl+tab", key({ key: "Tab", code: "Tab", metaKey: true }), true)).toBe(false);
    expect(matches("ctrl+tab", ctrlTab, false)).toBe(true);
    expect(
      matches(
        "ctrl+shift+tab",
        key({ key: "Tab", code: "Tab", ctrlKey: true, shiftKey: true }),
        true,
      ),
    ).toBe(true);
    expect(formatKeys("ctrl+tab", true)).toBe("⌃⇥");
    expect(formatKeys("ctrl+shift+tab", false)).toBe("Ctrl+Shift+Tab");
  });

  it("maps mod to ⌘ on macOS and Ctrl elsewhere", () => {
    const cmdShiftU = key({ key: "U", code: "KeyU", metaKey: true, shiftKey: true });
    expect(matches("mod+shift+u", cmdShiftU, true)).toBe(true);
    expect(matches("mod+shift+u", cmdShiftU, false)).toBe(false);
    expect(
      matches("mod+shift+u", key({ key: "U", code: "KeyU", ctrlKey: true, shiftKey: true }), false),
    ).toBe(true);
  });

  it("requires the exact modifier set", () => {
    expect(
      matches(
        "mod+enter",
        key({ key: "Enter", code: "Enter", metaKey: true, shiftKey: true }),
        true,
      ),
    ).toBe(false);
    expect(matches("alt+enter", key({ key: "Enter", code: "Enter", altKey: true }), true)).toBe(
      true,
    );
  });

  it("uses the physical key so ⌥ and layouts don't change letters", () => {
    expect(matches("mod+\\", key({ key: "«", code: "Backslash", metaKey: true }), true)).toBe(true);
  });
});

describe("formatKeys", () => {
  it("renders glyphs on macOS and words elsewhere", () => {
    expect(formatKeys("mod+shift+enter", true)).toBe("⌘⇧⏎");
    expect(formatKeys("mod+shift+enter", false)).toBe("Ctrl+Shift+Enter");
    expect(formatKeys("escape", true)).toBe("⎋");
    expect(formatKeys("escape", false)).toBe("Esc");
    expect(formatKeys("mod+alt+arrowleft", true)).toBe("⌘⌥←");
    expect(formatKeys("mod+alt+arrowright", false)).toBe("Ctrl+Alt+→");
  });
});

describe("runShortcut", () => {
  it("runs the latest registration of the id that its `when` allows, keys or not", () => {
    const earlier = vi.fn();
    const later = vi.fn();
    let laterAllowed = false;
    cleanups.push(
      registerShortcut({
        id: "pick.model",
        keys: "mod+shift+m",
        label: "Pick",
        group: "Composer",
        run: earlier,
      }),
      registerShortcut({
        id: "pick.model",
        keys: "mod+shift+m",
        label: "Pick",
        group: "Composer",
        when: () => laterAllowed,
        run: later,
      }),
    );
    expect(runShortcut("pick.model")).toBe(true);
    laterAllowed = true;
    expect(runShortcut("pick.model")).toBe(true);
    expect([earlier.mock.calls.length, later.mock.calls.length]).toEqual([1, 1]);
    expect(runShortcut("pick.nothing")).toBe(false);
  });
});

describe("dispatchShortcut", () => {
  it("leaves every key to an IME that is composing", () => {
    const run = vi.fn();
    cleanups.push(
      registerShortcut({
        id: "ime.send",
        keys: "mod+enter",
        label: "Send",
        group: "Composer",
        run,
      }),
    );
    const enter = { key: "Enter", code: "Enter", metaKey: true };
    expect(dispatchShortcut(key({ ...enter, isComposing: true }), true)).toBe(false);
    // Some browsers report the key as 229 one event before `isComposing` turns true.
    expect(dispatchShortcut(key({ ...enter, keyCode: 229 }), true)).toBe(false);
    expect(run).not.toHaveBeenCalled();

    expect(dispatchShortcut(key(enter), true)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs a shortcut scoped to the focused area before a later global one, only in its scope", () => {
    let inScope = true;
    const scoped = vi.fn();
    const global = vi.fn();
    cleanups.push(
      registerShortcut({
        id: "scoped.find",
        keys: "mod+f",
        label: "Scoped find",
        group: "Terminal",
        focusScope: () => inScope,
        run: scoped,
      }),
      registerShortcut({
        id: "global.find",
        keys: "mod+f",
        label: "Global find",
        group: "Thread",
        run: global,
      }),
    );

    expect(dispatchShortcut(cmdF(), true)).toBe(true);
    expect(scoped).toHaveBeenCalledTimes(1);
    expect(global).not.toHaveBeenCalled();

    inScope = false;
    expect(dispatchShortcut(cmdF(), true)).toBe(true);
    expect(global).toHaveBeenCalledTimes(1);
    expect(scoped).toHaveBeenCalledTimes(1);
  });

  it("holds shortcuts while focus is inside a dialog, except those that allow dialogs", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const inside = document.createElement("button");
    dialog.append(inside);
    document.body.append(dialog);
    const closePane = vi.fn();
    const palette = vi.fn();
    cleanups.push(
      registerShortcut({
        id: "pane.close",
        keys: "mod+w",
        label: "Close pane",
        group: "Navigation",
        run: closePane,
      }),
      registerShortcut({
        id: "palette.open",
        keys: "mod+k",
        label: "Command palette",
        group: "App",
        allowInDialogs: true,
        run: palette,
      }),
      () => dialog.remove(),
    );

    expect(dispatchShortcut(cmd("w", inside), true)).toBe(false);
    expect(closePane).not.toHaveBeenCalled();
    expect(dispatchShortcut(cmd("k", inside), true)).toBe(true);
    expect(palette).toHaveBeenCalledTimes(1);

    expect(dispatchShortcut(cmd("w", document.body), true)).toBe(true);
    expect(closePane).toHaveBeenCalledTimes(1);

    // Closing: focus lingers in the popup during its exit transition, but the keys are free again.
    dialog.setAttribute("data-ending-style", "");
    expect(dispatchShortcut(cmd("w", inside), true)).toBe(true);
    expect(closePane).toHaveBeenCalledTimes(2);
  });

  it("takes a held key's repeats without running a once-per-press shortcut, or anything under it", () => {
    const below = vi.fn();
    const allow = vi.fn();
    cleanups.push(
      registerShortcut({ id: "b", keys: "enter", label: "B", group: "App", run: below }),
    );
    cleanups.push(
      registerShortcut({
        id: "allow",
        keys: "enter",
        label: "Allow",
        group: "Thread",
        once: true,
        run: allow,
      }),
    );
    const enter = { key: "Enter", code: "Enter" };
    expect(dispatchShortcut(key(enter), true)).toBe(true);
    // Holding Enter: the next card under it would be answered too.
    expect(dispatchShortcut(key({ ...enter, repeat: true }), true)).toBe(true);
    expect(dispatchShortcut(key({ ...enter, repeat: true }), true)).toBe(true);
    expect(allow).toHaveBeenCalledOnce();
    expect(below).not.toHaveBeenCalled();
    expect(dispatchShortcut(key(enter), true)).toBe(true);
    expect(allow).toHaveBeenCalledTimes(2);
  });

  it("runs the most recent matching shortcut whose `when` passes", () => {
    const first = vi.fn();
    const second = vi.fn();
    cleanups.push(
      registerShortcut({ id: "a", keys: "escape", label: "A", group: "App", run: first }),
    );
    cleanups.push(
      registerShortcut({
        id: "b",
        keys: "escape",
        label: "B",
        group: "App",
        when: () => false,
        run: second,
      }),
    );

    expect(dispatchShortcut(key({ key: "Escape", code: "Escape" }), true)).toBe(true);
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
  });

  it("ignores plain keys while typing, but not mod chords", () => {
    const enter = vi.fn();
    const send = vi.fn();
    cleanups.push(
      registerShortcut({ id: "allow", keys: "enter", label: "Allow", group: "Thread", run: enter }),
    );
    cleanups.push(
      registerShortcut({
        id: "send",
        keys: "mod+enter",
        label: "Send",
        group: "Composer",
        run: send,
      }),
    );
    const textarea = document.createElement("textarea");

    expect(dispatchShortcut(key({ key: "Enter", code: "Enter" }, textarea), true)).toBe(false);
    expect(
      dispatchShortcut(key({ key: "Enter", code: "Enter", metaKey: true }, textarea), true),
    ).toBe(true);
    expect(enter).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });

  it("skips a mod chord marked so while typing, leaving it to the next match", () => {
    const pane = vi.fn();
    const workspace = vi.fn();
    cleanups.push(
      registerShortcut({ id: "pane", keys: "mod+1", label: "Pane", group: "App", run: pane }),
      registerShortcut({
        id: "workspace",
        keys: "mod+1",
        label: "Workspace",
        group: "App",
        skipWhileTyping: true,
        run: workspace,
      }),
    );
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    for (const typing of [document.createElement("input"), editable]) {
      expect(dispatchShortcut(cmd1(typing), true)).toBe(true);
    }
    expect(workspace).not.toHaveBeenCalled();
    expect(pane).toHaveBeenCalledTimes(2);

    expect(dispatchShortcut(cmd1(document.body), true)).toBe(true);
    expect(workspace).toHaveBeenCalledOnce();
    expect(pane).toHaveBeenCalledTimes(2);
  });

  it("leaves a plain Enter to the focused button or widget, but not mod chords", () => {
    const allow = vi.fn();
    const send = vi.fn();
    cleanups.push(
      registerShortcut({ id: "allow", keys: "enter", label: "Allow", group: "Thread", run: allow }),
    );
    cleanups.push(
      registerShortcut({
        id: "send",
        keys: "mod+enter",
        label: "Send",
        group: "Composer",
        run: send,
      }),
    );
    const button = document.createElement("button");
    const treeitem = document.createElement("div");
    treeitem.setAttribute("role", "treeitem");

    expect(pressEnter(button)).toBe(false);
    expect(pressEnter(treeitem)).toBe(false);
    expect(allow).not.toHaveBeenCalled();
    expect(pressEnter(document.body)).toBe(true);
    expect(allow).toHaveBeenCalledOnce();
    expect(pressEnter(button, { metaKey: true })).toBe(true);
    expect(send).toHaveBeenCalledOnce();
  });
});
