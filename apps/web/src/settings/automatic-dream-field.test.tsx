// @vitest-environment happy-dom
import { DEFAULT_CHARTER, type WorkspaceId } from "@gram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiProvider } from "@/api/context";
import type { Api } from "@/api/types";
import { AutomaticDreamField } from "./automatic-dream-field";

afterEach(cleanup);
const mount = (threshold?: number, disabled = false) => {
  const onChange = vi.fn();
  const automaticDreamStatus = vi.fn(async () => ({
    threshold,
    completed: 3,
    detail: "Waiting while a worker is held by you.",
  }));
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ApiProvider api={{ automaticDreamStatus } as unknown as Api}>
        <AutomaticDreamField
          workspaceId={"workspace" as WorkspaceId}
          charter={{
            ...DEFAULT_CHARTER,
            ...(threshold === undefined ? {} : { automaticDreamThreshold: threshold }),
          }}
          disabled={disabled}
          onChange={onChange}
        />
      </ApiProvider>
    </QueryClientProvider>,
  );
  return { onChange, automaticDreamStatus };
};
describe("automatic Dream setting", () => {
  it("defaults off and enables an editable threshold of ten without adoption authority", () => {
    const f = mount();
    expect(
      screen.getByRole("switch", { name: "Dream automatically" }).getAttribute("aria-checked"),
    ).toBe("false");
    expect(screen.queryByRole("spinbutton")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Dream automatically" }));
    expect(f.onChange).toHaveBeenCalledWith({ ...DEFAULT_CHARTER, automaticDreamThreshold: 10 });
    expect(f.automaticDreamStatus).not.toHaveBeenCalled();
  });
  it("shows progress/deferred reason, validates bounds, and explains fresh-count edits", async () => {
    const f = mount(10);
    expect(await screen.findByText(/3 \/ 10 completed threads/)).toBeTruthy();
    expect(
      screen.getByText(/Turning this on or changing the threshold starts a fresh count/),
    ).toBeTruthy();
    const input = screen.getByRole("spinbutton", { name: "Completed threads before Dream" });
    for (const value of ["0", "1.5", "1001"]) {
      fireEvent.change(input, { target: { value } });
      fireEvent.blur(input);
      expect(screen.getByRole("alert").textContent).toContain("1 to 1000");
    }
    expect(f.onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "25" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(f.onChange).toHaveBeenCalledWith({ ...DEFAULT_CHARTER, automaticDreamThreshold: 25 });
    fireEvent.click(screen.getByRole("switch", { name: "Dream automatically" }));
    expect(f.onChange).toHaveBeenLastCalledWith(DEFAULT_CHARTER);
  });
  it("prevents settings edits while a charter save is running", () => {
    const f = mount(10, true);
    expect((screen.getByRole("spinbutton") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: "Dream automatically" }));
    expect(f.onChange).not.toHaveBeenCalled();
  });
});
