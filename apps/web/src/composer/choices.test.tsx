// @vitest-environment happy-dom
import type { PermissionMode, ThreadId } from "@gram/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runShortcut } from "@/keyboard/registry";

import { effortSection, modelSection, modeSection, speedSection } from "./choice-sections";
import { ComposerChoices, type ChoiceSection } from "./choices";
import { askModelPicker, onModelPickerAsked, useModelPickerRequests } from "./model-picker-request";
import { EFFORT_OPTIONS } from "./options";
import type { LabelSize } from "./toolbar-layout";

afterEach(() => {
  cleanup();
  useModelPickerRequests.setState({ asked: {} });
});

const MODELS = [
  { value: "opus", label: "Claude Opus" },
  { value: "sonnet", label: "Claude Sonnet" },
];

const sections = ({
  model = "opus",
  effort,
  efforts = EFFORT_OPTIONS,
  mode = "auto",
  speed,
  agent = "claude",
  on = {},
}: {
  model?: string;
  effort?: string | undefined;
  efforts?: typeof EFFORT_OPTIONS;
  mode?: PermissionMode;
  speed?: "standard" | "fast" | undefined;
  agent?: "claude" | "codex";
  on?: Partial<Record<"model" | "effort" | "mode" | "speed", (value: string) => void>>;
} = {}): ChoiceSection[] => [
  modelSection({
    value: model,
    options: MODELS,
    onChange: on.model ?? (() => {}),
    shortcut: { id: "composer.model", keys: "mod+shift+m" },
  }),
  effortSection({
    efforts,
    value: effort,
    onChange: on.effort ?? (() => {}),
    shortcut: { id: "composer.effort", keys: "mod+shift+e" },
  }),
  modeSection({
    value: mode,
    onChange: on.mode ?? (() => {}),
    shortcut: { id: "composer.mode", keys: "mod+shift+a" },
  }),
  speedSection({
    agent,
    models: [
      {
        id: "opus",
        displayName: "Claude Opus",
        supportsEffort: true,
        speeds: ["standard", "fast"],
      },
    ],
    model,
    value: speed,
    onChange: on.speed ?? (() => {}),
  }),
];

const chip = () => screen.getByTestId("composer-choices");
const shown = (selector: string) => chip().querySelector(selector);
const visible = (selector: string) => !shown(selector)?.className.includes("sr-only");

describe("the choices chip", () => {
  it("says the model, then effort, mode and a speed that isn't the default, in short words", () => {
    render(<ComposerChoices sections={sections({ effort: "high", speed: "fast" })} />);
    expect(shown("[data-toolbar-label]")?.textContent).toBe("Claude Opus · High · Auto · Fast");
    expect(shown("[data-toolbar-compact]")?.textContent).toBe("Opus · High · Auto · Fast");
    expect(shown("[data-toolbar-value]")?.textContent).toBe("Opus");
    expect(visible("[data-toolbar-label]")).toBe(true);
  });

  it("leaves defaults out of its words, its name still saying every value and shortcut", () => {
    render(<ComposerChoices sections={sections({ speed: "standard" })} />);
    expect(shown("[data-toolbar-label]")?.textContent).toBe("Claude Opus · Auto");
    expect(chip().getAttribute("aria-label")).toMatch(
      /^Claude Opus \(.+M\) · Effort: Model default \(.+E\) · Mode: Auto \(.+A\) · Speed: Standard$/,
    );
  });

  it("names its agent and every value in its tooltip, one line each", async () => {
    const user = userEvent.setup();
    render(
      <ComposerChoices
        sections={sections({ effort: "xhigh", mode: "bypassPermissions" })}
        mark={<svg data-testid="mark" />}
        agentLabel="Claude"
      />,
    );
    expect(chip().getAttribute("aria-description")).toMatch(/^Claude\. Bypass permissions/);
    await user.hover(chip());
    const tip = await screen.findByText(/^Claude · Claude Opus/);
    expect(tip.textContent?.split("\n")).toEqual([
      expect.stringMatching(/^Claude · Claude Opus \(.+\)$/),
      expect.stringMatching(/^Effort: Extra high \(.+\)$/),
      expect.stringMatching(/^Mode: Bypass \(.+\)$/),
      "Speed: CLI default",
      "Bypass permissions: tools run without asking for approval.",
    ]);
    // Bypass keeps its caution colour on the chip, on its own words.
    expect(chip().getAttribute("data-warning")).toBe("true");
    expect(within(shown("[data-toolbar-label]") as HTMLElement).getByText("Bypass").className).toBe(
      "text-warning",
    );
  });

  it.each<[LabelSize, string]>([
    ["full", "[data-toolbar-label]"],
    ["short", "[data-toolbar-compact]"],
    ["value", "[data-toolbar-value]"],
  ])("at %s shows only those words", (size, selector) => {
    render(<ComposerChoices sections={sections({ effort: "high" })} size={size} />);
    for (const each of ["[data-toolbar-label]", "[data-toolbar-compact]", "[data-toolbar-value]"])
      expect(visible(each), each).toBe(each === selector);
  });

  it("gives way to its mark only at the narrowest, and keeps the model without one", () => {
    const view = render(
      <ComposerChoices sections={sections()} size="icon" mark={<svg data-testid="mark" />} />,
    );
    expect(shown("[data-toolbar-label]")).toBeNull();
    expect(screen.getByTestId("mark")).toBeTruthy();
    view.rerender(<ComposerChoices sections={sections()} size="icon" />);
    expect(visible("[data-toolbar-value]")).toBe(true);
  });
});

describe("the choices popover", () => {
  it("opens on its Model section, and each section's list checks its value and says what each costs", async () => {
    const user = userEvent.setup();
    render(<ComposerChoices sections={sections({ effort: "xhigh" })} />);
    await user.click(chip());
    const popup = await screen.findByTestId("composer-choices-popup");
    // Four sections in the composer's order.
    expect(
      [...popup.querySelectorAll("[data-choice-section]")].map(
        (el) => (el as HTMLElement).dataset["choiceSection"],
      ),
    ).toEqual(["model", "effort", "mode", "speed"]);
    expect(screen.getByRole("combobox", { name: "Search models" })).toBeTruthy();
    expect(screen.getByTestId("choices-model").getAttribute("aria-expanded")).toBe("true");

    await user.click(screen.getByTestId("choices-effort"));
    const efforts = within(screen.getByRole("listbox", { name: "Effort" }));
    expect(efforts.getByRole("option", { name: "Default effort" })).toBeTruthy();
    for (const option of EFFORT_OPTIONS) {
      const row = efforts.getByRole("option", { name: option.label });
      expect(row.getAttribute("aria-selected")).toBe(String(option.value === "xhigh"));
      expect(row.getAttribute("aria-description")).toBe(option.description);
      expect(row.textContent).toContain(option.description);
    }
    // The checked row is the only one with its check drawn.
    expect(
      efforts.getByRole("option", { name: "Extra high effort" }).querySelector("svg"),
    ).not.toBe(null);
    expect(efforts.getByRole("option", { name: "Low effort" }).querySelector("svg")).toBeNull();
    // The model's search went with its section: one section open at a time.
    expect(screen.queryByRole("combobox", { name: "Search models" })).toBeNull();
  });

  it("picks a value, closes, and confirms it in words; a pick rings the mark once it lands", async () => {
    const user = userEvent.setup();
    const onMode = vi.fn();
    const onPicked = vi.fn();
    const props = { mark: <svg />, onPicked };
    const view = render(
      <ComposerChoices sections={sections({ on: { mode: onMode } })} {...props} />,
    );
    await user.click(chip());
    await user.click(await screen.findByTestId("choices-mode"));
    const modes = within(screen.getByRole("listbox", { name: "Mode" }));
    expect(modes.getByRole("option", { name: "Auto" }).getAttribute("aria-selected")).toBe("true");
    await user.click(modes.getByRole("option", { name: "Plan" }));
    expect(onMode).toHaveBeenCalledWith("plan");
    expect(onPicked).toHaveBeenCalledWith("Mode set to Plan");
    await waitFor(() => expect(screen.queryByTestId("composer-choices-popup")).toBeNull());
    // Nothing yet: the server hasn't taken it.
    expect(chip().querySelector("[data-testid=pulse-once]")).toBeNull();
    view.rerender(<ComposerChoices sections={sections({ mode: "plan" })} {...props} />);
    expect(chip().querySelector("[data-testid=pulse-once]")).not.toBeNull();
  });

  it("greys a dimension that doesn't apply, saying why, and offers no list for it", async () => {
    const user = userEvent.setup();
    render(<ComposerChoices sections={sections({ efforts: [] })} />);
    expect(chip().getAttribute("aria-label")).toContain("Effort: This model has no effort levels");
    await user.click(chip());
    const effort = await screen.findByTestId("unavailable-effort");
    expect(effort.getAttribute("aria-disabled")).toBe("true");
    expect(effort.textContent).toContain("Not available");
    await user.hover(effort);
    expect(await screen.findByText("Effort: This model has no effort levels")).toBeTruthy();
    // Opened, it says why in place of a list.
    await user.click(effort);
    expect(screen.queryByRole("listbox", { name: "Effort" })).toBeNull();
    expect(screen.getByTestId("composer-choices-popup").textContent).toContain(
      "This model has no effort levels",
    );
  });

  it("lists Fast disabled, saying why, where the model doesn't offer it", async () => {
    const user = userEvent.setup();
    const onSpeed = vi.fn();
    const own = sections({ on: { speed: onSpeed } });
    own[3] = speedSection({
      agent: "claude",
      models: [
        { id: "opus", displayName: "Claude Opus", supportsEffort: true, speeds: ["standard"] },
      ],
      model: "opus",
      value: "fast",
      onChange: onSpeed,
    });
    render(<ComposerChoices sections={own} />);
    await user.click(chip());
    await user.click(await screen.findByTestId("choices-speed"));
    const fast = screen.getByRole("option", { name: "Fast" });
    expect(fast.getAttribute("aria-disabled")).toBe("true");
    expect(fast.textContent).toContain("Not offered for this model.");
    fireEvent.click(fast);
    expect(onSpeed).not.toHaveBeenCalled();
    expect(screen.getByTestId("composer-choices-popup").textContent).toContain(
      "Fast is not advertised for this model",
    );
  });

  it("opens on a section by its shortcut, and moves between rows with the arrows", async () => {
    render(<ComposerChoices sections={sections({ effort: "high" })} focused />);
    act(() => void runShortcut("composer.effort"));
    const high = await screen.findByRole("option", { name: "High effort" });
    await waitFor(() => expect(document.activeElement).toBe(high));
    fireEvent.keyDown(high, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("option", { name: "Extra high effort" }));
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    await waitFor(() => expect(screen.queryByTestId("composer-choices-popup")).toBeNull());

    act(() => void runShortcut("composer.mode"));
    expect(await screen.findByRole("listbox", { name: "Mode" })).toBeTruthy();
  });

  it("registers its shortcuts only while its pane has focus", () => {
    render(<ComposerChoices sections={sections()} focused={false} />);
    expect(runShortcut("composer.effort")).toBe(false);
  });

  it("opens on Model for its own thread's ask made while mounted, not another's or an earlier one", async () => {
    const A = "t-a" as ThreadId;
    const B = "t-b" as ThreadId;
    askModelPicker(A);
    const onOpen = vi.fn();
    render(
      <ComposerChoices
        sections={sections()}
        onOpen={onOpen}
        onAsked={(open) => onModelPickerAsked(A, open)}
      />,
    );
    act(() => askModelPicker(B));
    expect(screen.queryByTestId("composer-choices-popup")).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
    act(() => askModelPicker(A));
    expect(await screen.findByRole("combobox", { name: "Search models" })).toBeTruthy();
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
