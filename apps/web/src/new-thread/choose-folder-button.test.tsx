// @vitest-environment happy-dom
import type { DesktopBridge } from "@gram/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChooseFolderButton } from "./choose-folder-button";

const withBridge = (bridge: Partial<DesktopBridge>) =>
  Object.defineProperty(window, "gram", { value: bridge, configurable: true });

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "gram");
});

describe("ChooseFolderButton", () => {
  it("is hidden without the desktop bridge", () => {
    render(<ChooseFolderButton onChoose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Choose folder…" })).toBeNull();
  });

  it("opens the system dialog at the current folder and takes the choice", async () => {
    const chooseFolder = vi.fn(async () => "/Users/dev/code/api");
    withBridge({ platform: "darwin", chooseFolder });
    const onChoose = vi.fn();
    render(<ChooseFolderButton onChoose={onChoose} defaultPath="/Users/dev/code" />);

    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    await waitFor(() => expect(onChoose).toHaveBeenCalledWith("/Users/dev/code/api"));
    expect(chooseFolder).toHaveBeenCalledWith({ defaultPath: "/Users/dev/code" });
  });

  it("keeps the current path when the dialog is cancelled", async () => {
    const chooseFolder = vi.fn(async () => undefined);
    withBridge({ platform: "win32", chooseFolder });
    const onChoose = vi.fn();
    render(<ChooseFolderButton onChoose={onChoose} />);

    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    await waitFor(() => expect(chooseFolder).toHaveBeenCalledWith({}));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Choose folder…" }).hasAttribute("disabled")).toBe(
        false,
      ),
    );
    expect(onChoose).not.toHaveBeenCalled();
  });
});
