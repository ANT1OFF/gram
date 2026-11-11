import { describe, expect, it } from "vitest";
import type { ThreadProfileBinding } from "@gram/contracts";
import type { SessionPolicy } from "../runtime/session-policy.ts";
import { withProfile } from "./policy.ts";

const SERVER = { name: "workspace", url: "https://mcp.example.test/workspace" };
const bound = (profile: Partial<ThreadProfileBinding> = {}) => ({
  profile: { charter: "Do the task.", ...profile },
});
const plain: SessionPolicy = { audience: "plain", outwardGate: undefined };

describe("withProfile", () => {
  it("is the policy itself for a thread with no profile", () => {
    const policy: SessionPolicy = { ...plain, mcpDenylist: ["x"], instructions: "As before." };
    expect(withProfile(policy, {})).toBe(policy);
  });

  it("puts the charter after the instructions the policy has", () => {
    expect(withProfile({ ...plain, instructions: "End with wrap_up." }, bound()).instructions).toBe(
      "End with wrap_up.\n\nDo the task.",
    );
    expect(withProfile(plain, bound()).instructions).toBe("Do the task.");
    expect(withProfile(plain, bound({ charter: "  \n" })).instructions).toBeUndefined();
  });

  it("opens the gate its level names, publish when it names none", () => {
    expect(withProfile(plain, bound()).outwardGate).toBe("irreversible");
    expect(withProfile(plain, bound({ autonomy: "supervised" })).outwardGate).toBe("all");
    expect(withProfile(plain, bound({ autonomy: "publish" })).outwardGate).toBe("irreversible");
    expect(withProfile(plain, bound({ autonomy: "full" })).outwardGate).toBeUndefined();
  });

  it("never opens a gate the policy holds shut", () => {
    // What a failed policy port leaves: the strictest gate, which no profile loosens.
    const failed: SessionPolicy = { audience: "plain", outwardGate: "all" };
    expect(withProfile(failed, bound({ autonomy: "full" })).outwardGate).toBe("all");
    expect(
      withProfile({ ...plain, outwardGate: "irreversible" }, bound({ autonomy: "full" }))
        .outwardGate,
    ).toBe("irreversible");
  });

  it("holds the session to the profile's server by address, or to none", () => {
    const one = withProfile(plain, bound({ server: SERVER }));
    expect(one.mcpAllowlist).toEqual([SERVER.url]);
    expect(one.mcpServer).toEqual(SERVER);
    const none = withProfile({ ...plain, mcpAllowlist: ["github"] }, bound());
    expect(none.mcpAllowlist).toEqual([]);
    expect(none.mcpServer).toBeUndefined();
  });

  it("only ever narrows what the policy lets in", () => {
    // An allowlist that doesn't name the server keeps it out, and nothing else in.
    const listed = withProfile(
      { ...plain, mcpAllowlist: ["github", "linear"] },
      bound({ server: SERVER }),
    );
    expect(listed.mcpAllowlist).toEqual([]);
    expect(listed.mcpServer).toBeUndefined();
    // One that names it, by name or by a pattern over its address, lets it in alone.
    for (const entry of ["workspace", "https://mcp.example.test/*"]) {
      const let_in = withProfile(
        { ...plain, mcpAllowlist: ["github", entry] },
        bound({ server: SERVER }),
      );
      expect(let_in.mcpAllowlist).toEqual([SERVER.url]);
      expect(let_in.mcpServer).toEqual(SERVER);
    }
    // A denylist stays, and a server it names isn't given.
    const denied = withProfile(
      { ...plain, mcpDenylist: ["slack", "https://mcp.example.test/*"] },
      bound({ server: SERVER }),
    );
    expect(denied.mcpDenylist).toEqual(["slack", "https://mcp.example.test/*"]);
    expect(denied.mcpAllowlist).toEqual([]);
    expect(denied.mcpServer).toBeUndefined();
    const kept = withProfile({ ...plain, mcpDenylist: ["slack"] }, bound({ server: SERVER }));
    expect(kept.mcpDenylist).toEqual(["slack"]);
    expect(kept.mcpServer).toEqual(SERVER);
    // And the switch that takes every server from a session without tool search stays on.
    expect(
      withProfile({ ...plain, mcpNoneWithoutToolSearch: true }, bound({ server: SERVER }))
        .mcpNoneWithoutToolSearch,
    ).toBe(true);
  });

  it("keeps the rest of the policy", () => {
    const policy: SessionPolicy = {
      ...plain,
      audience: "worker",
      pinCwd: true,
      noBlockingAsk: true,
    };
    expect(withProfile(policy, bound())).toMatchObject({
      audience: "worker",
      pinCwd: true,
      noBlockingAsk: true,
    });
  });
});
