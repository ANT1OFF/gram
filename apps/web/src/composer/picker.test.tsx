// @vitest-environment happy-dom
import type { PermissionMode } from "@gram/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LockOpen } from "lucide-react";
import { afterEach, expect, it, vi } from "vitest";

import { modeWarning } from "@/thread/mode-warning";

import { DEFAULT_EFFORT, DEFAULT_EFFORT_OPTION, EFFORT_OPTIONS, MODE_OPTIONS } from "./options";
import { Picker } from "./picker";
import { EffortGauge } from "./picker-glyphs";

afterEach(cleanup);

const mode = (value: PermissionMode, labelled: boolean) => (
  <Picker
    label="Mode"
    shortcutId="composer.mode"
    keys="mod+shift+a"
    focused={false}
    value={value}
    options={MODE_OPTIONS}
    icon={<LockOpen aria-hidden data-testid="mode-glyph" />}
    warning={modeWarning(value)}
    labelled={labelled}
    onChange={() => {}}
  />
);

it("as a glyph alone names the mode on hover and keeps its warning tint", async () => {
  const user = userEvent.setup();
  render(mode("bypassPermissions", false));
  const trigger = screen.getByRole("combobox", { name: "Mode: Bypass" });
  expect(trigger.getAttribute("data-warning")).toBe("true");
  expect(trigger.className).toContain("text-warning");
  expect(trigger.querySelector("[data-testid=mode-glyph]")).not.toBeNull();
  expect(trigger.querySelector("[data-toolbar-label]")?.className).toContain("sr-only");
  // The tooltip names the value and still says why it warns.
  expect(trigger.getAttribute("title")).toBeNull();
  await user.hover(trigger);
  const tip = await screen.findByText(/^Mode: Bypass/);
  expect(tip.textContent).toContain("tools run without asking for approval");
  // The open list spells out every mode, each with what it lets the agent do.
  await user.click(trigger);
  for (const option of MODE_OPTIONS) {
    expect(option.description).toBeTruthy();
    const row = screen.getByRole("option", { name: option.label });
    expect(row.getAttribute("aria-description")).toBe(option.description);
    expect(row.textContent).toContain(option.description);
  }
});

it("with its label shows the value beside the glyph, named and tooltipped with it", async () => {
  const user = userEvent.setup();
  render(mode("plan", true));
  const trigger = screen.getByRole("combobox", { name: "Mode: Plan" });
  const text = trigger.querySelector("[data-toolbar-label]");
  expect(text?.className).not.toContain("sr-only");
  expect(text?.textContent).toBe("Plan");
  expect(trigger.getAttribute("title")).toBeNull();
  await user.hover(trigger);
  expect((await screen.findByText(/^Mode: Plan/)).textContent).toMatch(/^Mode: Plan \(.+\)$/);
});

it("as a settings field keeps its plain name and the value in full", () => {
  render(
    <Picker
      field
      label="Helper effort"
      shortcutId="helper.effort"
      keys=""
      focused={false}
      value="xhigh"
      options={EFFORT_OPTIONS}
      onChange={() => {}}
    />,
  );
  const trigger = screen.getByRole("combobox", { name: "Helper effort" });
  expect(trigger.textContent).toContain("Extra high effort");
});

const efforts = (
  value: string,
  labelled: boolean,
  onChange: (value: string) => void = () => {},
) => (
  <Picker
    label="Effort"
    shortcutId="composer.effort"
    keys="mod+shift+e"
    focused={false}
    value={value}
    options={[DEFAULT_EFFORT_OPTION, ...EFFORT_OPTIONS]}
    icon={<EffortGauge variant={value === DEFAULT_EFFORT ? undefined : (value as "xhigh")} />}
    labelled={labelled}
    onChange={onChange}
  />
);

it("says the effort in short, and checks the current one in a list that says what each costs", async () => {
  const user = userEvent.setup();
  render(efforts("xhigh", true));
  const trigger = screen.getByRole("combobox", { name: "Effort: Extra high" });
  expect(trigger.querySelector("[data-toolbar-label]")?.textContent).toBe("Extra high");
  await user.click(trigger);
  for (const option of [DEFAULT_EFFORT_OPTION, ...EFFORT_OPTIONS]) {
    const row = screen.getByRole("option", { name: option.label });
    expect(option.description).toBeTruthy();
    expect(row.getAttribute("aria-description")).toBe(option.description);
    expect(row.getAttribute("aria-selected")).toBe(String(option.value === "xhigh"));
  }
  // The checked row is the only one with its check drawn.
  expect(screen.getByRole("option", { name: "Extra high effort" }).querySelector("svg")).not.toBe(
    null,
  );
  expect(screen.getByRole("option", { name: "Low effort" }).querySelector("svg")).toBeNull();
});

it("checks Default effort while the model's own level applies", async () => {
  const user = userEvent.setup();
  render(efforts(DEFAULT_EFFORT, false));
  const trigger = screen.getByRole("combobox", { name: "Effort: Model default" });
  await user.click(trigger);
  expect(screen.getByRole("option", { name: "Default effort" }).getAttribute("aria-selected")).toBe(
    "true",
  );
});

const effort = (value: string | undefined, onChange: (value: string) => void = () => {}) => (
  <Picker
    label="Effort"
    shortcutId="composer.effort"
    keys="mod+shift+e"
    focused={false}
    value={value}
    options={[
      { value: "low", label: "Low effort" },
      { value: "high", label: "High effort" },
    ]}
    icon={<EffortGauge variant={value as "low" | "high" | undefined} />}
    labelled={false}
    onChange={onChange}
  />
);

it("rings the glyph once a picked value lands, and not for a value that changed by itself", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const view = render(effort("low", onChange));
  const trigger = screen.getByRole("combobox", { name: "Effort: Low effort" });
  expect(trigger.querySelector("[data-testid=pulse-once]")).toBeNull();

  // Another thread's value in the same composer is no pick of yours: no ring.
  view.rerender(effort("high", onChange));
  expect(trigger.querySelector("[data-testid=pulse-once]")).toBeNull();
  view.rerender(effort("low", onChange));

  await user.click(trigger);
  await user.click(await screen.findByRole("option", { name: "High effort" }));
  expect(onChange).toHaveBeenCalledWith("high");
  // Nothing yet: the server hasn't taken it.
  expect(trigger.querySelector("[data-testid=pulse-once]")).toBeNull();
  view.rerender(effort("high", onChange));
  expect(trigger.querySelector("[data-testid=pulse-once]")).not.toBeNull();
  expect(trigger.querySelector("[data-testid=effort-gauge]")?.getAttribute("data-level")).toBe(
    "high",
  );
});

/** The gauge's needle path and how many arcs it draws for `variant`. */
const needle = (variant: "none" | "low" | "high" | "max" | undefined) => {
  const { container, unmount } = render(<EffortGauge variant={variant} />);
  const paths = [...container.querySelectorAll("path")];
  const d = paths.at(-1)!.getAttribute("d")!;
  unmount();
  return { d, arcs: paths.length - 1 };
};

it("draws the effort gauge's needle at its level", () => {
  // Unset: the plain gauge, needle straight up and no fill.
  expect(needle(undefined)).toEqual({ d: "M12 14L12 8", arcs: 1 });
  // None: the needle at the dial's start, nothing filled.
  expect(needle("none").arcs).toBe(1);
  // Each level turns the needle further round and fills the dial up to it.
  const x = (variant: "low" | "high" | "max") => Number(needle(variant).d.split(/[L ]/)[2]);
  expect(x("low")).toBeLessThan(12);
  expect(x("high")).toBeGreaterThan(12);
  expect(x("max")).toBeGreaterThan(x("high"));
  expect(needle("max").arcs).toBe(2);
});
