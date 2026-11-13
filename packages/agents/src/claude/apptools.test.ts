import { McpServerProposeInput, SettingsProposeInput } from "@gram/contracts";
import { describe, expect, it } from "vitest";
import { toZodObject } from "./apptools.ts";

describe("toZodObject", () => {
  it("serves settings_propose's change set, every op, to Claude", () => {
    const zod = toZodObject(SettingsProposeInput as never);
    const input = {
      reason: "asked",
      changes: [
        { op: "set", key: "appearance.mode", value: "light" },
        { op: "set", key: "workspace.pauseAtLimitPct", value: null },
        { op: "add", key: "workspace.workerModels", item: { agent: "claude", model: "haiku" } },
        { op: "update", key: "workspace.workerModels", match: "claude:haiku", item: {} },
        { op: "remove", key: "workspace.workerModels", match: "claude:haiku" },
      ],
    };
    expect(zod.parse(input)).toEqual(input);
    expect(() => zod.parse({ changes: [{ op: "drop", key: "x" }] })).toThrow();
  });

  it("serves mcp_server_propose's server, either transport, to Claude", () => {
    const zod = toZodObject(McpServerProposeInput as never);
    for (const server of [
      { type: "stdio", command: "npx", args: ["-y", "x"], env: { MODE: "a" } },
      { type: "http", url: "https://mcp.example.invalid/x", headers: { "X-Tenant": "docs" } },
    ]) {
      const input = { name: "x", server, targets: ["claude", "codex"], reason: "asked" };
      expect(zod.parse(input)).toEqual(input);
    }
    expect(() =>
      zod.parse({ name: "x", server: { type: "ws" }, targets: [], reason: "" }),
    ).toThrow();
  });
});
