// @vitest-environment happy-dom
import type { FileEdit, ThreadId } from "@gram/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { editDiffFile, FileEditCard } from "./file-edit-card";
import type { AnyToolPart } from "./parts";

const shown = vi.hoisted(() => [] as unknown[][]);
vi.mock("@/panels/files/files-store", () => ({
  showFileAt: (...args: unknown[]) => shown.push(args),
}));
const scope = vi.hoisted(() => ({
  current: undefined as { threadId: ThreadId; roots: string[] } | undefined,
}));
vi.mock("./file-ref-link", () => ({ useFileRefsScope: () => scope.current }));

beforeEach(() => {
  shown.length = 0;
  scope.current = { threadId: "t1" as ThreadId, roots: ["/repo"] };
});
afterEach(cleanup);

const part = (
  type: string,
  input: object,
  state: AnyToolPart["state"] = "output-available",
  extra: object = {},
) =>
  ({ type, toolCallId: "c1", state, input, output: undefined, ...extra }) as unknown as AnyToolPart;

const PATCH = {
  filePath: "/repo/src/a.ts",
  structuredPatch: [
    {
      oldStart: 10,
      oldLines: 2,
      newStart: 10,
      newLines: 3,
      lines: [" keep", "-old", "+new", "+more"],
    },
  ],
};

describe("FileEditCard", () => {
  it("folds an edit into one row that opens to its numbered diff", () => {
    render(
      <FileEditCard
        part={part("tool-Edit", { file_path: "/repo/src/a.ts" }, "output-available", {
          output: PATCH,
        })}
      />,
    );
    const row = screen.getByTestId("file-edit");
    expect(row.textContent).toBe("Edited a.ts +2 −1");
    expect(screen.queryByTestId("patch")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show changes to a.ts" }));
    const rows = [...screen.getByTestId("patch").querySelectorAll("tr[data-kind]")];
    expect(rows.map((tr) => [tr.getAttribute("data-kind"), tr.textContent])).toEqual([
      ["ctx", "1010 keep"],
      ["del", "11−old"],
      ["add", "11+new"],
      ["add", "12+more"],
    ]);
    expect(row.getAttribute("data-open")).toBe("true");
  });

  it("opens the file in the Files panel from its name, with the full path on hover", () => {
    render(
      <FileEditCard
        part={part("tool-Edit", { file_path: "/repo/src/a.ts" }, "output-available", {
          output: PATCH,
        })}
      />,
    );
    const name = screen.getByRole("button", { name: "a.ts" });
    expect(name.getAttribute("title")).toBe("/repo/src/a.ts");
    fireEvent.click(name);
    expect(shown).toEqual([["t1", ["/repo"], "/repo/src/a.ts"]]);
    // The name opens the file without opening the diff.
    expect(screen.queryByTestId("patch")).toBeNull();
  });

  it("doesn't link a deleted file or a credential file", () => {
    render(
      <FileEditCard
        part={part(
          "dynamic-tool",
          {
            changes: [
              { path: "/repo/gone.ts", kind: { type: "delete" }, diff: "x\n" },
              {
                path: "/repo/.env",
                kind: { type: "update", move_path: null },
                diff: "@@ -1 +1 @@\n-A=1\n+A=2\n",
              },
            ],
          },
          "output-available",
          { toolName: "Edit" },
        )}
      />,
    );
    const [deleted, secret] = screen.getAllByTestId("file-edit");
    expect(deleted!.textContent).toBe("Deleted gone.ts ");
    expect(secret!.textContent).toBe("Edited .env +1 −1");
    expect(screen.queryByRole("button", { name: "gone.ts" })).toBeNull();
    expect(screen.queryByRole("button", { name: ".env" })).toBeNull();
  });

  it("says a call in flight is still editing, and names a refusal", () => {
    render(
      <FileEditCard
        part={part(
          "tool-Edit",
          { file_path: "/repo/a.ts", old_string: "x", new_string: "y" },
          "input-available",
        )}
      />,
    );
    expect(screen.getByTestId("file-edit").textContent).toBe("Editing a.ts… ");
    cleanup();
    render(
      <FileEditCard
        part={part("tool-Write", { file_path: "/repo/a.ts", content: "x" }, "output-denied")}
      />,
    );
    expect(screen.getByTestId("file-edit").textContent).toBe("Writing a.ts +1Denied");
  });

  it("hides line numbers that aren't the file's", () => {
    render(
      <FileEditCard
        part={part(
          "tool-Edit",
          { file_path: "/repo/a.ts", old_string: "x", new_string: "y" },
          "output-available",
          {
            output: "The file /repo/a.ts has been updated successfully.",
          },
        )}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show changes to a.ts" }));
    const rows = [...screen.getByTestId("patch").querySelectorAll("tr[data-kind]")];
    expect(rows.map((tr) => tr.textContent)).toEqual(["−x", "+y"]);
  });

  it("has a quiet line for a call that hasn't named its file", () => {
    render(<FileEditCard part={part("tool-Edit", {}, "input-streaming")} />);
    expect(screen.getByTestId("file-edit").textContent).toBe("Editing…");
  });
});

describe("editDiffFile", () => {
  it("writes the hunks as the patch the diff panel reads", () => {
    const edit: FileEdit = {
      path: "/r/a.ts",
      movedTo: "/r/b.ts",
      kind: "modify",
      hunks: PATCH.structuredPatch,
      numbered: true,
      additions: 2,
      deletions: 1,
    };
    expect(editDiffFile(edit)).toEqual({
      path: "/r/b.ts",
      oldPath: "/r/a.ts",
      status: "modified",
      additions: 2,
      deletions: 1,
      patch: "@@ -10,2 +10,3 @@\n keep\n-old\n+new\n+more",
      binary: false,
      tooLarge: false,
    });
  });
});
