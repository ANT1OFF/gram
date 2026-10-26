// @vitest-environment happy-dom
import { NotImplemented, type ThreadId, type ThreadSearchHit } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithApi } from "@/panels/test-utils";

import { FindBar } from "./find-bar";

const T = "t1" as ThreadId;
const hit = (messageId: string) =>
  ({ threadId: T, messageId, title: "t", snippet: messageId }) as ThreadSearchHit;

afterEach(cleanup);

/** A Find button that opens a `FindBar`, which unmounts once it closes. */
function Harness() {
  const [finding, setFinding] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setFinding(true)}>
        Find
      </button>
      {finding && <FindBar threadId={T} onReveal={() => {}} onClose={() => setFinding(false)} />}
    </>
  );
}

describe("FindBar", () => {
  it("searches within the thread and steps through the matches", async () => {
    const searchThreads = vi.fn(async () => ({ hits: [hit("m1"), hit("m2")], truncated: false }));
    const onReveal = vi.fn();
    renderWithApi(<FindBar threadId={T} onReveal={onReveal} onClose={() => {}} />, {
      searchThreads,
    });
    const input = screen.getByLabelText("Find in thread");

    fireEvent.change(input, { target: { value: "flaky" } });
    expect(await screen.findByText("1 of 2")).toBeTruthy();
    expect(searchThreads).toHaveBeenCalledWith("flaky", { limit: 200, threadId: T });
    expect(onReveal).toHaveBeenLastCalledWith("m1");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("2 of 2")).toBeTruthy();
    expect(onReveal).toHaveBeenLastCalledWith("m2");

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(await screen.findByText("1 of 2")).toBeTruthy();
    expect(onReveal).toHaveBeenLastCalledWith("m1");
  });

  it("marks a truncated result and says when nothing matches", async () => {
    const searchThreads = vi
      .fn()
      .mockResolvedValueOnce({ hits: [hit("m1")], truncated: true })
      .mockResolvedValueOnce({ hits: [], truncated: false });
    renderWithApi(<FindBar threadId={T} onReveal={() => {}} onClose={() => {}} />, {
      searchThreads,
    });
    const input = screen.getByLabelText("Find in thread");
    fireEvent.change(input, { target: { value: "flaky" } });
    expect(await screen.findByText("1 of 1+")).toBeTruthy();
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(await screen.findByText("No matches")).toBeTruthy();
  });

  it("says when search isn't available, and closes on Escape", async () => {
    const onClose = vi.fn();
    renderWithApi(<FindBar threadId={T} onReveal={() => {}} onClose={onClose} />, {
      searchThreads: async () => {
        throw new NotImplemented({ rpc: "thread.search" });
      },
    });
    const input = screen.getByLabelText("Find in thread");
    fireEvent.change(input, { target: { value: "flaky" } });
    expect(await screen.findByText("Search isn't available yet")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("gives focus back to what had it once it closes", async () => {
    renderWithApi(<Harness />, { searchThreads: async () => ({ hits: [], truncated: false }) });
    const opener = screen.getByRole("button", { name: "Find" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.keyDown(screen.getByLabelText("Find in thread"), { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});
