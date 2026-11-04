import { LIMIT_PAUSE_TOOL, type ApprovalRequest, type RequestId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { limitShareText } from "@/usage/limit-format";

import { alwaysRules, limitPauseAsk } from "./request-model";

const pause = (input: Record<string, unknown>): ApprovalRequest => ({
  kind: "approval",
  id: "r-pause" as RequestId,
  toolName: LIMIT_PAUSE_TOOL,
  displayName: "limit_pause",
  input,
  suggestions: [],
});

describe("limitPauseAsk", () => {
  it("leads with the held brief's own sentence, the week by its one name", () => {
    const now = Date.UTC(2026, 9, 15, 14, 39);
    const ask = limitPauseAsk(
      pause({
        agent: "claude",
        window: "seven_day",
        usedPct: 90,
        pauseAtPct: 90,
        resetsAt: Date.UTC(2026, 9, 15, 18),
      }),
      now,
      { locale: "en-GB", timeZone: "UTC" },
    );
    expect(ask?.lead).toBe("Claude is at 90% of its weekly limit");
    expect(ask?.lead).toBe(limitShareText({ agent: "claude", usedPct: 90, window: "weekly" }));
    expect(ask?.pause).toBe("Pause until 18:00");
  });
});

/** A Bash approval whose one suggestion is kept in `destination`. */
const bash = (destination: "session" | "localSettings" | "projectSettings" | "userSettings") =>
  ({
    kind: "approval",
    id: "r" as RequestId,
    toolName: "Bash",
    displayName: "Bash",
    input: { command: "git push" },
    suggestions: [
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "git push:*" }],
        behavior: "allow",
        destination,
      },
    ],
  }) satisfies ApprovalRequest;

describe("alwaysRules", () => {
  it("states each rule as the agent spells it, with the reach its destination has", () => {
    expect(alwaysRules(bash("localSettings"))).toEqual([
      {
        rule: "Bash(git push:*)",
        behavior: "Allow",
        reach: "folder",
        scope: "every thread working in it, for you only",
        kept: ".claude/settings.local.json",
      },
    ]);
    expect(alwaysRules(bash("session"))[0]).toMatchObject({ reach: "thread", kept: undefined });
    expect(alwaysRules(bash("projectSettings"))[0]).toMatchObject({ reach: "project" });
    expect(alwaysRules(bash("userSettings"))[0]).toMatchObject({ reach: "everywhere" });
  });

  it("names folders and modes, and a browse host as the app-wide list it joins", () => {
    const request = {
      ...bash("session"),
      suggestions: [
        { type: "addDirectories", directories: ["/tmp/out"], destination: "session" },
        { type: "setMode", mode: "acceptEdits", destination: "session" },
      ],
    } satisfies ApprovalRequest;
    expect(alwaysRules(request).map((rule) => [rule.behavior, rule.rule])).toEqual([
      ["Add folder", "/tmp/out"],
      ["Mode", "Accept edits without asking"],
    ]);
    expect(
      alwaysRules({ ...bash("session"), suggestions: [], browseHost: "docs.example.com" }),
    ).toMatchObject([{ rule: "docs.example.com", reach: "everywhere" }]);
  });

  it("has nothing to save for a card without suggestions, as every Codex card is", () => {
    expect(alwaysRules({ ...bash("session"), suggestions: [] })).toEqual([]);
  });
});
