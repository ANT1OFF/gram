// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Alert, AlertTitle } from "./alert";
import { Badge } from "./badge";

afterEach(cleanup);

describe("Badge tones", () => {
  it("outlines success and warning on the neutral fill, never a tinted one", () => {
    render(
      <>
        <Badge variant="success">Passing</Badge>
        <Badge variant="warning">Bypass</Badge>
      </>,
    );
    const success = screen.getByText("Passing");
    const warning = screen.getByText("Bypass");
    expect(success.className).toContain("border-success/50");
    expect(success.className).toContain("text-success");
    expect(warning.className).toContain("border-warning/50");
    expect(warning.className).toContain("text-warning");
    for (const badge of [success, warning])
      expect(badge.className).not.toMatch(/\bbg-(success|warning)/);
  });

  it("draws as a link with `render`", () => {
    render(
      <Badge variant="success" render={<a href="/checks" />}>
        Checks
      </Badge>,
    );
    const link = screen.getByRole("link", { name: "Checks" });
    expect(link.className).toContain("text-success");
  });
});

describe("Alert tones", () => {
  it("puts success and warning on the edge and the glyph, the words in the card's colours", () => {
    render(
      <>
        <Alert variant="warning">
          <svg data-testid="glyph" />
          <AlertTitle>Writes go live</AlertTitle>
        </Alert>
        <Alert variant="success">Saved</Alert>
      </>,
    );
    const [warning, success] = screen.getAllByRole("alert");
    expect(warning!.className).toContain("border-warning/50");
    expect(warning!.className).toContain("*:[svg]:text-warning");
    expect(warning!.className).toContain("text-card-foreground");
    expect(success!.className).toContain("border-success/50");
    expect(success!.className).toContain("*:[svg]:text-success");
  });
});
