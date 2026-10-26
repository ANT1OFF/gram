// @vitest-environment happy-dom
import type { DesktopBridge, DesktopPreview, ThreadId } from "@gram/contracts";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockApi } from "@/api/mock";
import { renderWithApi } from "@/panels/test-utils";
import { useLayoutStore } from "@/stores/layout";

import { PortChips } from "./port-chips";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

const T = "t-ports" as ThreadId;

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "gram");
});

const renderChips = (ports: readonly number[] | undefined, compact = false) => {
  const api = createMockApi({ speed: 0, autoplay: false });
  const onRowClick = vi.fn();
  renderWithApi(
    <div onClick={onRowClick}>
      <PortChips threadId={T} ports={ports} compact={compact} />
    </div>,
    api,
  );
  return { api, onRowClick };
};

describe("PortChips", () => {
  it("renders nothing without ports", () => {
    renderChips([]);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("opens the port through the server without a desktop bridge, and never clicks the row", () => {
    const { api, onRowClick } = renderChips([3000, 5173]);
    expect(screen.getAllByRole("button").map((chip) => chip.textContent)).toEqual([
      ":3000",
      ":5173",
    ]);
    fireEvent.click(screen.getByTestId("port-chip-5173"));
    expect(api.opened).toEqual(["http://localhost:5173"]);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("draws a lone compact port as a globe, and keeps the numbers of several", () => {
    renderChips([3000], true);
    const chip = screen.getByTestId("port-chip-3000");
    expect(chip.querySelector("svg")).toBeTruthy();
    expect(chip.querySelector(".sr-only")?.textContent).toBe(":3000");
    expect(chip.getAttribute("title")).toBe("Open http://localhost:3000");
    cleanup();

    renderChips([3000, 5173], true);
    expect(screen.getByTestId("port-chip-5173").querySelector(".sr-only")).toBeNull();
  });

  it("prefers the desktop bridge when present", () => {
    const openExternal = vi.fn(async () => true);
    Object.defineProperty(window, "gram", {
      value: { openExternal } as unknown as DesktopBridge,
      configurable: true,
    });
    const { api } = renderChips([3000]);
    fireEvent.keyDown(screen.getByTestId("port-chip-3000"), { key: "Enter" });
    expect(openExternal).toHaveBeenCalledWith("http://localhost:3000");
    expect(api.opened).toEqual([]);
  });

  it("opens by port number alone where the shell offers it, so no link dialog asks", async () => {
    const openExternal = vi.fn(async () => true);
    const openLocalPort = vi.fn(async () => true);
    Object.defineProperty(window, "gram", {
      value: { openExternal, openLocalPort } as unknown as DesktopBridge,
      configurable: true,
    });
    renderChips([3000]);
    fireEvent.keyDown(screen.getByTestId("port-chip-3000"), { key: "Enter" });
    await vi.waitFor(() => expect(openLocalPort).toHaveBeenCalledWith(3000));
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("opens the thread's Preview tab where the shell has one, and the browser on ⌘-click", async () => {
    const openLocalPort = vi.fn(async () => true);
    Object.defineProperty(window, "gram", {
      value: { openLocalPort, preview: {} as DesktopPreview } as unknown as DesktopBridge,
      configurable: true,
    });
    useLayoutStore.setState({ previewPages: {} });
    renderChips([5173]);
    const chip = screen.getByTestId("port-chip-5173");
    expect(chip.getAttribute("title")).toMatch(/^Preview http:\/\/localhost:5173 \(/);

    fireEvent.click(chip);
    // Into the thread's route, so the panel follows from a page without a thread.
    expect(navigate).toHaveBeenCalledWith({ to: "/t/$threadId", params: { threadId: T } });
    expect(useLayoutStore.getState()).toMatchObject({ panelTab: "preview", panelOpen: true });
    expect(useLayoutStore.getState().previewPages[T]?.url).toBe("http://localhost:5173/");
    expect(openLocalPort).not.toHaveBeenCalled();

    fireEvent.click(chip, { metaKey: true });
    await vi.waitFor(() => expect(openLocalPort).toHaveBeenCalledWith(5173));
  });
});
