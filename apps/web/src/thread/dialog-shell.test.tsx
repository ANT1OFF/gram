// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Dialog, DialogShell, PhoneSheetHeader, Sheet, SheetHeader } from "./dialog-shell";

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

function Both() {
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <Sheet
        open
        title="Ada"
        description="Owner since 2024"
        testId="member-sheet"
        onClose={() => {}}
        actions={
          <button type="button" onClick={() => setConfirm(true)}>
            Remove
          </button>
        }
      >
        <p>Rows</p>
      </Sheet>
      {/* Beside the sheet, not inside it: Base UI doesn't see it as nested. */}
      <DialogShell
        testId="confirm"
        title="Remove Ada?"
        open={confirm}
        onClose={() => setConfirm(false)}
      >
        <p>Sure?</p>
      </DialogShell>
    </>
  );
}

describe("Sheet and Dialog together", () => {
  it("covers a sheet with a dialog opened beside it: its backdrop is on the popups' layer, after the sheet", async () => {
    render(<Both />);
    const sheet = await screen.findByTestId("member-sheet");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByTestId("confirm");
    const backdrops = [...document.querySelectorAll<HTMLElement>(".scrim")].filter(
      (each) => each !== sheet && !sheet.contains(each),
    );
    const last = backdrops.at(-1)!;
    expect(last.className).toContain("z-50");
    expect(sheet.className).toContain("z-50");
    // Same layer, later in the page: the dialog's backdrop is drawn over the sheet.
    expect(sheet.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(last.compareDocumentPosition(dialog) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("describes the sheet and scrolls its body by keyboard", async () => {
    render(<Both />);
    const sheet = await screen.findByTestId("member-sheet");
    expect(screen.getByRole("dialog", { name: "Ada", description: "Owner since 2024" })).toBe(
      sheet,
    );
    const body = screen.getByText("Rows").parentElement!;
    expect(body.tabIndex).toBe(0);
  });

  it("keeps a Dialog given `open` mounted while closed, so it can fade out", async () => {
    render(<Both />);
    await screen.findByTestId("member-sheet");
    expect(screen.queryByTestId("confirm")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await screen.findByTestId("confirm");
    fireEvent.keyDown(screen.getByTestId("confirm"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("confirm")).toBeNull());
  });
});

describe("SheetHeader", () => {
  it("titles the sheet, with what sits beside the title before its actions and Close", async () => {
    render(
      <Dialog.Root open>
        <Dialog.Portal>
          <Dialog.Popup data-testid="popup">
            <SheetHeader
              title="Feature"
              titleId="feature-title"
              beside={<span>2 need you</span>}
              actions={<button type="button">More</button>}
            />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>,
    );
    const popup = await screen.findByTestId("popup");
    expect(screen.getByRole("dialog", { name: "Feature" })).toBe(popup);
    expect(document.getElementById("feature-title")?.textContent).toBe("Feature");
    const beside = screen.getByText("2 need you");
    const more = screen.getByRole("button", { name: "More" });
    const close = screen.getByRole("button", { name: "Close" });
    expect(beside.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(more.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

function Nested({ onSheetClose }: { onSheetClose: () => void }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <Sheet open title="Ada" testId="member-sheet" onClose={onSheetClose}>
      <button type="button" onClick={() => setConfirm(true)}>
        Remove
      </button>
      {/* Inside the sheet: Base UI nests it, and draws no backdrop of its own for it. */}
      <DialogShell
        testId="nested-confirm"
        title="Remove Ada?"
        open={confirm}
        onClose={() => setConfirm(false)}
      >
        <p>Sure?</p>
      </DialogShell>
    </Sheet>
  );
}

describe("a dialog nested in a sheet", () => {
  it("closes alone on a click beside it, on the dimmed sheet, which stays open", async () => {
    const onSheetClose = vi.fn();
    render(<Nested onSheetClose={onSheetClose} />);
    const sheet = await screen.findByTestId("member-sheet");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await screen.findByTestId("nested-confirm");
    // Its own clear backdrop, over the sheet, takes the click instead of the sheet's controls.
    const backdrop = document.querySelector<HTMLElement>('[data-slot="nested-backdrop"]')!;
    expect(backdrop).not.toBeNull();
    expect(backdrop.className).not.toContain("scrim");
    expect(sheet.compareDocumentPosition(backdrop) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.pointerDown(backdrop);
    fireEvent.mouseDown(backdrop);
    fireEvent.pointerUp(backdrop);
    fireEvent.mouseUp(backdrop);
    fireEvent.click(backdrop);
    await waitFor(() => expect(screen.queryByTestId("nested-confirm")).toBeNull());
    expect(onSheetClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("member-sheet")).toBe(sheet);
  });

  it("dims the window itself on its own, outside any overlay", async () => {
    render(
      <DialogShell testId="alone" title="Alone" onClose={() => {}}>
        <p>Body</p>
      </DialogShell>,
    );
    await screen.findByTestId("alone");
    expect(document.querySelector('[data-slot="nested-backdrop"]')).toBeNull();
    expect(document.querySelector(".scrim")).not.toBeNull();
  });
});
