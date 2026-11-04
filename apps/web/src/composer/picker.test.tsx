// @vitest-environment happy-dom
import type { PermissionMode } from "@gram/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LockOpen } from "lucide-react";
import { afterEach, expect, it, vi } from "vitest";

import { modeWarning } from "@/thread/mode-warning";

import { MODE_OPTIONS } from "./options";
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
  expect(trigger.className).toContain("text-status-needs");
  expect(trigger.querySelector("[data-testid=mode-glyph]")).not.toBeNull();
  expect(trigger.querySelector("[data-toolbar-label]")?.className).toContain("sr-only");
  // The tooltip names the value and still says why it warns.
  expect(trigger.getAttribute("title")).toBeNull();
  await user.hover(trigger);
  const tip = await screen.findByText(/^Mode: Bypass/);
  expect(tip.textContent).toContain("tools run without asking for approval");
  // The open list spells out every mode.
  await user.click(trigger);
  for (const option of MODE_OPTIONS)
    expect(screen.getByRole("option", { name: option.label })).toBeTruthy();
});

it("with its label shows the value and keeps the plain name", () => {
  render(mode("plan", true));
  const trigger = screen.getByRole("combobox", { name: "Mode" });
  expect(trigger.textContent).toContain("Plan");
  expect(trigger.getAttribute("title")).toMatch(/^Mode( \(.+\))?$/);
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
