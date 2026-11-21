import type { RequestId, ThreadId } from "@gram/contracts";
import { describe, expect, it, vi } from "vitest";

import { respondToCard } from "./respond-to-card";

const T = "t1" as ThreadId;
const ID = "r1" as RequestId;
const allow = { kind: "approval", decision: "allow", scope: "once" } as const;

describe("an answer to a card", () => {
  it("names the card it was given for, so one asked again under its id refuses it", async () => {
    const respond = vi.fn(async () => {});
    await respondToCard({ respond }, T, { id: ID, shown: "card-1" }, allow);
    expect(respond).toHaveBeenCalledWith(T, ID, allow, "card-1");
  });

  it("goes as before for a card listed with no key", async () => {
    const respond = vi.fn(async () => {});
    await respondToCard({ respond }, T, { id: ID }, allow);
    expect(respond.mock.calls).toEqual([[T, ID, allow]]);
  });
});
