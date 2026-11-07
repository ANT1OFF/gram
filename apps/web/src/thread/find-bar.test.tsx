// @vitest-environment happy-dom
import type { GramUIMessage, ThreadId, ThreadSearchHit } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithApi } from "@/panels/test-utils";

import { FindBar } from "./find-bar";

const T = "t1" as ThreadId;
const hit = (messageId: string) =>
  ({ threadId: T, messageId, title: "t", snippet: messageId }) as ThreadSearchHit;

const said = (id: string, text: string) =>
  ({ id, role: "assistant", parts: [{ type: "text", text }] }) as unknown as GramUIMessage;
const ran = (id: string, output: string) =>
  ({
    id,
    role: "assistant",
    parts: [
      {
        type: "tool-Bash",
        toolCallId: `call-${id}`,
        state: "output-available",
        input: { command: "bun test" },
        output,
      },
    ],
  }) as unknown as GramUIMessage;

const MESSAGES = [
  said("m1", "The flaky test again"),
  said("m2", "Flaky once, FLAKY twice"),
  ran("m3", "1 failed: flaky.test.ts"),
];

afterEach(cleanup);

const status = () => screen.getByTestId("find-status");

/** The transcript's scroller, which has drawn none of the rows. */
const emptyScroller = () => document.createElement("div");

const bar = (props: Partial<Parameters<typeof FindBar>[0]> = {}) => (
  <FindBar
    threadId={T}
    messages={MESSAGES}
    earlier={false}
    getScroller={emptyScroller}
    onReveal={() => {}}
    onClose={() => {}}
    {...props}
  />
);

/** A Find button that opens a `FindBar`, which unmounts once it closes. */
function Harness() {
  const [finding, setFinding] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setFinding(true)}>
        Find
      </button>
      {finding && bar({ onClose: () => setFinding(false) })}
    </>
  );
}

describe("FindBar", () => {
  it("counts every match in loaded messages, tool output included, newest first", async () => {
    const onReveal = vi.fn();
    renderWithApi(bar({ onReveal }), {});
    const input = screen.getByLabelText("Find in thread");

    fireEvent.change(input, { target: { value: "flaky" } });
    expect(await screen.findByText("4 of 4")).toBeTruthy();
    expect(screen.getByTestId("find-in-tool")).toBeTruthy();
    // The transcript hasn't drawn its row, so it is asked for.
    expect(onReveal).toHaveBeenLastCalledWith("m3");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("3 of 4")).toBeTruthy();
    expect(screen.queryByTestId("find-in-tool")).toBeNull();
    expect(onReveal).toHaveBeenLastCalledWith("m2");

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    // Past the newest, round to the oldest.
    expect(await screen.findByText("1 of 4")).toBeTruthy();
    expect(onReveal).toHaveBeenLastCalledWith("m1");
  });

  it("puts the server's hits in history not loaded yet before the loaded ones", async () => {
    const searchThreads = vi.fn(async () => ({
      hits: [hit("old1"), hit("m1")],
      truncated: false,
    }));
    renderWithApi(bar({ earlier: true }), { searchThreads });
    const input = screen.getByLabelText("Find in thread");
    fireEvent.change(input, { target: { value: "flaky" } });
    expect(await screen.findByText("5 of 5")).toBeTruthy();
    expect(searchThreads).toHaveBeenCalledWith("flaky", { limit: 200, threadId: T });
  });

  it("stays busy from the first keystroke until the server has answered that query", async () => {
    const searchThreads = vi.fn(async (query: string) => ({
      hits: query === "flaky" ? [hit("old1")] : [],
      truncated: false,
    }));
    renderWithApi(bar({ earlier: true }), { searchThreads });
    const input = screen.getByLabelText("Find in thread");

    fireEvent.change(input, { target: { value: "flaky" } });
    // Still waiting out the debounce: the loaded matches, and the count may grow.
    expect(status().textContent).toBe("4 of 4");
    expect(status().getAttribute("aria-busy")).toBe("true");
    expect(await screen.findByText("5 of 5")).toBeTruthy();
    expect(status().getAttribute("aria-busy")).toBeNull();

    fireEvent.change(input, { target: { value: "flaky test" } });
    // The previous query's older hit doesn't count for this one.
    expect(status().textContent).toBe("1 of 1");
    expect(status().getAttribute("aria-busy")).toBe("true");
    await waitFor(() => expect(status().getAttribute("aria-busy")).toBeNull());
    expect(status().textContent).toBe("1 of 1");
    expect(searchThreads).toHaveBeenLastCalledWith("flaky test", { limit: 200, threadId: T });
  });

  it("says when nothing matches", async () => {
    renderWithApi(bar(), {});
    fireEvent.change(screen.getByLabelText("Find in thread"), { target: { value: "zzz" } });
    expect(await screen.findByText("No matches")).toBeTruthy();
  });

  it("goes back to where the transcript stood on Escape, and stays on close", () => {
    const scroller = document.createElement("div");
    const onClose = vi.fn();
    renderWithApi(bar({ getScroller: () => scroller, onClose }), {});
    fireEvent.keyDown(screen.getByLabelText("Find in thread"), { key: "Escape" });
    expect(onClose).toHaveBeenLastCalledWith(expect.objectContaining({ atEnd: true }));
    fireEvent.click(screen.getByRole("button", { name: "Close find, staying here" }));
    expect(onClose).toHaveBeenLastCalledWith(undefined);
  });

  it("gives focus back to what had it once it closes", async () => {
    renderWithApi(<Harness />, {});
    const opener = screen.getByRole("button", { name: "Find" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.keyDown(screen.getByLabelText("Find in thread"), { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});
