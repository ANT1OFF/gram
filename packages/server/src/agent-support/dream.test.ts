import { describe, expect, it } from "vitest";
import { installedDreamSupport } from "./dream.ts";
describe("independent strict Dream support contract", () => {
  it.each([undefined, "0.163.0"])(
    "retains Codex strict-file restriction for version %s",
    (version) => {
      const observed = installedDreamSupport(
        { agent: "codex", model: "synthetic-personal" },
        version,
      );
      expect(observed.dream.state).toBe("unknown");
      expect(observed.dreamGuided.state).toBe("unknown");
      expect(observed.dreamFiles.state).toBe("unsupported");
    },
  );
});
