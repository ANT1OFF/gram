// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { Dialog, DialogShell, PhoneSheetHeader } from "./dialog-shell";

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

/** A sheet titled by its phone header. */
function Sheet() {
  const [open, setOpen] = useState(true);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Popup data-testid="sheet">
          <PhoneSheetHeader title="History" />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

describe("PhoneSheetHeader", () => {
  it("titles the sheet and closes it from its 44 px Close", async () => {
    render(<Sheet />);
    const sheet = await screen.findByTestId("sheet");
    expect(screen.getByRole("dialog", { name: "History" })).toBe(sheet);
    const close = screen.getByTestId("sheet-close");
    expect(close.getAttribute("aria-label")).toBe("Close");
    expect(close.className).toContain("size-11");
    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByTestId("sheet")).toBeNull());
  });
});
