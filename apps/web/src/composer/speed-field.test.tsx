// @vitest-environment happy-dom
import { type AgentKind, type AgentModel } from "@gram/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { SpeedField } from "./speed-field";
import { choiceFromModel } from "./default-choice";
import { choiceModel } from "./agent-fields";

const models: readonly AgentModel[] = [
  { id: "fixture", displayName: "Synthetic", supportsEffort: false, speeds: ["standard", "fast"] },
];
afterEach(cleanup);
it.each(["claude", "codex"] as const)(
  "offers explicit %s speed with provider usage copy",
  async (agent: AgentKind) => {
    const onChange = vi.fn();
    render(
      <SpeedField
        agent={agent}
        model="fixture"
        models={models}
        value="standard"
        onChange={onChange}
      />,
    );
    const usage =
      agent === "claude" ? /separately billed usage credits/ : /more subscription allowance/;
    expect(screen.getByRole("combobox", { name: "Speed" }).textContent).toContain("Standard");
    // The usage copy lives in the dropdown, not under the selector.
    expect(screen.queryByText(usage)).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Speed" }));
    expect(screen.getByText(usage)).toBeTruthy();
    await user.click(screen.getByRole("option", { name: "Fast" }));
    expect(onChange).toHaveBeenCalledWith("fast");
  },
);
it("doesn't offer invented Fast support and explains a saved unsupported selection", async () => {
  render(
    <SpeedField
      agent="claude"
      model="invented-opus"
      models={models}
      value="fast"
      onChange={() => {}}
      state={{ speed: "standard", detail: "Claude Fast unavailable: extra_usage_disabled" }}
    />,
  );
  expect(screen.getByRole("combobox").textContent).toContain("Fast (requested)");
  expect(screen.getByText(/Fast is not advertised/)).toBeTruthy();
  expect(screen.getByText(/extra_usage_disabled/)).toBeTruthy();
  await userEvent.setup().click(screen.getByRole("combobox"));
  expect(
    screen.getByRole("option", { name: "Fast (requested)" }).getAttribute("aria-disabled"),
  ).toBe("true");
});
it("keeps an unset speed as the CLI's preference and makes new unset choices Standard", () => {
  expect(choiceFromModel(undefined).speed).toBe("standard");
  const unset = { agent: "claude", model: "opus", variant: "high" } as const;
  expect(choiceModel(choiceFromModel(unset))).toEqual(unset);
  const fast = { ...unset, speed: "fast" } as const;
  expect(choiceModel(choiceFromModel(fast))).toEqual(fast);
  render(
    <SpeedField
      agent="codex"
      model="fixture"
      models={models}
      value={undefined}
      onChange={() => {}}
    />,
  );
  expect(screen.getByRole("combobox").textContent).toContain("CLI default");
});
