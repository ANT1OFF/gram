import type { UserInput } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { withoutOpenCodeAgents } from "./protocol.ts";

const worker = (agent: "claude" | "opencode") => ({ threadId: `t-${agent}`, agent });

const digest = (workers: ReadonlyArray<ReturnType<typeof worker>>) =>
  ({
    text: "digest",
    notice: { kind: "orchestration", features: [{ feature: "f", workers }] },
  }) as unknown as UserInput;

describe("a digest for a host that doesn't know OpenCode", () => {
  it("leaves an OpenCode worker's agent out and keeps the rest", () => {
    const read = withoutOpenCodeAgents(digest([worker("claude"), worker("opencode")]));
    const workers = (read.notice as unknown as { features: [{ workers: unknown[] }] }).features[0]
      .workers;
    expect(workers).toEqual([
      { threadId: "t-claude", agent: "claude" },
      { threadId: "t-opencode" },
    ]);
  });

  it("hands back any other input as it is", () => {
    const plain = { text: "hi" } as UserInput;
    expect(withoutOpenCodeAgents(plain)).toBe(plain);
    const claudeOnly = digest([worker("claude")]);
    expect(withoutOpenCodeAgents(claudeOnly)).toBe(claudeOnly);
  });
});
