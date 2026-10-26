// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { inertWrapped, trackWrappedChips } from "./header-chips";

/** A 24 px row whose children sit at the given offsets from its top. */
const row = (tops: readonly number[]) => {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientHeight", { value: 24 });
  el.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
  for (const top of tops) {
    const child = document.createElement("button");
    child.getBoundingClientRect = () => ({ top: 100 + top }) as DOMRect;
    el.append(child);
  }
  return el;
};

describe("inertWrapped", () => {
  it("takes the chips past the first line out of focus, and gives them back once they fit", () => {
    const el = row([2, 2, 42]);
    el.scrollTop = 20;
    inertWrapped(el);
    const [first, second, wrapped] = [...el.children] as HTMLElement[];
    expect([first!.inert, second!.inert, wrapped!.inert]).toEqual([false, false, true]);
    expect(el.scrollTop).toBe(0);

    wrapped!.getBoundingClientRect = () => ({ top: 102 }) as DOMRect;
    inertWrapped(el);
    expect(wrapped!.inert).toBe(false);
  });
});

describe("trackWrappedChips", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("watches each chip's own size, and the chips that come later", async () => {
    const observed: Element[][] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        targets: Element[] = [];
        constructor() {
          observed.push(this.targets);
        }
        observe(target: Element) {
          this.targets.push(target);
        }
        disconnect() {
          this.targets.length = 0;
        }
      },
    );
    const el = row([2, 2]) as HTMLDivElement;
    const stop = trackWrappedChips(el);
    expect(observed[0]).toEqual([el, ...el.children]);

    const added = document.createElement("button");
    added.getBoundingClientRect = () => ({ top: 142 }) as DOMRect;
    el.append(added);
    await Promise.resolve();
    expect(observed[0]).toContain(added);
    expect(added.inert).toBe(true);
    stop?.();
  });
});
