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
    const listed: SessionPolicy = {
      ...plain,
      mcpAllowlist: ["github", "linear"],
      mcpDenylist: ["slack"],
      mcpNoneWithoutToolSearch: true,
    };
    const one = withProfile(listed, bound({ server: SERVER }));
    expect(one.mcpAllowlist).toEqual([SERVER.url]);
    expect(one.mcpServer).toEqual(SERVER);
    expect(one.mcpDenylist).toBeUndefined();
    expect(one.mcpNoneWithoutToolSearch).toBeUndefined();

    const none = withProfile(listed, bound());
    expect(none.mcpAllowlist).toEqual([]);
    expect(none.mcpServer).toBeUndefined();
    expect(none.mcpDenylist).toBeUndefined();
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
