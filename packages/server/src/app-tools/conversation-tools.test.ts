// Whether `reply` raises Gram's own card: a host with a decision hook decides its conversations'
// replies itself, so a thread at `supervised` asks there only when the host asks.
import { ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import type { ConversationsShape } from "../embedding/conversations.ts";
import type { DecisionHookShape } from "../embedding/decision-hook.ts";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import { replyTool } from "./conversation-tools.ts";

const thread = ThreadId.make("desk");
const supervisedStore = {
  getThread: () => Effect.succeed({ id: thread, profile: { autonomy: "supervised" } }),
} as unknown as ThreadStoreShape;
const hook = (enabled: boolean): DecisionHookShape => ({
  enabled: Effect.succeed(enabled),
  decide: () => Effect.die(new Error("not asked here")),
});
const asks = (decisions: DecisionHookShape | undefined) => {
  const tool = replyTool(
    {} as ConversationsShape,
    supervisedStore,
    undefined,
    undefined,
    "/a",
    decisions,
  );
  const target = { conversation: "c-1", text: "Done.", files: [] };
  return Effect.runPromise(tool.needsApproval!(thread, target, target));
};

describe("reply at supervised", () => {
  it("asks with no decision hook, or one that is off", async () => {
    expect(await asks(undefined)).toBe(true);
    expect(await asks(hook(false))).toBe(true);
  });

  it("leaves the approval to the host's decision hook when it is on", async () => {
    expect(await asks(hook(true))).toBe(false);
  });
});
