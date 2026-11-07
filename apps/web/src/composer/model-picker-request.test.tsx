// @vitest-environment happy-dom
import type { ThreadId } from "@gram/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { askModelPicker, onModelPickerAsked, useModelPickerRequests } from "./model-picker-request";
import { Picker } from "./picker";

const options = [
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
] as const;

const A = "t-a" as ThreadId;
const B = "t-b" as ThreadId;
const onAsked = (open: () => void) => onModelPickerAsked(A, open);

describe("Picker onAsked", () => {
  afterEach(() => {
    cleanup();
    useModelPickerRequests.setState({ asked: {} });
  });

  it("opens on its own thread's ask made while mounted, not on another's or an earlier one", async () => {
    askModelPicker(A);
    const onOpen = vi.fn();
    render(
      <Picker
        label="Model"
        shortcutId="composer.model"
        keys="mod+shift+m"
        focused={false}
        value="opus"
        options={options}
        onChange={vi.fn()}
        onOpen={onOpen}
        onAsked={onAsked}
      />,
    );
    act(() => askModelPicker(B));
    expect(screen.queryByRole("option", { name: "Sonnet" })).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
    act(() => askModelPicker(A));
    expect(await screen.findByRole("option", { name: "Sonnet" })).toBeTruthy();
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
