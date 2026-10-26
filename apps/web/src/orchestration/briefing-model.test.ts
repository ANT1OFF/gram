import type { FeatureCard, GramUIMessage, WorkspaceId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { BRIEFING_STALE_MS, briefingOf, excerptOf } from "./briefing-model";

const SENT = 1_000_000;

const user = (text: string, createdAt = SENT, extra: GramUIMessage["parts"] = []): GramUIMessage =>
  ({
    id: `u-${createdAt}`,
    role: "user",
    metadata: { createdAt },
    parts: [{ type: "text", text }, ...extra],
  }) as GramUIMessage;

const reply = (createdAt: number, spawn?: "ok" | "error"): GramUIMessage =>
  ({
    id: `a-${createdAt}`,
    role: "assistant",
    metadata: { createdAt },
    parts: [
      { type: "text", text: "On it." },
      ...(spawn === undefined
        ? []
        : [
            {
              type: "dynamic-tool",
              toolName: "mcp__gram__spawn_worker",
              toolCallId: `c-${createdAt}`,
              ...(spawn === "ok"
                ? { state: "output-available", input: {}, output: {} }
                : { state: "output-error", input: {}, errorText: "Refused" }),
            },
          ]),
    ],
  }) as GramUIMessage;

const card = (createdAt: number, updatedAt = createdAt): FeatureCard => ({
  workspaceId: "w-1" as WorkspaceId,
  feature: `f-${createdAt}`,
  station: "briefed",
  version: 1,
  workers: [],
  createdAt,
  updatedAt,
});

const at = (
  messages: GramUIMessage[],
  status: Parameters<typeof briefingOf>[0]["status"],
  cards: FeatureCard[] = [],
  now = SENT + 1_000,
) => briefingOf({ messages, cards, status, now });

describe("briefingOf", () => {
  it("shows from the moment a message is sent, before the turn has started", () => {
    expect(at([user("Add paging to the registry list in web")], "idle")).toEqual({
      messageId: `u-${SENT}`,
      excerpt: "Add paging to the…",
      phase: "reading",
    });
  });

  it("reads while the orchestrator works, briefs once it spawns, and gives way to the new card", () => {
    const sent = user("Add paging");
    expect(at([sent, reply(SENT + 10)], "running")?.phase).toBe("reading");
    const spawning = [sent, reply(SENT + 10, "ok")];
    expect(at(spawning, "running")?.phase).toBe("briefing");
    // The card can lag the turn: it still says briefing until the card is in.
    expect(at(spawning, "idle")?.phase).toBe("briefing");
    expect(at(spawning, "idle", [card(SENT + 20)])).toBeUndefined();
    // An older feature's card that hasn't changed since doesn't count.
    expect(at(spawning, "idle", [card(SENT - 50)])?.phase).toBe("briefing");
    // A worker added to a feature that has a card: that card changing after the spawn does.
    expect(at(spawning, "idle", [card(SENT - 50, SENT + 30)])).toBeUndefined();
  });

  it("goes when the orchestrator only answers", () => {
    expect(at([user("What is stuck?"), reply(SENT + 10)], "idle")).toBeUndefined();
  });

  it("goes when nothing answers or a spawn's card never comes", () => {
    const late = SENT + BRIEFING_STALE_MS + 1;
    expect(at([user("Hello")], "idle", [], late)).toBeUndefined();
    expect(at([user("Hello")], "running", [], late)?.phase).toBe("reading");
    expect(at([user("Go"), reply(SENT + 10, "ok")], "idle", [], late + 10)).toBeUndefined();
  });

  it("doesn't count a spawn that failed", () => {
    expect(at([user("Go"), reply(SENT + 10, "error")], "running")?.phase).toBe("reading");
    expect(at([user("Go"), reply(SENT + 10, "error")], "idle")).toBeUndefined();
  });

  it("follows only what the user typed, not a digest or another thread's message", () => {
    const digest = user("Wake", SENT + 100, [
      { type: "data-orchestration-digest", data: {} } as unknown as GramUIMessage["parts"][number],
    ]);
    expect(at([user("Add paging"), reply(SENT + 10), digest], "running")).toBeUndefined();
    expect(at([digest], "running")).toBeUndefined();
  });
});

describe("excerptOf", () => {
  it("keeps four words", () => {
    expect(excerptOf("  Add   mail triggers ")).toBe("Add mail triggers");
    expect(excerptOf("one two three four five")).toBe("one two three four…");
  });
});
