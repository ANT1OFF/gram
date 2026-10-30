import type { AgentKind } from "@gram/contracts";
import { describe, expect, it } from "vitest";
import { dreamSupportFor } from "./dream-support.ts";

describe("Dream support evidence", () => {
  it("keeps guided native permissions distinct from file-only support", () => {
    expect(dreamSupportFor("codex", { kind: "installed", cliVersion: "0.162.1" })).toMatchObject({
      mode: "guided",
      verifiedCliVersion: "0.162.1",
    });
    expect(dreamSupportFor("codex", { kind: "implementation" }).reason).toContain(
      "native tools can read or change other permitted files",
    );
    expect(dreamSupportFor("claude", { kind: "implementation" }).mode).toBe("confined");
    expect(
      dreamSupportFor("unknown-agent" as string as AgentKind, { kind: "implementation" }).mode,
    ).toBe("unsupported");
  });
  it("reports uncertainty for an unidentified or unqualified installed Codex", () => {
    for (const cliVersion of [undefined, "0.160.0", "0.163.0"])
      expect(dreamSupportFor("codex", { kind: "installed", cliVersion })).toMatchObject({
        mode: "unknown",
        reason: expect.stringContaining("Ordinary Codex chats remain available"),
      });
  });
});
