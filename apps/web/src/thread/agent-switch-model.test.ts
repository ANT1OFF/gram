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

import { matchesModel } from "@/composer/models";
import { switchChoices } from "@/composer/switch-choices";

import {
  carriesLine,
  defaultTarget,
  modeLine,
  orchestratorCarriesLine,
  sheetEfforts,
  switchDividerLabel,
  switchLimitMeta,
  switchLimitOf,
  switchOffer,
  unlistedReason,
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
  more: { platform?: string; listed?: boolean; unlisted?: string; servesFresh?: boolean } = {},
) =>
  switchOffer({
    summary: s,
    checks: c,
    listed: more.listed ?? true,
    unlisted: more.unlisted,
    platform: more.platform,
    ...(more.servesFresh === undefined ? {} : { servesFresh: more.servesFresh }),
  });

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

// The composer chip's rows for the other agent, as a thread offers it.
const rows = (s: ReturnType<typeof summary>, c: LaunchChecks = checks()) =>
  switchChoices({ offer: offer(s, c), models: CODEX_MODELS, group: "Codex", icon: null });
const found = (s: ReturnType<typeof summary>, query: string, c?: LaunchChecks) =>
  rows(s, c).filter((row) => matchesModel(row, query));

describe("the chip's other-agent rows", () => {
  it("finds the other agent's model by search, on an orchestrator as on any thread", () => {
    for (const s of [summary(), orchestrator()]) {
      expect(found(s, "GPT-6.1").map((row) => row.value)).toEqual(["continue-in:gpt-6.1-sol"]);
      expect(found(s, "codex luna").map((row) => row.value)).toEqual(["continue-in:gpt-6-luna"]);
    }
  });

  it("opens the move rather than setting the model, and greys it when the move can't happen", () => {
    expect(rows(orchestrator()).every((row) => row.opens === true && !row.disabled)).toBe(true);
    const signedOut = rows(orchestrator(), checks({ codexSignIn: "notSignedIn" }));
    expect(signedOut.length).toBeGreaterThan(0);
    expect(signedOut.every((row) => row.disabled === true)).toBe(true);
  });

  it("lists nothing where the switch isn't offered", () => {
    const one = checks({ tools: [{ tool: "claude", found: true }] });
    expect(rows(orchestrator(), one)).toEqual([]);
  });
});

describe("switchOffer", () => {
  it("offers the other agent on an idle plain thread", () => {
    expect(offer(summary())).toEqual({ offered: true, to: "codex" });
    expect(offer(summary({}, { model: { agent: "codex", model: "gpt-5.5" } }))).toEqual({
      offered: true,
      to: "claude",
    });
  });

  it("offers nothing with one harness or with nothing listed", () => {
    expect(offer(summary(), checks({ tools: [{ tool: "claude", found: true }] })).offered).toBe(
      false,
    );
    expect(switchOffer({ summary: summary(), checks: undefined, listed: true }).offered).toBe(
      false,
    );
    expect(offer(summary(), checks(), { listed: false }).offered).toBe(false);
    expect(
      offer(
        summary({}, { role: "orchestrator" }),
        checks({ tools: [{ tool: "claude", found: true }] }),
      ).offered,
    ).toBe(false);
  });

  it("greys the entry with the listing's reason once the other agent's listing settles empty", () => {
    const why = unlistedReason("codex", { _tag: "AgentUnavailable", message: "no adapter" });
    expect(offer(summary(), checks(), { listed: false, unlisted: why })).toEqual({
      offered: true,
      to: "codex",
      refusal: why,
    });
    // Signed out says so itself, whatever the listing.
    expect(
      offer(summary(), checks({ codexSignIn: "notSignedIn" }), { listed: false, unlisted: why }),
    ).toEqual({ offered: true, to: "codex", refusal: "Sign in to Codex in Settings → Agents." });
  });

  it("on a headless server, which looks for no CLI itself, goes by what its machines list", () => {
    const headless = checks({ tools: [], headless: true, claudeSignIn: "unknown" });
    expect(offer(summary(), headless).offered).toBe(true);
    expect(offer(summary(), headless, { listed: false }).offered).toBe(false);
  });

  it("offers the orchestrator the same sheet, greyed only where its switch would be refused", () => {
    expect(offer(orchestrator())).toEqual({ offered: true, to: "codex" });
    // Its checkpoint waits for its turn and questions, so neither greys it.
    expect(offer(orchestrator({ status: "running" }))).toEqual({ offered: true, to: "codex" });
    expect(
      offer(orchestrator({ pendingRequests: [{ id: "r" } as unknown as PendingRequest] })),
    ).toEqual({ offered: true, to: "codex" });
    expect(offer(orchestrator(), checks({ codexSignIn: "notSignedIn" }))).toMatchObject({
      refusal: expect.stringMatching(/Sign in to Codex/),
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

  it("offers a fresh session where the session can't carry over", () => {
    expect(offer(summary(), checks(), { platform: "win32" })).toMatchObject({
      offered: true,
      to: "codex",
      fresh: expect.stringMatching(/Windows/),
    });
    expect(
      offer(summary({}, { model: { agent: "opencode", model: "openai/gpt-5.5" } })),
    ).toMatchObject({ offered: true, fresh: expect.stringMatching(/OpenCode/) });
    const gateway = offer(summary({}, { model: { ...CLAUDE, profileId: "p" as never } }));
    expect(gateway).toMatchObject({ offered: true, fresh: expect.stringMatching(/gateway/) });
    expect(gateway.offered && gateway.refusal).toBeFalsy();
    // A fresh session still waits for the turn.
    expect(offer(summary({ status: "running" }), checks(), { platform: "win32" })).toMatchObject({
      fresh: expect.any(String),
      refusal: expect.stringMatching(/turn/),
    });
  });

  it("greys a fresh session on a server without `thread.startFreshOn`", () => {
    const older = { platform: "win32", servesFresh: false };
    const worker = offer(summary(), checks(), older);
    expect(worker.offered && worker.refusal).toBeTruthy();
    // A carry-over and an orchestrator's handoff need nothing it lacks.
    expect(offer(summary(), checks(), { servesFresh: false })).toEqual({
      offered: true,
      to: "codex",
    });
    const lead = offer(orchestrator(), checks(), older);
    expect(lead.offered && lead.refusal).toBeFalsy();
  });

  it("greys it with the server's words", () => {
    const refusal = (s: ReturnType<typeof summary>, c?: LaunchChecks) => {
      const result = offer(s, c);
      return result.offered ? result.refusal : "not offered";
    };
    // Each refusal names what is in the way, as the server's does.
    expect(refusal(summary({ status: "running" }))).toMatch(/turn/);
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
    ).toMatch(/turn/);
    expect(
      refusal(summary({ pendingRequests: [{ id: "r" } as unknown as PendingRequest] })),
    ).toMatch(/approval/);
    expect(
      refusal(
        summary({
          background: [{ id: "b" } as unknown as NonNullable<ThreadSummary["background"]>[number]],
        }),
      ),
    ).toMatch(/background/);
    expect(refusal(summary(), checks({ codexSignIn: "notSignedIn" }))).toMatch(/Sign in to Codex/);
    expect(refusal(summary({}, { forkedFrom: { threadId: "t-0" as ThreadId } }))).toMatch(/fork/);
    // A failed last turn moves too: that's limit mode.
    expect(refusal(summary({ status: "error" }))).toBeUndefined();
  });

  it("still offers a signed-out agent greyed, even though it lists no models", () => {
    expect(offer(summary(), checks({ codexSignIn: "notSignedIn" }), { listed: false })).toEqual({
      offered: true,
      to: "codex",
      refusal: expect.stringMatching(/Sign in to Codex/),
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
  it("says what carries over by the note and limit mode", () => {
    expect(carriesLine("claude", true, false)).toContain("note");
    expect(carriesLine("claude", false, false)).not.toContain("note");
    expect(orchestratorCarriesLine("claude", true, false)).toContain("note");
    expect(orchestratorCarriesLine("claude", true, true)).not.toContain("note");
    expect(orchestratorCarriesLine("claude", false, false)).not.toContain("note");
  });

  it("finds limit mode as the server does", () => {
    expect(switchLimitOf(summary())).toBeUndefined();
    expect(
      switchLimitOf(
        summary(
          {},
          {
            limitWait: {
              kind: "limit",
              account: "claude",
              resumeAt: 9,
              resetsAt: 8,
              since: 1,
              attempt: 0,
            },
          },
        ),
      ),
    ).toEqual({ reason: "usage", until: 8 });
    expect(switchLimitOf(summary({ status: "error" }))).toEqual({ reason: "failed" });
  });

  it("names a mode change only when Codex can't keep Claude's Auto", () => {
    expect(line({})).toBeUndefined();
    // A worker falls back to Bypass, a plain thread to Ask, and the line says why.
    expect(line({ codexVersion: "0.159.2" })).toMatch(/Bypass.*0\.166/);
    expect(line({ codexVersion: "0.159.2", worker: false })).toMatch(/Ask.*0\.166/);
    expect(line({ gated: true })).toContain("Bypass");
    expect(line({ gated: true, worker: false, orchestrator: true })).toMatch(
      /orchestrator in Bypass.*approval gate/,
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
    expect(switchDividerLabel({ previousAgent: "claude", at }, "GPT-6.1-Sol")).toMatch(
      /Codex · GPT-6\.1-Sol · 14:02$/,
    );
    expect(switchDividerLabel({ previousAgent: "codex", at }, undefined)).toMatch(
      /Claude Code · 14:02$/,
    );
  });

  it("says limit mode's first turn writes the note", () => {
    expect(switchLimitMeta({ previousAgent: "claude", noteMode: "outgoing" })).toBeUndefined();
    const usage = switchLimitMeta({ previousAgent: "claude", noteMode: "limit", limit: "usage" });
    const failed = switchLimitMeta({ previousAgent: "claude", noteMode: "limit", limit: "failed" });
    expect(usage).toBeDefined();
    expect(failed).toBeDefined();
    expect(usage).not.toBe(failed);
  });
});
