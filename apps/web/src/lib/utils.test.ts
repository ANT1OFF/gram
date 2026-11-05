import { describe, expect, it } from "vitest";

import { cn } from "./utils";

describe("cn", () => {
  it("keeps a type step beside a text colour", () => {
    expect(cn("text-meta", "text-muted-foreground")).toBe("text-meta text-muted-foreground");
    expect(cn("text-body-strong text-fg", "text-(--section-count)")).toBe(
      "text-body-strong text-(--section-count)",
    );
  });

  it("lets a later token replace an earlier one in its group", () => {
    expect(cn("text-xs", "text-meta")).toBe("text-meta");
    expect(cn("text-body", "text-reading")).toBe("text-reading");
    expect(cn("rounded-md", "rounded-2xs")).toBe("rounded-2xs");
    expect(cn("shadow-raised", "shadow-overlay")).toBe("shadow-overlay");
    expect(cn("p-2", "p-section")).toBe("p-section");
    expect(cn("gap-inset", "gap-1")).toBe("gap-1");
  });
});
