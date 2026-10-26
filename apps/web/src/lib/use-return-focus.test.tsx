// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { returnFocusTo, useReturnFocus } from "./use-return-focus";

afterEach(cleanup);

function Surface({ fallback }: { fallback?: () => Element | null }) {
  useReturnFocus(fallback);
  // oxlint-disable-next-line jsx-a11y/no-autofocus
  return <input aria-label="Surface" autoFocus />;
}

function Harness({ removeOpener = false }: { removeOpener?: boolean }) {
  const [open, setOpen] = useState(false);
  const [openerShown, setOpenerShown] = useState(true);
  const fallback = useRef<HTMLButtonElement>(null);
  return (
    <>
      {openerShown && (
        <button type="button" onClick={() => setOpen(true)}>
          Open
        </button>
      )}
      <button type="button" ref={fallback}>
        Fallback
      </button>
      {open && <Surface fallback={() => fallback.current} />}
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (removeOpener) setOpenerShown(false);
          setOpen(false);
          (document.activeElement as HTMLElement | null)?.blur();
        }}
      >
        Close
      </button>
    </>
  );
}

describe("useReturnFocus", () => {
  it("gives focus back to the opener once the surface closes", async () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByLabelText("Surface"));

    act(() => screen.getByRole("button", { name: "Close" }).click());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("falls back when the opener is gone too", async () => {
    render(<Harness removeOpener />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);

    act(() => screen.getByRole("button", { name: "Close" }).click());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Fallback" })),
    );
  });
});

describe("returnFocusTo", () => {
  it("returns the opener while it's on the page, else the fallback, else the default", () => {
    const button = document.createElement("button");
    document.body.append(button);
    const opener = { current: button };
    const other = document.createElement("button");
    expect(returnFocusTo(opener)()).toBe(button);
    button.remove();
    expect(returnFocusTo(opener, () => other)()).toBe(other);
    expect(returnFocusTo(opener)()).toBe(true);
  });
});
