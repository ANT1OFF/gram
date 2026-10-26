import { DEFAULT_CHARTER, idleCompactOf } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { withIdleCompact, withIdleCompactWorkers } from "./idle-compact-field";

describe("idle compaction setting", () => {
  it("is on for the orchestrator in a workspace that never set it", () => {
    expect(idleCompactOf(DEFAULT_CHARTER)).toEqual({ enabled: true, kinds: ["orchestrator"] });
  });

  it("stores off explicitly and on as the default", () => {
    const off = withIdleCompact(DEFAULT_CHARTER, false);
    expect(off.idleAutoCompact).toBe(false);
    expect(withIdleCompact(off, true)).not.toHaveProperty("idleAutoCompact");
  });

  it("adds workers alongside the orchestrator, and goes back to the default without them", () => {
    const both = withIdleCompactWorkers(DEFAULT_CHARTER, true);
    expect(idleCompactOf(both).kinds).toEqual(["orchestrator", "worker"]);
    expect(withIdleCompactWorkers(both, false)).not.toHaveProperty("idleAutoCompactKinds");
  });
});
