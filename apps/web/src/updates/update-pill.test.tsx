// @vitest-environment happy-dom
import type { AppUpdateState, DesktopBridge } from "@gram/contracts";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("@/settings/use-diagnostics", () => ({ useFeature: () => true }));

import { useUpdateStore } from "./store";
import { UpdatePill } from "./update-pill";

const base: AppUpdateState = {
  status: "idle",
  channel: "prerelease",
  currentVersion: "0.1.0-rc.17",
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: null,
  releaseDate: null,
  percent: null,
  checkedAt: null,
  manual: false,
  message: null,
  errorStep: null,
  notApplied: null,
  canInstall: true,
};

function bridgeWith(next: Partial<AppUpdateState> = {}) {
  const resolve = async () => ({ ...base, ...next });
  const native = {
    state: vi.fn(resolve),
    onState: vi.fn(() => () => {}),
    check: vi.fn(resolve),
    download: vi.fn(resolve),
    install: vi.fn(resolve),
    dismiss: vi.fn(resolve),
  };
  Object.defineProperty(window, "gram", {
    value: { updates: { native } } as unknown as DesktopBridge,
    configurable: true,
  });
  return native;
}

const show = (patch: Partial<AppUpdateState>) =>
  act(() => useUpdateStore.setState({ native: { ...base, ...patch } }));

afterEach(() => {
  cleanup();
  navigate.mockReset();
  Reflect.deleteProperty(window, "gram");
  useUpdateStore.setState({ native: undefined });
});

describe("UpdatePill", () => {
  it("renders nothing on the private updater, before a check, or when current", () => {
    bridgeWith();
    const { container } = render(<UpdatePill />);
    expect(container.innerHTML).toBe("");
    act(() => useUpdateStore.setState({ native: null }));
    expect(container.innerHTML).toBe("");
    show({ status: "upToDate", checkedAt: 1 });
    expect(container.innerHTML).toBe("");
  });

  it("downloads an available update on click and shows the state main answers with", async () => {
    const native = bridgeWith({
      status: "downloading",
      availableVersion: "0.1.0-rc.18",
      percent: 5,
    });
    render(<UpdatePill />);
    show({ status: "available", availableVersion: "0.1.0-rc.18" });
    const pill = screen.getByTestId("update-pill");
    expect(pill.getAttribute("aria-label")).toBe("Download Gram 0.1.0-rc.18");
    await act(async () => {
      fireEvent.click(pill);
    });
    expect(native.download).toHaveBeenCalledOnce();
    expect(screen.getByTestId("update-pill").dataset["kind"]).toBe("downloading");
    expect(screen.getByTestId("update-pill").textContent).toBe("5%");
  });

  it("does nothing on click while downloading", () => {
    const native = bridgeWith();
    render(<UpdatePill />);
    show({ status: "downloading", availableVersion: "0.1.0-rc.18", percent: 60 });
    const pill = screen.getByTestId("update-pill");
    expect(pill.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(pill);
    expect(native.download).not.toHaveBeenCalled();
    expect(native.install).not.toHaveBeenCalled();
  });

  it("restarts into the ready version, labelled Restart", async () => {
    const native = bridgeWith({ status: "installing", downloadedVersion: "0.1.0-rc.18" });
    render(<UpdatePill />);
    show({ status: "ready", availableVersion: "0.1.0-rc.18", downloadedVersion: "0.1.0-rc.18" });
    expect(screen.getByTestId("update-pill").textContent).toBe("Restart");
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Restart to update to Gram 0.1.0-rc.18" }),
      );
    });
    expect(native.install).toHaveBeenCalledWith("0.1.0-rc.18");
    expect(screen.getByTestId("update-pill").textContent).toBe("Restarting…");
  });

  it("retries a refused restart, and opens Settings for an update that wasn't applied", async () => {
    const native = bridgeWith();
    render(<UpdatePill />);
    show({
      status: "error",
      errorStep: "install",
      downloadedVersion: "0.1.0-rc.18",
      message: "Didn't restart: an agent didn't stop cleanly. Nothing was installed.",
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("update-pill"));
    });
    expect(native.install).toHaveBeenCalledWith("0.1.0-rc.18");
    show({
      status: "upToDate",
      notApplied: { version: "0.1.0-rc.18", reason: "See ShipIt_stderr.log." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Gram 0.1.0-rc.18 wasn't applied" }));
    expect(navigate).toHaveBeenCalledWith({ to: "/settings/updates" });
  });

  it("checks again after a manual check failed", async () => {
    const native = bridgeWith();
    render(<UpdatePill />);
    show({ status: "error", errorStep: "check", manual: true, message: "offline" });
    await act(async () => {
      fireEvent.click(screen.getByTestId("update-pill"));
    });
    expect(native.check).toHaveBeenCalledWith("prerelease");
  });
});
