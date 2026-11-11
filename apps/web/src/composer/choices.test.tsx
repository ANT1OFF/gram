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
const glyphs = () =>
  [...chip().querySelectorAll<HTMLElement>("[data-chip-glyph]")].map(
    (el) => el.dataset["chipGlyph"],
  );
const modeGlyph = () => chip().querySelector('[data-chip-glyph="mode"] svg');

describe("the choices chip", () => {
  it("says the model's name beside the agent's mark, and the mode in its glyph", () => {
    render(
      <ComposerChoices
        sections={sections({ effort: "high", mode: "plan", speed: "standard" })}
        mark={<svg data-testid="mark" />}
      />,
    );
    // The mark says the vendor, so the name drops it; effort and a standard speed draw nothing.
    expect(chip().textContent).toBe("Opus");
    expect(within(chip()).getByTestId("mark")).toBeTruthy();
    expect(glyphs()).toEqual(["mode"]);
    expect(chip().querySelector('[data-chip-glyph="mode"]')?.getAttribute("data-value")).toBe(
      "plan",
    );
    expect(modeGlyph()?.getAttribute("class")).toContain("lucide-list-checks");
    expect(modeGlyph()?.getAttribute("class")).not.toContain("text-warning");
    // Its name says every value and its shortcut, the defaults' too.
    expect(chip().getAttribute("aria-label")).toMatch(
      /^Claude Opus \(.+M\) · Effort: High \(.+E\) · Mode: Plan \(.+A\) · Speed: Standard$/,
    );
  });

  it("adds Bypass's lock in the warning colour and Fast's bolt beside the mark", () => {
    render(
      <ComposerChoices
        sections={sections({ mode: "bypassPermissions", speed: "fast" })}
        mark={<svg data-testid="mark" />}
      />,
    );
    expect(chip().textContent).toBe("Opus");
    expect(glyphs()).toEqual(["mode", "speed"]);
    expect(modeGlyph()?.getAttribute("class")).toContain("lucide-lock-open");
    expect(modeGlyph()?.getAttribute("class")).toContain("text-warning");
    expect(chip().querySelector('[data-testid="speed-glyph"]')?.getAttribute("data-speed")).toBe(
      "fast",
    );
    expect(chip().getAttribute("aria-label")).toMatch(/ · Mode: Bypass \(.+A\) · Speed: Fast$/);
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
    expect(chip().getAttribute("data-warning")).toBe("true");
  });

  it("draws a distinct glyph for each mode", () => {
    const modes: PermissionMode[] = [
      "default",
      "acceptEdits",
      "plan",
      "auto",
      "bypassPermissions",
      "dontAsk",
    ];
    const seen = modes.map((mode) => {
      const view = render(<ComposerChoices sections={sections({ mode })} mark={<svg />} />);
      const glyph = modeGlyph()?.getAttribute("class") ?? "";
      view.unmount();
      return /lucide-[a-z-]+/.exec(glyph.replace("lucide-icon", ""))?.[0];
    });
    expect(new Set(seen).size).toBe(modes.length);
    // Auto's shield, never the Sparkles that marks a setting following the recommended setup.
    expect(seen).not.toContain("lucide-sparkles");
  });

  it("keeps the model's name, truncated, in a toolbar short of room", () => {
    render(
      <div style={{ width: "60px", display: "flex" }}>
        <ComposerChoices sections={sections()} mark={<svg />} />
      </div>,
    );
    const name = screen.getByTestId("choices-model-name");
    expect(name.textContent).toBe("Opus");
    expect(name.getAttribute("class")).toContain("truncate");
    expect(chip().getAttribute("class")).toContain("min-w-0");
  });

  it("is never an empty pill: without a mark, the sliders glyph stands in", () => {
    render(<ComposerChoices sections={sections()} />);
    expect(chip().textContent).toBe("Opus");
    expect(within(chip()).getByTestId("choices-glyph")).toBeTruthy();
  });

  // #263's chip folded its words by the measured width of the row, and a glyph a few px off what
  // the measure expected flipped it between two layouts until React stopped it ("Maximum update
  // depth exceeded"). The name truncates by CSS alone: nothing measures, so nothing loops.
  it("renders the same in a toolbar too narrow for it, settling at once", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const view = render(
        <div style={{ width: "30px" }}>
          <ComposerChoices sections={sections({ speed: "fast" })} mark={<svg />} />
        </div>,
      );
      const first = chip().innerHTML;
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
      view.rerender(
        <div style={{ width: "300px" }}>
          <ComposerChoices sections={sections({ speed: "fast" })} mark={<svg />} />
        </div>,
      );
      expect(chip().innerHTML).toBe(first);
      expect(errors).not.toHaveBeenCalledWith(expect.stringMatching(/Maximum update depth/));
    } finally {
      errors.mockRestore();
    }
  });
});

describe("the choices popover", () => {
  it("draws each mode's glyph beside its row, Bypass's in the warning colour", async () => {
    const user = userEvent.setup();
    render(<ComposerChoices sections={sections({ mode: "auto" })} />);
    await user.click(chip());
    await user.click(await screen.findByTestId("choices-mode"));
    const modes = within(screen.getByRole("listbox", { name: "Mode" }));
    const glyphOf = (name: string) =>
      modes.getByRole("option", { name }).querySelector("svg")?.getAttribute("class") ?? "";
    expect(glyphOf("Ask")).toContain("lucide-lock");
    expect(glyphOf("Accept edits")).toContain("lucide-file-pen");
    expect(glyphOf("Plan")).toContain("lucide-list-checks");
    expect(glyphOf("Auto")).toContain("lucide-shield-check");
    expect(glyphOf("Bypass")).toContain("lucide-lock-open");
    expect(glyphOf("Bypass")).toContain("text-warning");
    expect(glyphOf("Auto")).not.toContain("text-warning");
  });

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
    expect(effort.getAttribute("aria-description")).toBe("Effort: This model has no effort levels");
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

  it("goes down from the open Model heading into its search", async () => {
    const user = userEvent.setup();
    render(<ComposerChoices sections={sections()} />);
    await user.click(chip());
    const heading = await screen.findByTestId("choices-model");
    heading.focus();
    fireEvent.keyDown(heading, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Search models" }));
  });

  it("tells its owner it closed, and a pick the server never took rings nothing on reopening", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const props = { mark: <svg />, onClose };
    const view = render(<ComposerChoices sections={sections()} {...props} />);
    await user.click(chip());
    await user.click(await screen.findByTestId("choices-mode"));
    await user.click(screen.getByRole("option", { name: "Plan" }));
    expect(onClose).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByTestId("composer-choices-popup")).toBeNull());
    // Reopened and closed with the pick never taken; the mode then reaches Plan by itself.
    await user.click(chip());
    await screen.findByTestId("composer-choices-popup");
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
    view.rerender(<ComposerChoices sections={sections({ mode: "plan" })} {...props} />);
    expect(chip().querySelector("[data-testid=pulse-once]")).toBeNull();
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
