// @vitest-environment happy-dom
import type { CheckoutUser, ThreadId } from "@gram/contracts";
import { cleanup, fireEvent, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiProvider } from "@/api/context";
import type { Api } from "@/api/types";
import { renderWithApi } from "@/panels/test-utils";
import { EMPTY_GRID, useLayoutStore } from "@/stores/layout";

import { CheckoutInUseNotice, useCheckoutUsers } from "./checkout-in-use";

const navigate = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useParams: () => ({}),
}));

afterEach(() => {
  cleanup();
  navigate.mockReset();
  useLayoutStore.setState({ grid: EMPTY_GRID });
});

const user = (id: string, title: string, parked = false): CheckoutUser => ({
  threadId: id as ThreadId,
  title,
  parked,
});

describe("CheckoutInUseNotice", () => {
  it("names the thread, opens it, and offers a worktree or creating anyway", () => {
    const onUseNewWorktree = vi.fn();
    const onCreateAnyway = vi.fn();
    renderWithApi(
      <CheckoutInUseNotice
        users={[user("t-docs", "Rewrite the README")]}
        repo
        refused={false}
        onUseNewWorktree={onUseNewWorktree}
        onCreateAnyway={onCreateAnyway}
      />,
      {},
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "“Rewrite the README” is already open in this checkout",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open “Rewrite the README”" }));
    expect(useLayoutStore.getState().grid.panes).toContain("t-docs");
    expect(navigate).toHaveBeenCalledWith({ to: "/t/$threadId", params: { threadId: "t-docs" } });

    fireEvent.click(screen.getByRole("button", { name: "Use a new worktree instead" }));
    expect(onUseNewWorktree).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Create here anyway" }));
    expect(onCreateAnyway).toHaveBeenCalledOnce();
  });

  it("says parked threads count, and offers no create-anyway where the server refuses", () => {
    renderWithApi(
      <CheckoutInUseNotice
        users={[user("t-a", "Spike"), user("t-b", "Old work", true)]}
        repo={false}
        refused
        onCreateAnyway={vi.fn()}
      />,
      {},
    );

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("2 threads are already open in this folder");
    expect(alert.textContent).toContain("Parked threads still use their checkout.");
    expect(screen.getByRole("button", { name: "Open “Old work” (parked)" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create here anyway" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Use a new worktree instead" })).toBeNull();
  });
});

describe("useCheckoutUsers", () => {
  it("asks the server who uses the path, and nothing without one", async () => {
    const checkoutUsers = vi.fn(async () => ({ threads: [user("t-docs", "Rewrite the README")] }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ApiProvider api={{ checkoutUsers } as unknown as Api}>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </ApiProvider>
    );

    const { result, rerender } = renderHook(({ path }) => useCheckoutUsers(path), {
      wrapper,
      initialProps: { path: undefined as string | undefined },
    });
    expect(result.current).toEqual([]);
    expect(checkoutUsers).not.toHaveBeenCalled();

    rerender({ path: "/Users/dev/code/docs" });
    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(checkoutUsers).toHaveBeenCalledWith("/Users/dev/code/docs");
  });
});
