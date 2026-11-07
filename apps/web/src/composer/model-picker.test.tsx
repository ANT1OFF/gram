// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { ModelCombobox } from "./model-picker";
import { DEFAULT_MODEL_OPTIONS } from "./options";
import type { LabelSize } from "./toolbar-layout";

afterEach(cleanup);

const picker = (labelled: LabelSize) => (
  <ModelCombobox
    label="Model"
    value="opus"
    options={DEFAULT_MODEL_OPTIONS}
    onChange={() => {}}
    open
    onOpenChange={() => {}}
    icon={<span data-testid="mark" />}
    title="Model: Claude Opus"
    description={undefined}
    labelled={labelled}
  />
);

// Its full and short forms were different element trees, so a row re-laying itself out while the
// list opened remounted the trigger and closed the list (seen as a click that never opened it).
it("keeps one trigger, and its open list, as the toolbar changes its size", async () => {
  const { rerender } = render(picker("full"));
  const trigger = screen.getByRole("combobox", { name: "Model" });
  expect(await screen.findByTestId("model-picker")).toBeTruthy();
  rerender(picker("short"));
  const short = screen.getByRole("combobox", { name: "Model: Claude Opus" });
  expect(short).toBe(trigger);
  expect(screen.getByTestId("model-picker")).toBeTruthy();
  rerender(picker("full"));
  expect(screen.getByRole("combobox", { name: "Model" })).toBe(trigger);
  // On a toolbar the instant tooltip names it, never a native title on top of it.
  expect(trigger.getAttribute("title")).toBeNull();
});
