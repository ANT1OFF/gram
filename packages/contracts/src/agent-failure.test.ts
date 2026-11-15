import { describe, expect, it } from "vitest";

import { limitDetail } from "./agent-failure.ts";

describe("limitDetail", () => {
  it("keeps the provider's words without the API's status prefix", () => {
    expect(
      limitDetail(
        "API Error: Request rejected (429) · You have reached the usage limit of your Claude login. This request would exceed your account's rate limit. Please try again later.",
      ),
    ).toBe(
      "You have reached the usage limit of your Claude login. This request would exceed your account's rate limit. Please try again later.",
    );
    expect(limitDetail("API Error: 429 No deployments available for selected model.")).toBe(
      "No deployments available for selected model.",
    );
    expect(limitDetail("Too many requests")).toBe("Too many requests");
  });

  it("says nothing for a bare code or a raw body, and cuts a long one", () => {
    expect(limitDetail("API Error: 429")).toBeUndefined();
    expect(limitDetail('API Error: 429 {"type":"error"}')).toBeUndefined();
    const long = limitDetail(`API Error: 429 ${"word ".repeat(100)}`);
    expect(long?.length).toBeLessThanOrEqual(240);
    expect(long?.endsWith("…")).toBe(true);
  });
});
