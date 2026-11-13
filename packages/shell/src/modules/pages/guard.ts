// The clipboard guard every pinned page's frames run before their own scripts. Chromium lets a
// page write the clipboard while it has the user's activation (`document.execCommand("copy")`), and
// lets its copy handler swap what the user's own Ctrl+C copies, whatever the session's permissions
// say: no setting reaches either. So the pages session's preload runs this in the main world of
// every frame, first. It exposes nothing to the page: no `contextBridge` API, no channel.
//
// What it closes: a script's copy, cut and paste commands, and the page seeing or changing the
// clipboard's data on the user's own copy, cut or paste. The user's copy still copies their
// selection, as the browser would.

/**
 * Runs in the page's main world before any of its scripts; self-contained, since it is sent there
 * as source. Everything it uses it takes before the page can change it.
 */
export function pageGuard(): void {
  const apply = Reflect.apply;
  const doc = Document.prototype;
  const exec = doc.execCommand;
  const stop = Event.prototype.stopImmediatePropagation;
  const listen = EventTarget.prototype.addEventListener;
  const lower = String.prototype.toLowerCase;
  // A function, not an arrow: `arguments` passes the page's call on as it came, with no iterator
  // or array method of the page's in the way.
  const guarded = function execCommand(this: Document, command: unknown) {
    const name = typeof command === "string" ? (apply(lower, command, []) as string) : "";
    if (name === "copy" || name === "cut" || name === "paste") return false;
    // oxlint-disable-next-line prefer-rest-params -- see above
    return apply(exec, this, arguments) as boolean;
  };
  Object.defineProperty(doc, "execCommand", {
    value: guarded,
    writable: false,
    configurable: false,
    enumerable: false,
  });
  // First in the capture phase at the window, so no handler of the page's hears these: the
  // default action, the user's own copy of their selection, still happens.
  const silence = (event: Event) => {
    apply(stop, event, []);
  };
  apply(listen, window, ["copy", silence, true]);
  apply(listen, window, ["cut", silence, true]);
  apply(listen, window, ["paste", silence, true]);
}

/** The preload's whole work: `pageGuard` in the main world, and nothing exposed. */
export const installPageGuard = (bridge: {
  executeInMainWorld(script: { func: () => void }): unknown;
}): void => {
  bridge.executeInMainWorld({ func: pageGuard });
};
