// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Input, Textarea } from "./input";

afterEach(cleanup);

describe("Textarea", () => {
  it("has the one-line field's edge and focus ring, grows from its rows and resizes down", () => {
    render(<Textarea aria-label="Brief" rows={4} className="min-h-20" />);
    render(<Input aria-label="Name" />);
    const area = screen.getByRole("textbox", { name: "Brief" });
    const input = screen.getByRole("textbox", { name: "Name" });
    expect(area.tagName).toBe("TEXTAREA");
    expect(area.getAttribute("rows")).toBe("4");
    for (const shared of ["border-input", "rounded-lg", "focus-visible:ring-3", "text-reading"])
      expect(area.className).toContain(shared);
    expect(input.className).toContain("h-8");
    expect(area.className).not.toMatch(/(^| )h-8( |$)/);
    expect(area.className).toContain("resize-y");
    // A caller's minimum wins over the default one.
    expect(area.className).toContain("min-h-20");
    expect(area.className).not.toContain("min-h-16");
  });

  it("marks itself invalid only when asked", () => {
    render(<Textarea aria-label="Bad" invalid />);
    render(<Textarea aria-label="Good" invalid={false} />);
    expect(screen.getByRole("textbox", { name: "Bad" }).getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("textbox", { name: "Good" }).hasAttribute("aria-invalid")).toBe(false);
  });
});
