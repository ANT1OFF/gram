// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  revealVirtualRow,
  virtualCurrent,
  virtualLists,
  virtualRowOf,
  VirtualRows,
} from "./virtual-rows";

const ROW = 28;
const VIEW = 300;
const items = Array.from({ length: 200 }, (_, i) => `row-${i}`);

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** 200 rows in a 300 px scroller, each 28 px tall; happy-dom lays nothing out itself. */
const renderList = (current = -1, retainedKeys: ReadonlySet<string> = new Set()) => {
  const view = render(
    <div data-testid="scroller" style={{ overflowY: "auto", height: VIEW }}>
      <h2>Above</h2>
      <VirtualRows
        items={items}
        rowKey={(item) => item}
        estimate={ROW}
        gap={1}
        current={current}
        retainedKeys={retainedKeys}
      >
        {(item) => (
          <button type="button" data-row={item}>
            {item}
          </button>
        )}
      </VirtualRows>
    </div>,
  );
  const scroller = view.getByTestId("scroller");
  const list = scroller.querySelector<HTMLElement>("[data-virtual-list]")!;
  return { ...view, scroller, list };
};

const drawn = (list: HTMLElement) =>
  [...list.querySelectorAll<HTMLElement>("[data-row]")].map((row) => row.dataset["row"]);

const scrollTo = async (scroller: HTMLElement, top: number) => {
  await act(async () => {
    scroller.scrollTop = top;
    scroller.dispatchEvent(new Event("scroll"));
    await nextFrame();
  });
};

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(VIEW);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(240);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(ROW);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(240);
  // As tall as the heading and every row, which the virtualizer clamps its scrolls to.
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(ROW + items.length * 29);
  // A browser's scrollTo moves the offset and says so with a scroll event; happy-dom's doesn't.
  vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(function (
    this: HTMLElement,
    options?: ScrollToOptions | number,
  ) {
    if (typeof options === "object" && options.top !== undefined) this.scrollTop = options.top;
    this.dispatchEvent(new Event("scroll"));
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("VirtualRows", () => {
  it("draws the rows in view and a few more, not all of them", () => {
    const { list } = renderList();
    const rows = drawn(list);
    expect(rows[0]).toBe("row-0");
    expect(rows.length).toBeGreaterThan(VIEW / ROW);
    expect(rows.length).toBeLessThan(30);
    // As tall as every row and the pixel between each.
    expect(list.style.height).toBe(`${items.length * ROW + (items.length - 1)}px`);
  });

  it("keeps the focused row drawn when it scrolls far away", async () => {
    const { list, scroller } = renderList();
    const row = list.querySelector<HTMLElement>('[data-row="row-2"]')!;
    act(() => row.focus());
    await scrollTo(scroller, 150 * (ROW + 1));
    const rows = drawn(list);
    expect(rows).toContain("row-150");
    expect(rows).toContain("row-2");
    expect(row.isConnected).toBe(true);
    expect(document.activeElement).toBe(row);
    // Its wrapper still says where it stands, for the arrows to go on from.
    const at = virtualRowOf(row);
    expect(at?.list).toBe(list);
    expect([at?.index, at?.count]).toEqual([2, items.length]);
  });

  it("reveals a row by its index, and knows its current one", async () => {
    const { list, container } = renderList(180);
    expect(virtualLists(container)).toEqual([list]);
    expect(virtualCurrent(list)).toBe(180);
    expect(drawn(list)).not.toContain("row-180");
    let row: HTMLElement | null = null;
    await act(async () => {
      row = await revealVirtualRow(list, 180);
    });
    expect(row).not.toBeNull();
    expect(row!.querySelector("[data-row]")?.textContent).toBe("row-180");
  });

  it("keeps every retained row mounted after another row takes focus", async () => {
    const { list, scroller } = renderList(-1, new Set(["row-2", "row-4"]));
    const rows = [2, 4, 6].map((i) => list.querySelector<HTMLElement>(`[data-row="row-${i}"]`)!);
    act(() => rows[2]!.focus());
    await scrollTo(scroller, 150 * (ROW + 1));
    expect(drawn(list)).toEqual(expect.arrayContaining(["row-2", "row-4", "row-6", "row-150"]));
    expect(drawn(list).length).toBeLessThan(35);
    for (const row of rows) expect(row.isConnected).toBe(true);
  });

  it("goes on by Tab to the next row, and back by Shift+Tab, though it wasn't drawn", async () => {
    const { list, scroller } = renderList();
    const row = list.querySelector<HTMLElement>('[data-row="row-2"]')!;
    act(() => row.focus());
    await scrollTo(scroller, 150 * (ROW + 1));
    expect(drawn(list)).not.toContain("row-3");
    await act(async () => {
      fireEvent.keyDown(row, { key: "Tab" });
      await nextFrame();
      await nextFrame();
    });
    expect(document.activeElement?.getAttribute("data-row")).toBe("row-3");
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
      await nextFrame();
    });
    expect(document.activeElement?.getAttribute("data-row")).toBe("row-2");
  });
});
