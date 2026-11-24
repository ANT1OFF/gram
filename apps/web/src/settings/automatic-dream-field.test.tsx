// @vitest-environment happy-dom
import {
  DEFAULT_CHARTER,
  DEFAULT_MEMORY_UPDATE_EVERY_HOURS,
  DEFAULT_MEMORY_UPDATE_MIN_ITEMS,
  type OrchestratorCharter,
  type WorkspaceId,
} from "@gram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiProvider } from "@/api/context";
import type { Api } from "@/api/types";
import { AutomaticDreamField } from "./automatic-dream-field";

afterEach(cleanup);
const mount = (charter: Partial<OrchestratorCharter> = {}, disabled = false) => {
  const onChange = vi.fn();
  const automaticDreamStatus = vi.fn(async () => ({
    threshold: charter.automaticDreamThreshold ?? DEFAULT_MEMORY_UPDATE_MIN_ITEMS,
    completed: 3,
    everyHours: charter.memoryUpdateEveryHours ?? DEFAULT_MEMORY_UPDATE_EVERY_HOURS,
    detail: "Waiting while a worker is held by you.",
  }));
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ApiProvider api={{ automaticDreamStatus } as unknown as Api}>
        <AutomaticDreamField
          workspaceId={"workspace" as WorkspaceId}
          charter={{ ...DEFAULT_CHARTER, ...charter }}
          disabled={disabled}
          onChange={onChange}
        />
      </ApiProvider>
    </QueryClientProvider>,
  );
  return { onChange, automaticDreamStatus };
};
const toggle = () => screen.getByRole("switch", { name: "Update memory automatically" });
const items = () => screen.getByRole("spinbutton", { name: "New items per update" });
const hours = () => screen.getByRole("spinbutton", { name: "Hours between updates" });

describe("automatic memory update setting", () => {
  it("defaults off, and turning it on saves both conditions", () => {
    const f = mount();
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("spinbutton")).toBeNull();
    fireEvent.click(toggle());
    expect(f.onChange).toHaveBeenCalledWith({
      ...DEFAULT_CHARTER,
      memoryUpdateEveryHours: DEFAULT_MEMORY_UPDATE_EVERY_HOURS,
      automaticDreamThreshold: DEFAULT_MEMORY_UPDATE_MIN_ITEMS,
    });
    expect(f.automaticDreamStatus).not.toHaveBeenCalled();
  });

  it("shows an old threshold-only charter as on, with the default hours", () => {
    mount({ automaticDreamThreshold: 10 });
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect((items() as HTMLInputElement).value).toBe("10");
    expect((hours() as HTMLInputElement).value).toBe(String(DEFAULT_MEMORY_UPDATE_EVERY_HOURS));
  });

  it("validates each bound, saves each condition, and turning off drops both", () => {
    const f = mount({ automaticDreamThreshold: 10, memoryUpdateEveryHours: 24 });
    for (const value of ["0", "1.5", "1001"]) {
      fireEvent.change(items(), { target: { value } });
      fireEvent.blur(items());
      expect(screen.getByRole("alert").textContent).toContain("1 to 1000");
    }
    fireEvent.change(hours(), { target: { value: "169" } });
    fireEvent.blur(hours());
    expect(screen.getAllByRole("alert").some((a) => a.textContent.includes("1 to 168"))).toBe(true);
    expect(f.onChange).not.toHaveBeenCalled();
    fireEvent.change(items(), { target: { value: "25" } });
    fireEvent.keyDown(items(), { key: "Enter" });
    expect(f.onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_CHARTER,
      automaticDreamThreshold: 25,
      memoryUpdateEveryHours: 24,
    });
    fireEvent.change(hours(), { target: { value: "6" } });
    fireEvent.keyDown(hours(), { key: "Enter" });
    expect(f.onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_CHARTER,
      automaticDreamThreshold: 10,
      memoryUpdateEveryHours: 6,
    });
    fireEvent.click(toggle());
    expect(f.onChange).toHaveBeenLastCalledWith(DEFAULT_CHARTER);
  });

  it("prevents settings edits while a charter save is running", () => {
    const f = mount({ automaticDreamThreshold: 10 }, true);
    expect((items() as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(toggle());
    expect(f.onChange).not.toHaveBeenCalled();
  });
});
