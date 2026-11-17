// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { CodeEditor, type CodeEditorHandle, type CodeEditorMarker } from "./code-editor";
import { Diff } from "./diff";

afterEach(cleanup);

function Editor({
  initial,
  markers,
  readOnly,
  editor,
}: {
  initial: string;
  markers?: CodeEditorMarker[];
  readOnly?: boolean;
  editor?: React.Ref<CodeEditorHandle>;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <CodeEditor
        label="Code"
        value={value}
        onChange={setValue}
        {...(markers ? { markers } : {})}
        {...(readOnly ? { readOnly } : {})}
        ref={editor}
      />
      <output data-testid="value">{value}</output>
    </>
  );
}

const text = () => screen.getByRole("textbox", { name: "Code" }) as HTMLTextAreaElement;

describe("CodeEditor", () => {
  it("indents with Tab, and lets Tab move on after Escape", () => {
    render(<Editor initial={"a\nb"} />);
    const area = text();
    area.setSelectionRange(0, 0);
    fireEvent.keyDown(area, { key: "Tab" });
    expect(screen.getByTestId("value").textContent).toBe("  a\nb");
    fireEvent.keyDown(area, { key: "Escape" });
    const moved = fireEvent.keyDown(area, { key: "Tab" });
    expect(moved).toBe(true);
    expect(screen.getByTestId("value").textContent).toBe("  a\nb");
  });

  it("is read only without onChange or when asked, and Tab then moves on", () => {
    render(<CodeEditor label="Code" value="x" />);
    expect(text().readOnly).toBe(true);
    expect(fireEvent.keyDown(text(), { key: "Tab" })).toBe(true);
    cleanup();
    render(<Editor initial="x" readOnly />);
    expect(text().readOnly).toBe(true);
    expect(fireEvent.keyDown(text(), { key: "Tab" })).toBe(true);
  });

  it("finds case-insensitively, steps through matches and closes back to the text", async () => {
    render(<Editor initial={"Alpha\nbeta alpha\nALPHA"} readOnly />);
    fireEvent.keyDown(text(), { key: "f", ctrlKey: true });
    const find = screen.getByRole("textbox", { name: "Find" });
    fireEvent.change(find, { target: { value: "alpha" } });
    expect(screen.getByText("1 of 3")).toBeTruthy();
    fireEvent.keyDown(find, { key: "Enter" });
    expect(screen.getByText("2 of 3")).toBeTruthy();
    fireEvent.keyDown(find, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(find, { key: "Enter", shiftKey: true });
    expect(screen.getByText("3 of 3")).toBeTruthy();
    fireEvent.change(find, { target: { value: "gamma" } });
    expect(screen.getByText("No matches")).toBeTruthy();
    fireEvent.change(find, { target: { value: "beta" } });
    fireEvent.keyDown(find, { key: "Escape" });
    expect(screen.queryByRole("search")).toBeNull();
    expect(document.activeElement).toBe(text());
    expect([text().selectionStart, text().selectionEnd]).toEqual([6, 10]);
  });

  it("opens Find from its handle, and goes to a line", () => {
    const editor = createRef<CodeEditorHandle>();
    render(<Editor initial={"one\ntwo\nthree"} editor={editor} />);
    act(() => editor.current!.find("two"));
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Find" }).value).toBe("two");
    expect(screen.getByText("1 of 1")).toBeTruthy();
    act(() => editor.current!.goToLine(3));
    expect(text().selectionStart).toBe(8);
    act(() => editor.current!.goToLine(99));
    expect(text().selectionStart).toBe(8);
  });

  it("marks the host's problems on their lines, lists them, and goes to one", () => {
    render(
      <Editor
        initial={"one\ntwo\nthree"}
        markers={[
          { line: 2, message: "Unexpected token" },
          { line: 9, message: "Past the end" },
        ]}
      />,
    );
    expect(text().getAttribute("aria-invalid")).toBe("true");
    const list = screen.getByRole("list", { name: "Problems" });
    expect(list.textContent).toContain("Line 2.Unexpected token");
    expect(document.querySelectorAll("[data-marked-line]")).toHaveLength(1);
    expect(text().getAttribute("aria-describedby")).toContain(list.id);
    fireEvent.click(screen.getByRole("button", { name: /Line 2\./ }));
    expect(document.activeElement).toBe(text());
    expect(text().selectionStart).toBe(4);
  });

  it("is not marked invalid without markers", () => {
    render(<Editor initial="ok" />);
    expect(text().hasAttribute("aria-invalid")).toBe(false);
    expect(screen.queryByRole("list", { name: "Problems" })).toBeNull();
  });
});

describe("Diff", () => {
  it("shows added and removed lines with their numbers, and opens a folded run", () => {
    const before = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
    const after = before.replace("line 10", "line ten");
    render(<Diff before={before} after={after} words />);
    const region = screen.getByRole("region", { name: "Changes" });
    expect(region.querySelector("del")!.textContent).toBe("Removed line 10: line 10");
    expect(region.querySelector("ins")!.textContent).toBe("Added line 10: line ten");
    expect(region.querySelector('[data-word="add"]')!.textContent).toBe("ten");
    fireEvent.click(screen.getByRole("button", { name: "Show 6 unchanged lines" }));
    expect(region.textContent).toContain("line 1");
    expect(region.querySelectorAll('[data-kind="same"]')).toHaveLength(11);
  });

  it("says when nothing changed or the texts are too large", () => {
    render(<Diff before="a" after="a" unchanged="Same." />);
    expect(screen.getByText("Same.")).toBeTruthy();
    render(<Diff before={"a\nb\nc"} after="x" maxLines={2} />);
    expect(screen.getByText("Too large to compare.")).toBeTruthy();
  });
});
