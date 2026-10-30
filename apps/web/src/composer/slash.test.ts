import type { AgentKind, SlashCommand } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { filterCommands, slashQuery } from "./slash";
import { menuCommands, resolveTyped, gramLast } from "./slash-native";

const commands: SlashCommand[] = [
  { name: "review", description: "Review the current diff" },
  { name: "compact", description: "Summarise the conversation" },
  { name: "pr-comments", description: "Fetch PR review comments", aliases: ["prc"] },
  { name: "cost", description: "Show token usage" },
];

describe("slashQuery", () => {
  it("returns the partial command while typing a leading slash", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/rev")).toBe("rev");
  });

  it("stops once arguments start or the slash isn't leading", () => {
    expect(slashQuery("/review main")).toBeUndefined();
    expect(slashQuery("see /review")).toBeUndefined();
    expect(slashQuery("")).toBeUndefined();
  });
});

describe("filterCommands", () => {
  it("returns everything for an empty query, alphabetically", () => {
    expect(filterCommands(commands, "").map((c) => c.name)).toEqual([
      "compact",
      "cost",
      "pr-comments",
      "review",
    ]);
  });

  it("ranks prefix, then substring, then description matches", () => {
    expect(filterCommands(commands, "co").map((c) => c.name)).toEqual([
      "compact",
      "cost",
      "pr-comments",
    ]);
    expect(filterCommands(commands, "diff").map((c) => c.name)).toEqual(["review"]);
  });

  it("matches aliases", () => {
    expect(filterCommands(commands, "prc").map((c) => c.name)).toEqual(["pr-comments"]);
  });
});

const names = (list: readonly { name: string }[]) => list.map((c) => c.name);

describe("the slash menu's commands", () => {
  const claude: SlashCommand[] = [
    { name: "compact", description: "Compact" },
    { name: "agents", description: "(removed)" },
    { name: "deploy", description: "The user's command" },
  ];

  it("adds Gram's under names the agent leaves free, the terminal's aliases too", () => {
    const menu = menuCommands("claude", claude, true);
    expect(names(menu.filter((c) => c.action === undefined))).toEqual(names(claude));
    expect(menu.find((c) => c.name === "model")?.action).toBe("pickModel");
    expect(menu.find((c) => c.name === "new")?.aliases).toEqual(["clear", "reset"]);
  });

  it("leaves a name the agent reports to the agent, in the menu and when typed", () => {
    const own = [
      { name: "help", description: "A Codex skill" },
      { name: "clear", description: "A user's command" },
      { name: "status", description: "A user's command" },
    ];
    const menu = menuCommands("codex", own, true);
    expect(menu.filter((c) => c.name === "help").map((c) => c.action)).toEqual([undefined]);
    expect(menu.find((c) => c.name === "new")?.aliases).toBeUndefined();
    expect(names(menu)).toContain("status");
    for (const text of ["/help", "/clear", "/status"]) {
      expect(resolveTyped("codex", text, own, true)).toEqual({ kind: "agent" });
    }
    expect(resolveTyped("codex", "/new", own, true)).toMatchObject({ action: "newThread" });
  });

  it("offers fork only where the agent forks, and add-dir only where it takes folders", () => {
    expect(names(menuCommands("claude", [], false))).not.toContain("fork");
    expect(names(menuCommands("claude", [], true))).toContain("fork");
    expect(names(menuCommands("unknown-agent" as string as AgentKind, [], true))).not.toContain(
      "add-dir",
    );
    expect(names(menuCommands("codex", [], true))).toContain("add-dir");
  });

  it("lists the agent's own before Gram's among equal matches", () => {
    const menu = menuCommands("claude", claude, true);
    const all = filterCommands(menu, "", gramLast);
    expect(all.findIndex((c) => c.action !== undefined)).toBe(claude.length);
    expect(names(filterCommands(menu, "ne", gramLast))[0]).toBe("new");
  });
});

describe("what a typed command does", () => {
  const reported: SlashCommand[] = [{ name: "deploy", description: "The user's command" }];

  it("runs Gram's for its names and the terminal's aliases", () => {
    expect(resolveTyped("claude", "/clear", reported, true)).toEqual({
      kind: "native",
      action: "newThread",
      args: "",
    });
    expect(resolveTyped("codex", "/approvals", [], true)).toMatchObject({ action: "pickMode" });
    expect(resolveTyped("codex", "/rename  Ship it ", [], true)).toEqual({
      kind: "native",
      action: "rename",
      args: "Ship it",
    });
  });

  it("leaves Claude's /model with an id to Claude, which the thread follows", () => {
    expect(resolveTyped("claude", "/model opus[1m]", [], true)).toEqual({ kind: "agent" });
    expect(resolveTyped("claude", "/model", [], true)).toMatchObject({ action: "pickModel" });
    expect(resolveTyped("codex", "/model gpt-5.5", [], true)).toMatchObject({
      action: "pickModel",
      args: "gpt-5.5",
    });
  });

  it("explains a terminal-only command instead of sending it, unless the agent lists it", () => {
    expect(resolveTyped("claude", "/plugins", reported, true)).toEqual({
      kind: "unavailable",
      note: "/plugins isn't available in Gram threads; open Claude Code in a terminal.",
    });
    expect(resolveTyped("codex", "/diff", [], true)).toEqual({
      kind: "unavailable",
      note: "/diff isn't available in Gram threads; the Diff panel shows the thread's changes.",
    });
    expect(resolveTyped("codex", "/prompts:draft x", [], true)).toMatchObject({
      kind: "unavailable",
    });
    expect(
      resolveTyped("claude", "/status", [{ name: "status", description: "A user's own" }], true),
    ).toEqual({ kind: "agent" });
  });

  it("sends anything else as typed: the agent's commands, unknown names and paths", () => {
    for (const text of ["/deploy now", "/todos", "/tmp is full", "fix /plugins", ""]) {
      expect(resolveTyped("claude", text, reported, true)).toEqual({ kind: "agent" });
    }
  });
});
