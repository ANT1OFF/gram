import { describe, expect, it } from "vitest";

import { tileLabel } from "./overview-rail";

describe("tileLabel", () => {
  it("keeps a name that fits the tile whole", () => {
    expect(tileLabel("Gram")).toBe("Gram");
    expect(tileLabel("infra")).toBe("infra");
  });

  it("shortens a long name to a form that still reads as it, never a cut-off word", () => {
    expect(tileLabel("billing-api")).toBe("BA");
    expect(tileLabel("web-ui")).toBe("web");
    expect(tileLabel("agent platform tools")).toBe("APT");
    expect(tileLabel("frontend")).toBe("Fr");
  });
});
