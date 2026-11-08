// @vitest-environment happy-dom
import type { PermissionMode } from "@gram/contracts";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  effortSection,
  modelSection,
  modeSection,
  speedSection,
} from "./choice-sections";
import { ComposerChoices, type ChoiceSection } from "./choices";
import { chipWords } from "./choices-sheet";
import { EFFORT_OPTIONS } from "./options";

/** A window as wide as a phone, or not. */
function phoneWidth(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const MODELS = [
  { value: "opus", label: "Claude Opus", description: "Most capable" },
  { value: "sonnet", label: "Claude Sonnet" },
];

const sections = ({
  effort,
  mode = "auto",
  speed,
  on = {},
}: {
  effort?: string | undefined;
  mode?: PermissionMode;
  speed?: "standard" | "fast" | undefined;
  on?: Partial<
    Record<"model" | "effort" | "mode" | "speed", (value: string) => void>
  >;
} = {}): ChoiceSection[] => [
  modelSection({
    value: "opus",
    options: MODELS,
    onChange: on.model ?? (() => {}),
  }),
  effortSection({
    efforts: EFFORT_OPTIONS,
    value: effort,
    onChange: on.effort ?? (() => {}),
  }),
  modeSection({ value: mode, onChange: on.mode ?? (() => {}) }),
  speedSection({
    agent: "claude",
    models: [
      {
        id: "opus",
        displayName: "Claude Opus",
        supportsEffort: true,
        speeds: ["standard", "fast"],
      },
    ],
    model: "opus",
    value: speed,
    onChange: on.speed ?? (() => {}),
  }),
];

describe("chipWords", () => {
  it("says the model without its agent, the effort when set, the mode, and Fast when on", () => {
    expect(chipWords(sections({ effort: "high" }))).toBe("Opus · High · Auto");
    expect(chipWords(sections())).toBe("Opus · Auto");
    expect(
      chipWords(
        sections({ effort: "medium", mode: "acceptEdits", speed: "fast" }),
      ),
    ).toBe("Opus · Med · Edits · Fast");
  });
});

describe("the choices chip on a phone", () => {
  beforeEach(() => phoneWidth(true));

  it("says its values in short words", () => {
    render(<ComposerChoices sections={sections({ effort: "high" })} />);
    expect(screen.getByTestId("choices-words").textContent).toBe(
      "Opus · High · Auto",
    );
  });

  it("opens a bottom sheet with model rows, effort and mode segments and Fast's switch", async () => {
    const user = userEvent.setup();
    render(<ComposerChoices sections={sections({ effort: "high" })} />);
    await user.click(screen.getByTestId("composer-choices"));
    const sheet = await screen.findByRole("dialog", { name: "Model and mode" });
    expect(within(sheet).getByRole("button", { name: "Close" })).toBeTruthy();
    const opus = within(sheet).getByRole("option", { name: /Claude Opus/ });
    expect(opus.getAttribute("aria-selected")).toBe("true");
    expect(opus.textContent).toContain("Most capable");
    expect(
      within(sheet)
        .getByRole("radio", { name: "High" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      within(sheet)
        .getByRole("radio", { name: "Auto" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(within(sheet).getByRole("switch").getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("writes each pick as the popover does and stays open for the next", async () => {
    const user = userEvent.setup();
    const on = {
      model: vi.fn(),
      effort: vi.fn(),
      mode: vi.fn(),
      speed: vi.fn(),
    };
    render(<ComposerChoices sections={sections({ on })} />);
    await user.click(screen.getByTestId("composer-choices"));
    const sheet = await screen.findByRole("dialog", { name: "Model and mode" });
    await user.click(
      within(sheet).getByRole("option", { name: /Claude Sonnet/ }),
    );
    await user.click(within(sheet).getByRole("radio", { name: "Max" }));
    await user.click(within(sheet).getByRole("radio", { name: "Plan" }));
    await user.click(within(sheet).getByRole("switch"));
    expect(on.model).toHaveBeenCalledWith("sonnet");
    expect(on.effort).toHaveBeenCalledWith("max");
    expect(on.mode).toHaveBeenCalledWith("plan");
    expect(on.speed).toHaveBeenCalledWith("fast");
    expect(screen.getByRole("dialog", { name: "Model and mode" })).toBeTruthy();
  });

  it("closes on Close and on Escape", async () => {
    const user = userEvent.setup();
    render(<ComposerChoices sections={sections()} />);
    await user.click(screen.getByTestId("composer-choices"));
    await user.click(await screen.findByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByTestId("composer-choices"));
    const sheet = await screen.findByRole("dialog", { name: "Model and mode" });
    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("the choices chip on a desktop", () => {
  beforeEach(() => phoneWidth(false));

  it("keeps its glyphs alone and its popover", async () => {
    const user = userEvent.setup();
    render(<ComposerChoices sections={sections({ effort: "high" })} />);
    expect(screen.queryByTestId("choices-words")).toBeNull();
    await user.click(screen.getByTestId("composer-choices"));
    await screen.findByTestId("composer-choices-popup");
    expect(screen.queryByRole("dialog", { name: "Model and mode" })).toBeNull();
  });
});
