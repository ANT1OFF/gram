// @vitest-environment happy-dom
import type { AgentModel } from "@gram/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { ModelCombobox, ModelSearch } from "./model-picker";
import { modelOptions } from "./models";
import { DEFAULT_MODEL_OPTIONS } from "./options";
import type { LabelSize } from "./picker-trigger";

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

const listed = () => screen.queryAllByRole("option").map((row) => row.getAttribute("aria-label"));

describe("legacy models", () => {
  // Synthetic rows: Fable 5.1 and Opus 5 are superseded; the thread may sit on either.
  const rows: AgentModel[] = [
    { id: "default", displayName: "Default (recommended)", supportsEffort: false },
    { id: "opus", displayName: "Opus 5.5", supportsEffort: false },
    { id: "fable", displayName: "Fable 5.2", supportsEffort: false },
    { id: "claude-fable-5-1", displayName: "Fable 5.1", supportsEffort: false },
    { id: "claude-opus-5", displayName: "Opus 5", supportsEffort: false },
  ];

  function Harness({ value, starred = [] }: { value: string; starred?: readonly string[] }) {
    return (
      <ModelSearch
        value={value}
        options={modelOptions(rows, value)}
        onChange={() => {}}
        favourite={(id) => starred.includes(id)}
        onToggleFavourite={() => {}}
      />
    );
  }

  it("lists the latest of each family, Default first, and folds the rest", async () => {
    render(<Harness value="opus" />);
    expect(listed()).toEqual(["Default (recommended)", "Opus 5.5", "Fable 5.2"]);
    const fold = screen.getByTestId("legacy-models");
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(fold.textContent).toContain("2");
    await userEvent.setup().click(fold);
    expect(listed()).toEqual([
      "Default (recommended)",
      "Opus 5.5",
      "Fable 5.2",
      "Fable 5.1",
      "Opus 5",
    ]);
    // Opened, the fold heads its section in the list rather than sit below it too.
    expect(screen.getAllByTestId("legacy-models")).toHaveLength(1);
    expect(screen.getByTestId("legacy-models").getAttribute("aria-expanded")).toBe("true");
  });

  it("finds a legacy model by search, with the fold shut", async () => {
    render(<Harness value="opus" />);
    await userEvent.setup().type(screen.getByLabelText("Search models"), "fable");
    expect(listed()).toEqual(["Fable 5.2", "Fable 5.1"]);
    expect(screen.queryByTestId("legacy-models")).toBeNull();
  });

  it("keeps a legacy model in view while a thread is on it, or it is starred", () => {
    render(<Harness value="claude-fable-5-1" starred={["claude-opus-5"]} />);
    expect(listed()).toEqual([
      "Opus 5",
      "Default (recommended)",
      "Opus 5.5",
      "Fable 5.2",
      "Fable 5.1",
    ]);
    expect(screen.getByRole("option", { name: "Fable 5.1" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    // Nothing is left to fold.
    expect(screen.queryByTestId("legacy-models")).toBeNull();
  });
});
