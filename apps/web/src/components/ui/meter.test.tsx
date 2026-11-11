// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Meter, meterTone } from "./meter";

afterEach(cleanup);

describe("a meter", () => {
  it("is neutral, then amber from 90%, then red once all is used", () => {
    expect(meterTone(0.5)).toBe("neutral");
    expect(meterTone(0.9)).toBe("warning");
    expect(meterTone(1)).toBe("spent");
  });

  it("reads its share to a screen reader when it is named, and keeps within its track", () => {
    render(<Meter value={1.4} label="Budget used" fillTestId="fill" />);
    const meter = screen.getByRole("meter", { name: "Budget used" });
    expect(meter.getAttribute("aria-valuenow")).toBe("100");
    expect(meter.dataset["tone"]).toBe("spent");
    expect(screen.getByTestId("fill").style.width).toBe("100%");
  });

  it("is decoration without a name, and takes a tone it is given", () => {
    const { container } = render(<Meter value={0.2} tone="warning" />);
    const meter = container.querySelector('[data-slot="meter"]')!;
    expect(meter.getAttribute("aria-hidden")).toBe("true");
    expect(meter.getAttribute("data-tone")).toBe("warning");
  });
});
