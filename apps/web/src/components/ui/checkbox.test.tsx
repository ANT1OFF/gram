// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Checkbox, RadioGroup } from "./checkbox";

afterEach(cleanup);

describe("Checkbox", () => {
  it("is a native checkbox named by its label, with its line under it", () => {
    const onChange = vi.fn();
    render(
      <Checkbox
        label="Also delete the worktree"
        description="The folder goes too."
        data-testid="delete"
        checked={false}
        onChange={(event) => onChange(event.target.checked)}
      />,
    );
    const box = screen.getByRole("checkbox", { name: /Also delete the worktree/ });
    expect(box).toBe(screen.getByTestId("delete"));
    expect(box.className).toContain("accent-primary");
    expect(box.closest("label")?.className).toContain("text-body");
    expect(box.closest("label")?.textContent).toBe("Also delete the worktreeThe folder goes too.");
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("takes another text step from the row's classes", () => {
    render(<Checkbox label="Trust this host" className="text-reading" />);
    const row = screen.getByRole("checkbox", { name: "Trust this host" }).closest("label")!;
    expect(row.className).toContain("text-reading");
    expect(row.className).not.toContain("text-body");
  });

  it("is the bare box without a label, with the classes given", () => {
    render(<Checkbox aria-label="Pick row" className="ms-2" />);
    const box = screen.getByRole("checkbox", { name: "Pick row" });
    expect(box.closest("label")).toBeNull();
    expect(box.className).toContain("ms-2");
  });

  it("dims its words while disabled, not the box a second time", () => {
    render(<Checkbox label="Locked" description="Your role can't change this." disabled />);
    const box = screen.getByRole("checkbox", { name: /Locked/ });
    expect((box as HTMLInputElement).disabled).toBe(true);
    const row = box.closest("label")!;
    expect(row.className).not.toContain("opacity");
    expect(box.className).not.toContain("opacity");
    expect(screen.getByText("Locked").parentElement!.className).toContain(
      "group-has-disabled/choice:opacity-50",
    );
  });

  it("gives the new state to onCheckedChange, beside onChange", () => {
    const onChange = vi.fn();
    const onCheckedChange = vi.fn();
    render(<Checkbox label="Pinned" onChange={onChange} onCheckedChange={onCheckedChange} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Pinned" }));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(onChange).toHaveBeenCalledOnce();
  });
});

describe("RadioGroup", () => {
  const options = [
    { value: "ask", label: "Ask first", description: "Every change waits for you." },
    { value: "auto", label: "Automatic" },
    { value: "off", label: "Off", disabled: true },
  ] as const;

  it("names the group, checks the value and reports a new pick", () => {
    const onChange = vi.fn();
    render(<RadioGroup label="Mode" options={options} value="ask" onChange={onChange} />);
    const group = screen.getByRole("radiogroup", { name: "Mode" });
    const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((radio) => radio.checked)).toEqual([true, false, false]);
    expect(radios[2]!.disabled).toBe(true);
    expect(new Set(radios.map((radio) => radio.name)).size).toBe(1);
    expect(radios[0]!.closest("label")?.textContent).toBe("Ask firstEvery change waits for you.");
    fireEvent.click(radios[1]!);
    expect(onChange).toHaveBeenCalledWith("auto");
  });

  it("is named by a visible heading and marks its first choice for focus when asked", () => {
    render(
      <>
        <div id="mode-heading">Worker mode</div>
        <RadioGroup
          labelledBy="mode-heading"
          options={options}
          value="ask"
          onChange={() => {}}
          autoFocusFirst
        />
      </>,
    );
    const group = screen.getByRole("radiogroup", { name: "Worker mode" });
    expect(group.hasAttribute("aria-label")).toBe(false);
    const radios = within(group).getAllByRole("radio");
    expect(radios[0]!.hasAttribute("data-autofocus")).toBe(true);
    expect(radios[1]!.hasAttribute("data-autofocus")).toBe(false);
  });

  it("takes a form's name and disables every choice at once", () => {
    render(
      <RadioGroup
        label="Mode"
        name="mode"
        options={options}
        value="ask"
        onChange={() => {}}
        disabled
      />,
    );
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios.every((radio) => radio.name === "mode" && radio.disabled)).toBe(true);
  });
});
