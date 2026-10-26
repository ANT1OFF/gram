// @vitest-environment happy-dom
import type { ThreadId } from "@gram/contracts";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithApi } from "@/panels/test-utils";
import { useThreadsStore } from "@/stores/threads";

import { BindPrDialog } from "./bind-pr-dialog";

const T = "t-flaky" as ThreadId;

afterEach(() => {
  cleanup();
  useThreadsStore.setState({ byId: {} });
});

const setThread = () =>
  act(() => {
    useThreadsStore.setState({
      byId: {
        [T]: {
          thread: { id: T, title: "Fix flaky retry" },
          git: { origin: "example/api" },
        } as never,
      },
    });
  });

describe("BindPrDialog", () => {
  it("binds against the thread's origin and closes", async () => {
    setThread();
    const prBind = vi.fn(async () => ({}) as never);
    const onClose = vi.fn();
    renderWithApi(<BindPrDialog threadId={T} onClose={onClose} />, { prBind });

    const input = screen.getByRole("textbox", { name: "Pull request number or URL" });
    fireEvent.change(input, { target: { value: "#412" } });
    fireEvent.click(screen.getByRole("button", { name: "Bind" }));
    await waitFor(() => expect(prBind).toHaveBeenCalledWith(T, "example/api", 412));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("keeps the dialog open with the reason when binding fails", async () => {
    setThread();
    const prBind = vi.fn(async () => {
      throw new Error("PR #9 not found");
    });
    const onClose = vi.fn();
    renderWithApi(<BindPrDialog threadId={T} onClose={onClose} />, { prBind });

    fireEvent.change(screen.getByRole("textbox", { name: "Pull request number or URL" }), {
      target: { value: "9" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Bind" }));
    expect((await screen.findByRole("alert")).textContent).toBe("PR #9 not found");
    expect(onClose).not.toHaveBeenCalled();
  });
});
