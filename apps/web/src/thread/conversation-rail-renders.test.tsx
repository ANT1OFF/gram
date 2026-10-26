// @vitest-environment happy-dom
import { cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useStable } from "@/lib/use-stable";

import { sameChapters, type Chapter } from "./parts";
import { ConversationRail } from "./table-of-contents";

/** Counts the rail's tooltips as they render; each chapter mark has one. */
const hints = vi.hoisted(() => ({ renders: 0 }));
vi.mock("@/components/hint", () => ({
  Hint: (props: { render: React.ReactElement; children: ReactNode }) => {
    hints.renders++;
    return (
      <span>
        {props.render}
        {props.children}
      </span>
    );
  },
}));

afterEach(cleanup);

const chapters: Chapter[] = Array.from({ length: 200 }, (_, i) => ({
  id: `c${i}`,
  messageId: `u${i}`,
  title: `Prompt ${i}`,
  kind: "prompt",
  index: i * 2,
}));

const rail = (onJump: (id: string) => void) => (
  <ConversationRail
    chapters={chapters}
    currentId="c199"
    onJump={onJump}
    earlier={false}
    onLoadEarlier={() => {}}
  />
);

describe("ConversationRail while a reply streams", () => {
  it("renders no chapter tooltip again when only the transcript's callbacks change", () => {
    const view = render(rail(() => {}));
    expect(hints.renders).toBe(200);
    // A streamed frame each: the transcript hands down new callbacks, the chapters stay.
    for (let frame = 0; frame < 10; frame++) view.rerender(rail(() => {}));
    expect(hints.renders).toBe(200);

    const latest = vi.fn();
    view.rerender(rail(latest));
    fireEvent.click(screen.getByRole("button", { name: "Prompt 7" }));
    expect(latest).toHaveBeenCalledWith("u7");
  });

  it("keeps a rebuilt chapter list's identity while it says the same", () => {
    const { result, rerender } = renderHook(
      ({ list }: { list: Chapter[] }) => useStable(list, sameChapters),
      { initialProps: { list: chapters } },
    );
    rerender({ list: chapters.map((chapter) => ({ ...chapter })) });
    expect(result.current).toBe(chapters);
    const retitled = chapters.map((chapter, i) =>
      i === 3 ? { ...chapter, title: "New" } : chapter,
    );
    rerender({ list: retitled });
    expect(result.current).toBe(retitled);
    rerender({ list: [...retitled, { ...chapters[0]!, id: "c200", index: 400 }] });
    expect(result.current).toHaveLength(201);
  });
});
