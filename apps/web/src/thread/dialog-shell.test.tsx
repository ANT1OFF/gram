// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Dialog, DialogShell, PhoneSheetHeader, Sheet } from "./dialog-shell";

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
function PhoneSheet() {
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
    render(<PhoneSheet />);
    const sheet = await screen.findByTestId("sheet");
    expect(screen.getByRole("dialog", { name: "History" })).toBe(sheet);
    const close = screen.getByTestId("sheet-close");
    expect(close.getAttribute("aria-label")).toBe("Close");
    expect(close.className).toContain("size-11");
    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByTestId("sheet")).toBeNull());
  });
});

function SheetHarness({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open member
      </button>
      <Sheet
        open={open}
        onClose={() => {
          onClose?.();
          setOpen(false);
        }}
        title="Ada"
        testId="member-sheet"
        actions={<button type="button">Edit</button>}
      >
        <p>Owner since 2024</p>
      </Sheet>
    </>
  );
}

describe("Sheet", () => {
  it("is closed until opened, then titled, with its actions, a Close and its body", async () => {
    render(<SheetHarness />);
    expect(screen.queryByTestId("member-sheet")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open member" }));
    const sheet = await screen.findByTestId("member-sheet");
    expect(screen.getByRole("dialog", { name: "Ada" })).toBe(sheet);
    expect(sheet.className).toContain("end-2");
    expect(sheet.className).toContain("w-[min(28rem,calc(100vw-1rem))]");
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.getByText("Owner since 2024")).toBeTruthy();
  });

  it("closes from its Close and gives focus back to what opened it", async () => {
    const onClose = vi.fn();
    render(<SheetHarness onClose={onClose} />);
    const opener = screen.getByRole("button", { name: "Open member" });
    opener.focus();
    fireEvent.click(opener);
    await screen.findByTestId("member-sheet");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByTestId("member-sheet")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("is wider for a page of settings", async () => {
    render(
      <Sheet open wide title="Settings" testId="wide-sheet" onClose={() => {}}>
        Rows
      </Sheet>,
    );
    expect((await screen.findByTestId("wide-sheet")).className).toContain(
      "w-[min(36rem,calc(100vw-1rem))]",
    );
  });
});
