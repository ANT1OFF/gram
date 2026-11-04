// @vitest-environment happy-dom
import type { PermissionMode } from "@gram/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LockOpen } from "lucide-react";
import { afterEach, expect, it } from "vitest";

import { modeWarning } from "@/thread/mode-warning";

import { MODE_OPTIONS } from "./options";
import { Picker } from "./picker";

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
