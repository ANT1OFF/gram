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
  fixed(
    "execCommand",
    function execCommand(this: Document, command: unknown, showUI?: unknown, value?: unknown) {
      if (typeof command !== "string") return false;
      const name = apply<string, [], string>(lower, command, []);
      if (name === "copy" || name === "cut" || name === "paste") return false;
      const done: unknown = apply(exec, this, [
        command,
        showUI === undefined ? false : showUI,
        value === undefined ? "" : value,
      ]);
      return done === true;
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
  const silence = (event: Event) => {
    apply(stop, event, []);
  };
  apply(listen, window, ["copy", silence, true]);
  apply(listen, window, ["cut", silence, true]);
  apply(listen, window, ["paste", silence, true]);
  apply(listen, window, ["beforecopy", silence, true]);
  apply(listen, window, ["beforecut", silence, true]);
  apply(listen, window, ["beforepaste", silence, true]);
  const copyKey = (event: Event) => {
    const ctrl = apply(ctrlOf, event, []) === true;
    const meta = apply(metaOf, event, []) === true;
    if (apply(altOf, event, []) === true) return false;
    const key: unknown = apply(keyOf, event, []);
    const code: unknown = apply(codeOf, event, []);
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
