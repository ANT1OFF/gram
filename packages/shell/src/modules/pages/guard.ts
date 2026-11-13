// The clipboard guard every pinned page's frames run before their own scripts. Chromium lets a
// page write the clipboard while it has the user's activation (`document.execCommand("copy")`), and
// lets its copy handler swap what the user's own Ctrl+C copies, whatever the session's permissions
// say: no setting reaches either. So the pages session's preload runs this in the main world of
// each frame it reaches, first. It exposes nothing to the page: no `contextBridge` API, no channel.
//
// What it promises: the page can't write the clipboard by script (copy, cut and paste commands,
// whatever names them), can't see or change the clipboard's data on the user's own copy, cut or
// paste, and hears neither the `beforecopy`, `beforecut` and `beforepaste` events nor the copy
// shortcut's keydown (Ctrl or Cmd+C, Ctrl+Insert), so it can't move the selection just as the user
// copies. The user's copy still copies their selection, as the browser would.
//
// What it can't promise: that what the user sees is what they copy. A selection over text the page
// hid (styled away, off screen, zero-sized) copies that text too, in every browser; and the page
// can still move the selection at any other moment.
//
// Its listeners live on the window, and `document.open()` erases every listener of the window and
// document it replaces, so the page could put its own in their place. A pinned page therefore never
// replaces its document: `document.open`, and `document.write` and `writeln`, which open the
// document when it has finished parsing, throw. A page builds its DOM with the DOM's own methods.
//
// It runs in the frames the preload reaches. A frame the page makes itself (an `about:blank` or
// `srcdoc` child) gets no preload; the sandbox the session puts on every response gives each of the
// page's documents an opaque origin of its own, so the page can't script such a child, and the child
// has no user activation to copy with.

/**
 * Runs in the page's main world before any of its scripts; self-contained, since it is sent there
 * as source. Everything it uses it takes before the page can change it.
 */
export function pageGuard(): void {
  const apply = Reflect.apply;
  const define = Object.defineProperty;
  const Refusal = TypeError;
  const doc = Document.prototype;
  const exec = doc.execCommand;
  const stop = Event.prototype.stopImmediatePropagation;
  const listen = EventTarget.prototype.addEventListener;
  const lower = String.prototype.toLowerCase;
  // oxlint-disable-next-line consistent-function-scoping -- the guard is sent as source: self-contained
  const getter = (proto: object, name: string) =>
    Object.getOwnPropertyDescriptor(proto, name)!.get!;
  const keyOf = getter(KeyboardEvent.prototype, "key");
  const codeOf = getter(KeyboardEvent.prototype, "code");
  const ctrlOf = getter(KeyboardEvent.prototype, "ctrlKey");
  const metaOf = getter(KeyboardEvent.prototype, "metaKey");
  const altOf = getter(KeyboardEvent.prototype, "altKey");
  const fixed = (name: string, value: unknown) =>
    define(doc, name, { value, writable: false, configurable: false, enumerable: false });
  // A function, not an arrow, for its `this`. A command that isn't a string is refused before
  // anything reads it: an object's `toString` could name one command to this check and another to
  // the browser. The string checked is the one passed on, with the call's own value and flag.
  fixed(
    "execCommand",
    function execCommand(this: Document, command: unknown, showUI?: unknown, value?: unknown) {
      if (typeof command !== "string") return false;
      const name = apply(lower, command, []) as string;
      if (name === "copy" || name === "cut" || name === "paste") return false;
      return apply(exec, this, [
        command,
        showUI === undefined ? false : showUI,
        value === undefined ? "" : value,
      ]) as boolean;
    },
  );
  const replaces = () => {
    throw new Refusal("A pinned page can't replace its document");
  };
  fixed("open", function open() {
    replaces();
  });
  fixed("write", function write() {
    replaces();
  });
  fixed("writeln", function writeln() {
    replaces();
  });
  // First in the capture phase at the window, so no handler of the page's hears these: the
  // default action, the user's own copy of their selection, still happens.
  const silence = (event: Event) => {
    apply(stop, event, []);
  };
  apply(listen, window, ["copy", silence, true]);
  apply(listen, window, ["cut", silence, true]);
  apply(listen, window, ["paste", silence, true]);
  // Fired just before a copy, cut or paste: a handler there could move the selection onto text the
  // page chose.
  apply(listen, window, ["beforecopy", silence, true]);
  apply(listen, window, ["beforecut", silence, true]);
  apply(listen, window, ["beforepaste", silence, true]);
  // The copy shortcut's keydown, for the same reason, kept from the page's handlers but not
  // prevented: the browser's copy still runs on it.
  const copyKey = (event: Event) => {
    const ctrl = apply(ctrlOf, event, []) === true;
    const meta = apply(metaOf, event, []) === true;
    if (apply(altOf, event, []) === true) return false;
    const key = apply(keyOf, event, []) as string;
    const code = apply(codeOf, event, []) as string;
    if ((ctrl || meta) && (code === "KeyC" || key === "c" || key === "C")) return true;
    return ctrl && key === "Insert";
  };
  apply(listen, window, [
    "keydown",
    (event: Event) => {
      if (copyKey(event)) apply(stop, event, []);
    },
    true,
  ]);
}

/** The preload's whole work: `pageGuard` in the main world, and nothing exposed. */
export const installPageGuard = (bridge: {
  executeInMainWorld(script: { func: () => void }): unknown;
}): void => {
  bridge.executeInMainWorld({ func: pageGuard });
};
