import type { ThreadId } from "@gram/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  commentLabel,
  useDiffCommentsStore,
  withDiffComments,
  type DiffComment,
} from "./diff-comments";

const T = "t-1" as ThreadId;
const comment = (id: string, changes: Partial<DiffComment> = {}): DiffComment => ({
  id,
  path: "src/a.ts",
  side: "new",
  start: 3,
  end: 3,
  snippet: "+x",
  note: "why x?",
  ...changes,
});

beforeEach(() => useDiffCommentsStore.setState({ byThread: {} }));

describe("diff comments", () => {
  it("labels a range by file and lines, and says when the numbers are the old file's", () => {
    expect(commentLabel(comment("a"))).toBe("src/a.ts:3");
    expect(commentLabel(comment("a", { start: 3, end: 9, side: "old" }))).toBe(
      "src/a.ts:3-9 (removed)",
    );
  });

  it("fences a snippet longer than any backticks in it", () => {
    const text = withDiffComments([comment("a", { snippet: "+const s = ```;" })], "");
    expect(text).toBe(
      "A review comment on the diff:\n\nsrc/a.ts:3\n````diff\n+const s = ```;\n````\nwhy x?",
    );
    expect(withDiffComments([], "hi")).toBe("hi");
  });

  it("takes a thread's comments and puts them back ahead of newer ones", () => {
    const store = useDiffCommentsStore.getState();
    store.add(T, comment("a"));
    store.add(T, comment("b"));
    const taken = store.take(T);
    expect(taken.map((c) => c.id)).toEqual(["a", "b"]);
    expect(useDiffCommentsStore.getState().byThread[T]).toEqual([]);

    store.add(T, comment("c"));
    store.restore(T, taken);
    store.setNote(T, "b", "changed");
    store.remove(T, "a");
    expect(useDiffCommentsStore.getState().byThread[T]!.map((c) => [c.id, c.note])).toEqual([
      ["b", "changed"],
      ["c", "why x?"],
    ]);
  });
});
