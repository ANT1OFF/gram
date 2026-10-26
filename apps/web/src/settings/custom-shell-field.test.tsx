// @vitest-environment happy-dom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithApi } from "@/panels/test-utils";

import { CustomShellField } from "./custom-shell-field";

afterEach(cleanup);

const submit = (value: string) => {
  fireEvent.change(screen.getByRole("textbox", { name: "Custom shell path" }), {
    target: { value },
  });
  fireEvent.click(screen.getByRole("button", { name: "Use this shell" }));
};

describe("CustomShellField", () => {
  it("saves a shell the server finds, naming what terminals will start", async () => {
    const terminalCheckShell = vi.fn(async () => ({
      found: true,
      file: "C:\\Program Files\\Git\\bin\\bash.exe",
    }));
    const onSave = vi.fn();
    renderWithApi(<CustomShellField value={undefined} onSave={onSave} />, { terminalCheckShell });

    submit("  C:\\Program Files\\Git\\bin\\bash.exe ");
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith("C:\\Program Files\\Git\\bin\\bash.exe"),
    );
    expect(terminalCheckShell).toHaveBeenCalledWith("C:\\Program Files\\Git\\bin\\bash.exe");
    expect(screen.getByRole("status").textContent).toBe(
      "Terminals start C:\\Program Files\\Git\\bin\\bash.exe.",
    );
  });

  it("shows the server's message and saves nothing for a missing shell", async () => {
    const terminalCheckShell = vi.fn(async () => ({
      found: false,
      message:
        "D:\\missing\\fish.exe doesn't exist. Choose an installed terminal shell in Settings.",
    }));
    const onSave = vi.fn();
    renderWithApi(<CustomShellField value={undefined} onSave={onSave} />, { terminalCheckShell });

    submit("D:\\missing\\fish.exe");
    expect((await screen.findByRole("alert")).textContent).toContain("doesn't exist");
    expect(onSave).not.toHaveBeenCalled();
  });
});
