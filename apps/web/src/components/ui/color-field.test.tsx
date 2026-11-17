// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ColorField, parseHex } from "./color-field";

afterEach(cleanup);

describe("parseHex", () => {
  it("takes #rgb and #rrggbb, with or without #, as lowercase #rrggbb", () => {
    expect(parseHex("#ABC")).toBe("#aabbcc");
    expect(parseHex(" 12ab3F ")).toBe("#12ab3f");
    for (const bad of ["", "#abcd", "#ggg", "red", "#12345", "##abc"])
      expect(parseHex(bad)).toBeUndefined();
  });
});

function Field({ onChange }: { onChange: (value: string) => void }) {
  const [value, setValue] = useState("#336699");
  return (
    <ColorField
      label="Accent"
      value={value}
      swatches={["#fff", "#336699", "#FFFFFF"]}
      onChange={(next) => {
        onChange(next);
        setValue(next);
      }}
    />
  );
}

describe("ColorField", () => {
  it("commits a valid code on Enter or blur, normalised, and nothing else", () => {
    const changed = vi.fn();
    render(<Field onChange={changed} />);
    const field = screen.getByRole<HTMLInputElement>("textbox", { name: "Accent" });
    fireEvent.change(field, { target: { value: "#F0A" } });
    expect(changed).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(changed).toHaveBeenLastCalledWith("#ff00aa");
    expect(field.value).toBe("#ff00aa");
    expect(screen.getByLabelText("Accent: pick a colour, now #ff00aa")).toBeTruthy();

    fireEvent.change(field, { target: { value: "nope" } });
    expect(field.getAttribute("aria-invalid")).toBe("true");
    fireEvent.blur(field);
    expect(changed).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(field, { key: "Escape" });
    expect(field.value).toBe("#ff00aa");
    expect(field.hasAttribute("aria-invalid")).toBe(false);

    fireEvent.change(field, { target: { value: "123456" } });
    fireEvent.blur(field);
    expect(changed).toHaveBeenLastCalledWith("#123456");
  });

  it("takes the picker's colour and offers each preset once, the current one pressed", () => {
    const changed = vi.fn();
    render(<Field onChange={changed} />);
    fireEvent.input(screen.getByLabelText(/pick a colour/), { target: { value: "#00ff00" } });
    expect(changed).toHaveBeenLastCalledWith("#00ff00");
    const presets = screen.getByRole("group", { name: "Accent: presets" });
    expect(presets.querySelectorAll("button")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "#336699" }));
    expect(changed).toHaveBeenLastCalledWith("#336699");
    expect(screen.getByRole("button", { name: "#336699" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "#ffffff" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("marks itself invalid when the host says so", () => {
    render(<ColorField label="Accent" value="#000000" onChange={() => {}} invalid />);
    expect(screen.getByRole("textbox", { name: "Accent" }).getAttribute("aria-invalid")).toBe(
      "true",
    );
  });
});
