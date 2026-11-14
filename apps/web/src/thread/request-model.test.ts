import { LIMIT_PAUSE_TOOL, type ApprovalRequest, type RequestId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { limitShareText } from "@/usage/limit-format";

import {
  alwaysRules,
  approvalReceipt,
  browserAsk,
  browserAskLine,
  limitPauseAsk,
} from "./request-model";

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
        reach: "repository",
        scope:
          "the main checkout and all its worktrees, for you only, after this worktree is gone too",
        kept: ".claude/settings.local.json at the repository root",
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

const call = (
  toolName: string,
  input: Record<string, unknown>,
  more: Partial<ApprovalRequest> = {},
): ApprovalRequest => ({
  kind: "approval",
  id: "r-browser" as RequestId,
  toolName,
  displayName: toolName,
  input,
  suggestions: [],
  scopes: ["once"],
  ...more,
});

describe("browserAsk", () => {
  it("says a click, a key and typed text in words, with where and what", () => {
    const click = call("mcp__claude-in-chrome__computer", {
      action: "left_click",
      coordinate: [912, 418],
      tabId: 7,
    });
    expect(browserAsk(click)).toEqual({
      title: "Click in your browser?",
      fields: [{ label: "At", value: "912, 418" }],
    });
    expect(browserAskLine(click)).toBe("Click in your browser: 912, 418");
    expect(approvalReceipt(click, "once").subject).toBe("Click in your browser: 912, 418");
    expect(
      browserAsk(call("mcp__claude-in-chrome__computer", { action: "key", text: "cmd+Enter" })),
    ).toEqual({
      title: "Press a key in your browser?",
      fields: [{ label: "Keys", value: "cmd+Enter" }],
    });
    expect(
      browserAsk(call("mcp__claude-in-chrome__computer", { action: "type", text: "hello" })),
    ).toEqual({ title: "Type in your browser?", fields: [{ label: "Text", value: "hello" }] });
  });

  it("names the site a navigation opens, and keeps the whole address", () => {
    const url = "https://github.com/acme/web/pull/412/files";
    expect(browserAsk(call("mcp__claude-in-chrome__navigate", { url, tabId: 7 }))).toEqual({
      title: "Open github.com in your browser?",
      fields: [{ label: "Address", value: url }],
    });
    expect(browserAsk(call("mcp__claude-in-chrome__navigate", { url: "back" }))?.title).toBe(
      "Open a page in your browser?",
    );
  });

  it("words a field, a script and a tool it has no words for", () => {
    expect(
      browserAsk(call("mcp__claude-in-chrome__form_input", { ref: "ref_27", value: "LGTM" })),
    ).toEqual({
      title: "Fill in a field in your browser?",
      fields: [{ label: "Text", value: "LGTM" }],
    });
    expect(
      browserAsk(call("mcp__claude-in-chrome__javascript_tool", { text: "document.title" })),
    ).toEqual({
      title: "Run a script in your browser?",
      fields: [{ label: "Script", value: "document.title" }],
    });
    expect(browserAsk(call("mcp__claude-in-chrome__gif_creator", {}))?.title).toBe(
      "Use gif creator in your browser?",
    );
    expect(browserAsk(call("mcp__claude-in-chrome__computer", { action: "zoom" }))?.title).toBe(
      "Do “zoom” in your browser?",
    );
  });

  it("makes a server's short question the title, and keeps a longer prompt as the body", () => {
    const input = { server: "computer-use", app: "Safari" };
    expect(
      browserAsk(
        call("mcp__computer-use__elicitation", input, {
          displayName: "Safari",
          description: "Allow Codex to use Safari?",
        }),
      ),
    ).toEqual({
      title: "Allow Codex to use Safari?",
      fields: [{ label: "Asked by", value: "computer-use" }],
    });
    const long = "Codex wants to control Safari.\nIt can see and click everything in its windows.";
    expect(
      browserAsk(
        call("mcp__computer-use__elicitation", input, { displayName: "Safari", description: long }),
      ),
    ).toEqual({
      title: "Let it use Safari?",
      fields: [{ label: "Asked by", value: "computer-use" }],
      message: long,
    });
  });

  it("leaves every other approval as it was", () => {
    expect(browserAsk(call("Bash", { command: "ls" }))).toBeUndefined();
    expect(
      browserAsk(call("mcp__gram__browser_navigate", { url: "https://x.test/" })),
    ).toBeUndefined();
    expect(browserAskLine(call("Bash", { command: "ls" }))).toBeUndefined();
  });
});
