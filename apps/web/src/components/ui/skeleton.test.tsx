// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Skeleton } from "./skeleton";

afterEach(cleanup);

describe("Skeleton", () => {
  it("is a hidden block at the size given, pulsing only under Full motion", () => {
    const { container } = render(<Skeleton className="h-7 w-40" data-testid="row" />);
    const block = container.querySelector('[data-slot="skeleton"]')!;
    expect(block.getAttribute("aria-hidden")).toBe("true");
    expect(block.getAttribute("data-testid")).toBe("row");
    expect(block.className).toContain("h-7 w-40");
    expect(block.className).toContain("bg-accent");
    expect(block.className).toContain("motion-safe:animate-pulse");
    expect(block.className).not.toMatch(/(^| )animate-pulse/);
  });
});
