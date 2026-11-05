// @vitest-environment happy-dom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MiddleTruncate, middleSplit } from "./middle-truncate";

describe("middleSplit", () => {
  it("leaves a title short enough to fit whole", () => {
    expect(middleSplit("Faster cold start")).toBeUndefined();
  });

  it("keeps the last word or two of a long title whole", () => {
    expect(middleSplit("Idempotent refund webhook retries")).toEqual({
      head: "Idempotent refund webhook",
      tail: " retries",
    });
    expect(middleSplit("Currency rounding in reports")).toEqual({
      head: "Currency rounding in",
      tail: " reports",
    });
  });

  it("keeps the end of a long last word", () => {
    expect(middleSplit("Rename the configuration-loader-bootstrapper")).toEqual({
      head: "Rename the configuration-loader-boot",
      tail: "strapper",
    });
  });
});

describe("MiddleTruncate", () => {
  it("reads as the whole title", () => {
    const { container } = render(<MiddleTruncate text="Idempotent refund webhook retries" />);
    expect(container.textContent).toBe("Idempotent refund webhook retries");
  });
});
