import type { AgentKind } from "@gram/contracts";
import { describe, expect, it } from "vitest";
import { dreamSupportFor } from "./dream-support.ts";

describe("Dream support evidence", () => {
  it("keeps guided native permissions distinct from file-only support", () => {
    expect(dreamSupportFor("codex", { kind: "installed", cliVersion: "0.166.0" })).toMatchObject({
      mode: "guided",
      verifiedCliVersion: "0.166.0",
    });
    expect(dreamSupportFor("codex", { kind: "implementation" }).reason).toContain(
      "native tools can read or change other permitted files",
    );
    expect(dreamSupportFor("claude", { kind: "implementation" }).mode).toBe("confined");
    expect(
      dreamSupportFor("unknown-agent" as string as AgentKind, { kind: "implementation" }).mode,
    ).toBe("unsupported");
  });
  it.each(["0.166.1", "0.167.0", "0.1000.0", "1.0.0"])(
    "allows newer Codex %s with a warning",
    (cliVersion) => {
      expect(dreamSupportFor("codex", { kind: "installed", cliVersion })).toMatchObject({
        mode: "guided",
        reason: expect.stringContaining(`Codex ${cliVersion} differs from 0.166.0`),
      });
    },
  );
  it("reports uncertainty for an unidentified or unqualified installed Codex", () => {
    for (const cliVersion of [undefined, "unknown", "0.160.0", "0.163.0", "0.166.0-alpha.2"])
      expect(dreamSupportFor("codex", { kind: "installed", cliVersion })).toMatchObject({
        mode: "unknown",
        reason: expect.stringContaining("Ordinary Codex chats remain available"),
      });
  });
});
