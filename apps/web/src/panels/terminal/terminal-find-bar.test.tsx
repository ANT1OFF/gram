// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { findStatus, TerminalFindBar, type TerminalFind } from "./terminal-find-bar";

afterEach(cleanup);

const recorder = () => {
  const calls: unknown[][] = [];
  const find: TerminalFind = {
    next: (query, toggles, incremental) => {
      calls.push(["next", query, toggles, incremental]);
    },
    previous: (query, toggles) => {
      calls.push(["previous", query, toggles]);
    },
    clear: () => {
      calls.push(["clear"]);
    },
  };
  return { find, calls };
};

const inScope = () => true;

const plain = { caseSensitive: false, regex: false };

describe("TerminalFindBar", () => {
  it("searches as you type, steps with ⏎ / ⇧⏎ and re-runs when a toggle flips", () => {
    const { find, calls } = recorder();
    render(
      <TerminalFindBar
        find={find}
        results={{ index: 0, count: 2 }}
        request={{ nonce: 1, seed: "" }}
        inScope={inScope}
        onClose={vi.fn()}
      />,
    );
    const field = screen.getByRole<HTMLInputElement>("textbox", { name: "Find in terminal" });
    expect(document.activeElement).toBe(field);

    fireEvent.change(field, { target: { value: "err" } });
    expect(calls.at(-1)).toEqual(["next", "err", plain, true]);
    fireEvent.keyDown(field, { key: "Enter" });
    expect(calls.at(-1)).toEqual(["next", "err", plain, false]);
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    expect(calls.at(-1)).toEqual(["previous", "err", plain]);

    const matchCase = screen.getByRole("button", { name: "Match case" });
    fireEvent.click(matchCase);
    expect(matchCase.getAttribute("aria-pressed")).toBe("true");
    expect(calls.slice(-2)).toEqual([
      ["clear"],
      ["next", "err", { caseSensitive: true, regex: false }, false],
    ]);

    fireEvent.change(field, { target: { value: "" } });
    expect(calls.at(-1)).toEqual(["clear"]);
  });

  it("flags an invalid regular expression instead of searching", () => {
    const { find, calls } = recorder();
    render(
      <TerminalFindBar
        find={find}
        results={undefined}
        request={{ nonce: 1, seed: "" }}
        inScope={inScope}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Use regular expression" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Find in terminal" }), {
      target: { value: "retry(" },
    });
    expect(calls.at(-1)).toEqual(["clear"]);
    expect(screen.getByTestId("terminal-find-status").textContent).toBe("Invalid pattern");
    expect((screen.getByRole("button", { name: "Next match" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("seeds the query from the request and closes on Esc from anywhere in the bar", () => {
    const { find, calls } = recorder();
    const onClose = vi.fn();
    render(
      <TerminalFindBar
        find={find}
        results={undefined}
        request={{ nonce: 1, seed: "retry" }}
        inScope={inScope}
        onClose={onClose}
      />,
    );
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Find in terminal" }).value).toBe(
      "retry",
    );
    expect(calls).toEqual([["next", "retry", plain, true]]);

    fireEvent.keyDown(screen.getByRole("button", { name: "Match case" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("reports the match count the terminal gives", () => {
    expect(findStatus("", true, { index: 0, count: 3 })).toBe("");
    expect(findStatus("x", true, undefined)).toBe("");
    expect(findStatus("x", true, { index: -1, count: 0 })).toBe("No matches");
    expect(findStatus("x", true, { index: 1, count: 3 })).toBe("2 of 3");
    expect(findStatus("x", true, { index: -1, count: 1200 })).toBe("1200 matches");
    expect(findStatus("(", false, undefined)).toBe("Invalid pattern");
  });
});
