import type {
  AgentModel,
  LaunchChecks,
  ModelRef,
  PendingRequest,
  Thread,
  ThreadId,
  ThreadSummary,
} from "@gram/contracts";
import { describe, expect, it } from "vitest";

import {
  carriesLine,
  continueHint,
  defaultTarget,
  limitLine,
  modeLine,
  orchestratorCarriesLine,
  sheetEfforts,
  switchDividerBefore,
  switchDividerLabel,
  switchLimitMeta,
  switchLimitOf,
  switchOffer,
} from "./agent-switch-model";

const CLAUDE: ModelRef = { agent: "claude", model: "claude-opus-5-5", variant: "high" };

const thread = (overrides: Partial<Thread> = {}): Thread =>
  ({
    id: "t-1" as ThreadId,
    title: "Sort History by last activity",
    model: CLAUDE,
    mode: "auto",
    checkout: { path: "/work/app" },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }) as Thread;

const summary = (
  overrides: Partial<Pick<ThreadSummary, "status" | "pendingRequests" | "background">> = {},
  threadOverrides: Partial<Thread> = {},
) => ({
  thread: thread(threadOverrides),
  status: "idle" as const,
  pendingRequests: [],
  ...overrides,
});

const checks = (overrides: Partial<LaunchChecks> = {}): LaunchChecks => ({
  checkedAt: 1,
  tools: [
    { tool: "claude", found: true },
    { tool: "codex", found: true, version: "0.166.0" },
  ],
  claudeSignIn: "signedIn",
  codexSignIn: "signedIn",
  ghSignedIn: true,
  ...overrides,
});

const offer = (
  s: ReturnType<typeof summary>,
  c: LaunchChecks | undefined = checks(),
  more: { platform?: string; listed?: boolean } = {},
) => switchOffer({ summary: s, checks: c, listed: more.listed ?? true, platform: more.platform });

/** An orchestrator's summary, as `summary` makes a plain thread's. */
const orchestrator = (overrides: Parameters<typeof summary>[0] = {}, more: Partial<Thread> = {}) =>
  summary(overrides, { role: "orchestrator", workspaceId: "w-1" as never, ...more });

const CODEX_MODELS: AgentModel[] = [
  {
    id: "gpt-5.5",
    displayName: "GPT-5.5",
    supportsEffort: true,
    efforts: ["low", "medium", "high"],
    isDefault: true,
  },
  {
    id: "gpt-6.1-sol",
    displayName: "GPT-6.1-Sol",
    supportsEffort: true,
    efforts: ["low", "medium", "high", "xhigh"],
  },
  { id: "gpt-6-luna", displayName: "GPT-6 Luna", supportsEffort: true, efforts: ["low", "high"] },
] as AgentModel[];

describe("switchOffer", () => {
  it("offers the other agent on an idle plain thread", () => {
    expect(offer(summary())).toEqual({ offered: true, to: "codex" });
    expect(offer(summary({}, { model: { agent: "codex", model: "gpt-5.5" } }))).toEqual({
      offered: true,
      to: "claude",
    });
  });

  it("offers nothing with one harness, on Windows or with nothing listed", () => {
    expect(offer(summary(), checks({ tools: [{ tool: "claude", found: true }] })).offered).toBe(
      false,
    );
    expect(switchOffer({ summary: summary(), checks: undefined, listed: true }).offered).toBe(
      false,
    );
    expect(offer(summary(), checks(), { platform: "win32" }).offered).toBe(false);
    expect(offer(summary(), checks(), { listed: false }).offered).toBe(false);
    expect(
      offer(
        summary({}, { role: "orchestrator" }),
        checks({ tools: [{ tool: "claude", found: true }] }),
      ).offered,
    ).toBe(false);
  });

  it("offers the orchestrator the same sheet, greyed only where its switch would be refused", () => {
    expect(offer(orchestrator())).toEqual({ offered: true, to: "codex" });
    // Its checkpoint waits for its turn and questions, so neither greys it.
    expect(offer(orchestrator({ status: "running" }))).toEqual({ offered: true, to: "codex" });
    expect(
      offer(orchestrator({ pendingRequests: [{ id: "r" } as unknown as PendingRequest] })),
    ).toEqual({ offered: true, to: "codex" });
    expect(offer(orchestrator(), checks({ codexSignIn: "notSignedIn" }))).toMatchObject({
      refusal: "Sign in to Codex in Settings → Agents.",
    });
    // One under way opens on how it stands, toward its own target.
    const change = {
      id: "a",
      previous: CLAUDE,
      target: { agent: "codex" as const, model: "gpt-5.5" },
      mode: "auto" as const,
      phase: "failed" as const,
      oldExited: true,
    };
    expect(offer(orchestrator({}, { model: change.target, sessionSwitch: change }))).toEqual({
      offered: true,
      to: "codex",
    });
  });

  it("greys it with the server's words", () => {
    const refusal = (s: ReturnType<typeof summary>, c?: LaunchChecks) => {
      const result = offer(s, c);
      return result.offered ? result.refusal : "not offered";
    };
    expect(refusal(summary({ status: "running" }))).toBe(
      "Wait for this turn to finish, or stop it, then switch.",
    );
    expect(
      refusal(
        summary(
          {},
          {
            sessionSwitch: {
              id: "a",
              previous: CLAUDE,
              target: { agent: "codex", model: "gpt-5.5" },
              mode: "auto",
              phase: "stopping",
              oldExited: false,
            },
          },
        ),
      ),
    ).toBe("Wait for this turn to finish, or stop it, then switch.");
    expect(refusal(summary({ pendingRequests: [{ id: "r" } as unknown as PendingRequest] }))).toBe(
      "Answer the open approval first. It can't move to Codex.",
    );
    expect(
      refusal(
        summary({
          background: [{ id: "b" } as unknown as NonNullable<ThreadSummary["background"]>[number]],
        }),
      ),
    ).toBe("Claude still has background work running.");
    expect(refusal(summary({}, { model: { ...CLAUDE, profileId: "p" as never } }))).toBe(
      "Switching uses the CLI's own sign-in; it doesn't move gateway accounts.",
    );
    expect(refusal(summary(), checks({ codexSignIn: "notSignedIn" }))).toBe(
      "Sign in to Codex in Settings → Agents.",
    );
    expect(
      refusal(summary({}, { forkedFrom: { threadId: "t-0" as ThreadId } } as Partial<Thread>)),
    ).toBe("Send once in this fork first.");
    // A failed last turn moves too: that's limit mode.
    expect(refusal(summary({ status: "error" }))).toBeUndefined();
  });

  it("still offers a signed-out agent greyed, even though it lists no models", () => {
    expect(offer(summary(), checks({ codexSignIn: "notSignedIn" }), { listed: false })).toEqual({
      offered: true,
      to: "codex",
      refusal: "Sign in to Codex in Settings → Agents.",
    });
  });
});

/** The mode line for a worker moving to Codex 0.166, ungated, unless `over` says otherwise. */
const line = (over: Partial<Parameters<typeof modeLine>[0]>) =>
  modeLine({
    mode: "auto",
    to: "codex",
    worker: true,
    gated: false,
    codexVersion: "0.166.0",
    ...over,
  });

describe("the sheet's words", () => {
  it("names the switch on hover and the limit first", () => {
    expect(continueHint("codex")).toBe("Continue in Codex: new session with a handoff");
    expect(continueHint("claude")).toBe("Continue in Claude Code: new session with a handoff");
    const at = new Date(2026, 10, 11, 15, 0).getTime();
    expect(limitLine({ reason: "usage", until: at }, "claude", "codex")).toBe(
      "Claude is out of usage until 15:00, so Codex's first turn writes the note from the transcript and does no other work.",
    );
    expect(limitLine({ reason: "failed" }, "claude", "codex")).toContain(
      "Claude's last turn failed",
    );
  });

  it("says what carries over by the note and limit mode", () => {
    expect(carriesLine("claude", true, false)).toBe(
      "A note from Claude, the plan, open asks, the last turns, and the branch and PR.",
    );
    expect(carriesLine("claude", false, false)).not.toContain("note");
    expect(carriesLine("claude", true, true)).toContain("about 24k tokens");
    expect(orchestratorCarriesLine("claude", true, false)).toBe(
      "A note from Claude, your last exchanges, memory, the charter and the ledger.",
    );
    expect(orchestratorCarriesLine("claude", true, true)).not.toContain("note");
    expect(orchestratorCarriesLine("claude", false, false)).not.toContain("note");
  });

  it("finds limit mode as the server does", () => {
    expect(switchLimitOf(summary())).toBeUndefined();
    expect(
      switchLimitOf(
        summary({}, {
          limitWait: {
            kind: "limit",
            account: "claude",
            resumeAt: 9,
            resetsAt: 8,
            since: 1,
            attempt: 0,
          },
        } as Partial<Thread>),
      ),
    ).toEqual({ reason: "usage", until: 8 });
    expect(switchLimitOf(summary({ status: "error" }))).toEqual({ reason: "failed" });
  });

  it("names a mode change only when Codex can't keep Claude's Auto", () => {
    expect(line({})).toBeUndefined();
    expect(line({ codexVersion: "0.159.2" })).toBe(
      "Codex runs this worker in Bypass. Its Auto needs Codex 0.166 or newer.",
    );
    expect(line({ codexVersion: "0.159.2", worker: false })).toBe(
      "Codex runs this thread in Ask. Its Auto needs Codex 0.166 or newer.",
    );
    expect(line({ gated: true })).toContain("Bypass");
    expect(line({ gated: true, worker: false, orchestrator: true })).toBe(
      "Codex runs the orchestrator in Bypass. Its Auto can't keep this workspace's approval gate.",
    );
    expect(line({ mode: "default" })).toBeUndefined();
    expect(line({ to: "claude" })).toBeUndefined();
  });
});

describe("defaultTarget", () => {
  it("takes the target's model for the current model's tier, at the current effort", () => {
    expect(defaultTarget({ current: CLAUDE, to: "codex", models: CODEX_MODELS })).toEqual({
      agent: "codex",
      model: "gpt-6.1-sol",
      variant: "high",
    });
  });

  it("knows a family alias as its tier's model, at the tier's effort without one of its own", () => {
    expect(
      defaultTarget({
        current: { agent: "claude", model: "sonnet" },
        to: "codex",
        models: CODEX_MODELS,
      }),
    ).toEqual({ agent: "codex", model: "gpt-6.1-sol", variant: "medium" });
  });

  it("never goes past High, and clamps to what the model lists", () => {
    expect(
      defaultTarget({ current: { ...CLAUDE, variant: "max" }, to: "codex", models: CODEX_MODELS })
        ?.variant,
    ).toBe("high");
    expect(
      defaultTarget({
        current: { ...CLAUDE, variant: "medium" },
        to: "codex",
        models: CODEX_MODELS,
        picked: "gpt-6-luna",
      }),
    ).toEqual({ agent: "codex", model: "gpt-6-luna", variant: "low" });
    expect(sheetEfforts(CODEX_MODELS, "gpt-6.1-sol")).toEqual(["low", "medium", "high"]);
  });

  it("falls back to the target's default outside the table", () => {
    expect(
      defaultTarget({
        current: { agent: "claude", model: "custom-model" },
        to: "codex",
        models: CODEX_MODELS,
      }),
    ).toEqual({ agent: "codex", model: "gpt-5.5", variant: "high" });
    expect(defaultTarget({ current: CLAUDE, to: "codex", models: [] })).toBeUndefined();
  });
});

describe("the divider", () => {
  const at = new Date(2026, 10, 11, 14, 2).getTime();
  it("reads where, on what and when, in 24-hour time", () => {
    expect(switchDividerLabel({ previousAgent: "claude", at }, "GPT-6.1-Sol")).toBe(
      "Continued in Codex · GPT-6.1-Sol · 14:02",
    );
    expect(switchDividerLabel({ previousAgent: "codex", at }, undefined)).toBe(
      "Continued in Claude Code · 14:02",
    );
  });

  it("names the session before on hover", () => {
    expect(
      switchDividerBefore({ previousAgent: "claude", previousAgentSessionId: "s-7" }, "Opus 5.5"),
    ).toBe("Before: Claude Code · Opus 5.5 · session s-7");
  });

  it("says limit mode's first turn writes the note", () => {
    expect(switchLimitMeta({ previousAgent: "claude", noteMode: "outgoing" })).toBeUndefined();
    expect(switchLimitMeta({ previousAgent: "claude", noteMode: "limit", limit: "usage" })).toBe(
      "Claude was out of usage · this turn writes the note, no work",
    );
    expect(switchLimitMeta({ previousAgent: "claude", noteMode: "limit", limit: "failed" })).toBe(
      "Claude's last turn failed · this turn writes the note, no work",
    );
  });
});
