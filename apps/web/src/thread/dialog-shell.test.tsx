// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { Dialog, DialogShell } from "./dialog-shell";

afterEach(cleanup);

/** A dialog opened from a store (no trigger), as the thread dialogs are. */
function Harness({ removeOpener = false }: { removeOpener?: boolean }) {
  const [open, setOpen] = useState(false);
  const fallback = useRef<HTMLButtonElement>(null);
  return (
    <>
      {!(removeOpener && open) && (
        <button type="button" onClick={() => setOpen(true)}>
          Rename…
        </button>
      )}
      <button type="button" ref={fallback}>
        Composer
      </button>
      {open && (
        <DialogShell
          testId="rename-dialog"
          title="Rename"
          onClose={() => setOpen(false)}
          returnFocus={() => fallback.current}
        >
          <input aria-label="Title" />
          <Dialog.Close render={<button type="button" />}>Cancel</Dialog.Close>
        </DialogShell>
      )}
    </>
  );
}

describe("DialogShell", () => {
  it("gives focus back to what opened it", async () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Rename…" });
    opener.focus();
    fireEvent.click(opener);
    await screen.findByTestId("rename-dialog");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByTestId("rename-dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("falls back when what opened it is gone", async () => {
    render(<Harness removeOpener />);
    screen.getByRole("button", { name: "Rename…" }).focus();
    fireEvent.click(screen.getByRole("button", { name: "Rename…" }));
    await screen.findByTestId("rename-dialog");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Composer" })),
    );
  });
});
