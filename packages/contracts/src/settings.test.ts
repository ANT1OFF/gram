import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  customModelsOf,
  DEFAULT_SETTINGS,
  GRID_SHAPES,
  GridLayout,
  Palette,
  Settings,
  SettingsPatch,
  applySettingsPatch,
  continueAfterRestart,
  overviewHiddenOf,
  overviewSectionsValue,
  overviewSidebarOf,
  helperDailyBudgetUsd,
  helperHourlyCalls,
  helperOn,
  helperSource,
  helperLocalFallback,
  helperLocalContextAllowed,
  notifyAboutOf,
  openAtLaunchOf,
  orchestratorConnectors,
  orchestratorPeerMessaging,
  orchestrationMode,
  sendKeyOf,
  speechModelOf,
  speechPerformanceOf,
  voiceInputOn,
  restartOnMcpChangeOn,
  reviewRequestHolds,
  reviewRequestsAwaitBot,
  reviewRequestsAwaitChecks,
  reviewRequestsHideBots,
  reviewRequestsMaxAgeDays,
  worktreeSweepOf,
  usageHistoryEnabled,
} from "./settings.ts";
import { Diagnostics } from "./diagnostics.ts";
import { HelperStatus } from "./helper.ts";
import { reviewRequestReady } from "./review-requests.ts";
import { expectRoundTrip } from "./test-utils.ts";
import { connectorEntryProblem } from "./workspaces.ts";

const ones = (length: number) => Array.from({ length }, () => 1);

describe("local usage history preferences", () => {
  it("preserves existing history by default and revokes only the selected provider", () => {
    const fresh = Schema.decodeUnknownSync(Settings)(DEFAULT_SETTINGS);
    expect(fresh.usageHistory).toBeUndefined();
    expect(usageHistoryEnabled(fresh, "claude")).toBe(true);
    expect(usageHistoryEnabled(fresh, "codex")).toBe(true);
    const patch = Schema.decodeUnknownSync(SettingsPatch)({ usageHistory: { claude: false } });
    const disabled = applySettingsPatch(fresh, patch);
    expect(usageHistoryEnabled(disabled, "claude")).toBe(false);
    expect(usageHistoryEnabled(disabled, "codex")).toBe(true);
    const both = applySettingsPatch(disabled, { usageHistory: { codex: false } });
    expect(both.usageHistory).toEqual({ claude: false, codex: false });
    const enabled = applySettingsPatch(both, { usageHistory: { claude: true } });
    expect(enabled.usageHistory).toEqual({ claude: true, codex: false });
    expect(enabled.helpers).toEqual(fresh.helpers);
    expectRoundTrip(Settings, enabled);
  });
});

describe("Settings", () => {
  it("defaults round-trip", () => {
    expectRoundTrip(Settings, DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.appearance).toEqual({
      look: "glass",
      paletteId: "neutral-dark",
      mode: "dark",
      density: "comfortable",
      contrast: "standard",
      motion: "system",
    });
  });

  it("has seen no workspace guide until a patch says so, keeping the other onboarding fields", () => {
    expect(DEFAULT_SETTINGS.onboarding.workspaceGuideSeen).toBeUndefined();
    const seen = applySettingsPatch(
      DEFAULT_SETTINGS,
      Schema.decodeUnknownSync(SettingsPatch)({ onboarding: { workspaceGuideSeen: true } }),
    );
    expect(seen.onboarding).toEqual({ welcomeSeen: false, workspaceGuideSeen: true });
    expectRoundTrip(Settings, seen);
  });

  it("rejects an unknown look", () => {
    expect(() =>
      Schema.decodeUnknownSync(Settings)({
        ...DEFAULT_SETTINGS,
        appearance: { ...DEFAULT_SETTINGS.appearance, look: "neon" },
      }),
    ).toThrow();
  });
});

const withNotifications = (notifications: Record<string, unknown>) =>
  Schema.decodeUnknownSync(Settings)({
    ...DEFAULT_SETTINGS,
    notifications: { ...DEFAULT_SETTINGS.notifications, ...notifications },
  });

describe("review request filters", () => {
  it("hides bots unless the setting says otherwise", () => {
    expect(reviewRequestsHideBots(DEFAULT_SETTINGS)).toBe(true);
    expect(reviewRequestsHideBots(withNotifications({ reviewRequestsHideBots: true }))).toBe(true);
    expect(reviewRequestsHideBots(withNotifications({ reviewRequestsHideBots: false }))).toBe(
      false,
    );
  });

  it("has no age cutoff until one is stored, and only a positive whole number is one", () => {
    expect(reviewRequestsMaxAgeDays(DEFAULT_SETTINGS)).toBeUndefined();
    expect(reviewRequestsMaxAgeDays(withNotifications({ reviewRequestsMaxAgeDays: 30 }))).toBe(30);
    for (const days of [0, -7, 1.5]) {
      expect(() => withNotifications({ reviewRequestsMaxAgeDays: days })).toThrow();
    }
  });

  it("holds no notification until a hold is turned on, and says when a PR is ready", () => {
    expect(reviewRequestsAwaitChecks(DEFAULT_SETTINGS)).toBe(false);
    expect(reviewRequestsAwaitBot(DEFAULT_SETTINGS)).toBe(false);
    const patch = Schema.decodeUnknownSync(SettingsPatch)({
      notifications: { reviewRequestsAwaitChecks: true, reviewRequestsAwaitBot: true },
    });
    const held = applySettingsPatch(DEFAULT_SETTINGS, patch);
    expect(reviewRequestsAwaitChecks(held)).toBe(true);
    expect(reviewRequestsAwaitBot(held)).toBe(true);

    const none = { checks: false, bot: false };
    expect(reviewRequestReady({}, none)).toBe(true);
    expect(reviewRequestReady({ checks: "failing" }, none)).toBe(true);
    const checks = { checks: true, bot: false };
    expect(reviewRequestReady({}, checks)).toBe(false);
    expect(reviewRequestReady({ checks: "pending" }, checks)).toBe(false);
    expect(reviewRequestReady({ checks: "failing" }, checks)).toBe(false);
    expect(reviewRequestReady({ checks: "passing" }, checks)).toBe(true);
    expect(reviewRequestReady({ checks: "none" }, checks)).toBe(true);
    const bot = { checks: false, bot: true };
    expect(reviewRequestReady({ checks: "passing" }, bot)).toBe(false);
    expect(reviewRequestReady({ bot: { verdict: "approved", onHead: false } }, bot)).toBe(false);
    expect(reviewRequestReady({ bot: { verdict: "changesRequested", onHead: true } }, bot)).toBe(
      false,
    );
    expect(reviewRequestReady({ bot: { verdict: "approved", onHead: true } }, bot)).toBe(true);
    expect(reviewRequestReady({ bot: { verdict: "commented", onHead: true } }, bot)).toBe(true);
  });

  it("holds for the bot only in a repository listed as having one, in any case", () => {
    const awaiting = (reviewBotRepos?: ReadonlyArray<string>) =>
      withNotifications({
        reviewRequestsAwaitBot: true,
        ...(reviewBotRepos === undefined ? {} : { reviewBotRepos }),
      });
    expect(reviewRequestHolds(DEFAULT_SETTINGS, "example/api")).toEqual({
      checks: false,
      bot: false,
    });
    // Before the list is filled in, every repository holds, as the setting always did.
    expect(reviewRequestHolds(awaiting(), "example/api").bot).toBe(true);
    expect(reviewRequestHolds(awaiting(["EXAMPLE/api"]), "example/API").bot).toBe(true);
    expect(reviewRequestHolds(awaiting(["example/api"]), "example/web").bot).toBe(false);
    expect(reviewRequestHolds(awaiting([]), "example/api").bot).toBe(false);
    const listed = withNotifications({ reviewBotRepos: ["example/api"] });
    expect(reviewRequestHolds(listed, "example/api").bot).toBe(false);

    const patch = Schema.decodeUnknownSync(SettingsPatch)({
      notifications: { reviewBotRepos: ["example/web"] },
    });
    expectRoundTrip(SettingsPatch, patch);
    const next = applySettingsPatch(awaiting(["example/api"]), patch);
    expectRoundTrip(Settings, next);
    expect(next.notifications.reviewBotRepos).toEqual(["example/web"]);
  });

  it("patches both in, and clears the cutoff with null", () => {
    const set = Schema.decodeUnknownSync(SettingsPatch)({
      notifications: { reviewRequestsHideBots: false, reviewRequestsMaxAgeDays: 7 },
    });
    const applied = applySettingsPatch(DEFAULT_SETTINGS, set);
    expect(applied.notifications.reviewRequestsHideBots).toBe(false);
    expect(reviewRequestsMaxAgeDays(applied)).toBe(7);

    const cleared = Schema.decodeUnknownSync(SettingsPatch)({
      notifications: { reviewRequestsMaxAgeDays: null },
    });
    const after = applySettingsPatch(applied, cleared);
    expect(reviewRequestsMaxAgeDays(after)).toBeUndefined();
    expect(after.notifications.reviewRequestsHideBots).toBe(false);
  });
});

describe("SettingsPatch", () => {
  it("decodes a partial group and merges it field by field", () => {
    const patch = Schema.decodeUnknownSync(SettingsPatch)({
      updates: { channel: "prerelease" },
      appearance: { look: "glass" },
      logLevel: "debug",
    });
    expectRoundTrip(SettingsPatch, patch);
    const next = applySettingsPatch(DEFAULT_SETTINGS, patch);
    expect(next.updates.channel).toBe("prerelease");
    expect(next.appearance).toEqual({ ...DEFAULT_SETTINGS.appearance, look: "glass" });
    expect(next.logLevel).toBe("debug");
    expect(next.sidebar).toBe(DEFAULT_SETTINGS.sidebar);
    expectRoundTrip(Settings, next);
  });

  it("accepts an empty patch and rejects invalid field values", () => {
    expect(applySettingsPatch(DEFAULT_SETTINGS, {})).toEqual(DEFAULT_SETTINGS);
    expect(() =>
      Schema.decodeUnknownSync(SettingsPatch)({ appearance: { motion: "fast" } }),
    ).toThrow();
  });
});

const withMode = (defaultMode: Settings["agents"]["defaultMode"]): Settings => ({
  ...DEFAULT_SETTINGS,
  agents: { ...DEFAULT_SETTINGS.agents, defaultMode },
});

const withChoice = (value: boolean) =>
  applySettingsPatch(DEFAULT_SETTINGS, { workspaces: { continueAfterRestart: value } });

describe("workspaces.continueAfterRestart", () => {
  it("is off until turned on, and a patch turns it on and off again", () => {
    expect("workspaces" in DEFAULT_SETTINGS).toBe(false);
    expect(continueAfterRestart(DEFAULT_SETTINGS)).toBe(false);
    const on = applySettingsPatch(
      DEFAULT_SETTINGS,
      Schema.decodeUnknownSync(SettingsPatch)({ workspaces: { continueAfterRestart: true } }),
    );
    expect(continueAfterRestart(on)).toBe(true);
    expectRoundTrip(Settings, on);
    const off = applySettingsPatch(on, { workspaces: { continueAfterRestart: false } });
    expect(continueAfterRestart(off)).toBe(false);
  });

  it("defaults off and preserves explicit choices through stored settings decoding", () => {
    expect(continueAfterRestart(DEFAULT_SETTINGS)).toBe(false);
    expect(continueAfterRestart(withChoice(false))).toBe(false);
    expect(continueAfterRestart(withChoice(true))).toBe(true);
    const saved = Schema.decodeUnknownSync(Settings)(withChoice(true));
    expect(continueAfterRestart(saved)).toBe(true);
    expect(
      continueAfterRestart(
        applySettingsPatch(saved, {
          workspaces: { continueAfterRestart: false },
        }),
      ),
    ).toBe(false);
  });
});

describe("workspaces.worktreeSweep", () => {
  it("is on until turned off, and runs on 3 and 14 days unless told otherwise", () => {
    expect(worktreeSweepOf(DEFAULT_SETTINGS)).toEqual({ freeAfterDays: 3, removeAfterDays: 14 });
    const on = applySettingsPatch(
      DEFAULT_SETTINGS,
      Schema.decodeUnknownSync(SettingsPatch)({ workspaces: { worktreeSweep: true } }),
    );
    expect(worktreeSweepOf(on)).toEqual({ freeAfterDays: 3, removeAfterDays: 14 });
    const tuned = applySettingsPatch(on, {
      workspaces: { worktreeSweepFreeDays: 1, worktreeSweepRemoveDays: 30 },
    });
    expectRoundTrip(Settings, tuned);
    expect(worktreeSweepOf(tuned)).toEqual({ freeAfterDays: 1, removeAfterDays: 30 });
    // Decoding stored settings retains the choice and day counts without adding defaults.
    expect(Schema.decodeUnknownSync(Settings)(DEFAULT_SETTINGS).workspaces).toBeUndefined();
    expect(worktreeSweepOf(Schema.decodeUnknownSync(Settings)(DEFAULT_SETTINGS))).toEqual({
      freeAfterDays: 3,
      removeAfterDays: 14,
    });
    expect(worktreeSweepOf(Schema.decodeUnknownSync(Settings)(tuned))).toEqual({
      freeAfterDays: 1,
      removeAfterDays: 30,
    });
    // An explicit off stays off.
    const off = applySettingsPatch(tuned, { workspaces: { worktreeSweep: false } });
    expect(worktreeSweepOf(off)).toBeUndefined();
    expect(worktreeSweepOf(Schema.decodeUnknownSync(Settings)(off))).toBeUndefined();
    expect(() =>
      Schema.decodeUnknownSync(SettingsPatch)({ workspaces: { worktreeSweepFreeDays: 0 } }),
    ).toThrow();
  });
});

describe("workspaces.orchestratorPeerMessaging", () => {
  it("is off until turned on", () => {
    expect(orchestratorPeerMessaging(DEFAULT_SETTINGS)).toBe(false);
    const on = applySettingsPatch(
      DEFAULT_SETTINGS,
      Schema.decodeUnknownSync(SettingsPatch)({ workspaces: { orchestratorPeerMessaging: true } }),
    );
    expect(orchestratorPeerMessaging(on)).toBe(true);
    expectRoundTrip(Settings, on);
  });
});

describe("workspaces.orchestratorConnectors", () => {
  it("is none until listed, trims its entries, and keeps continueAfterRestart when patched", () => {
    expect(orchestratorConnectors(DEFAULT_SETTINGS)).toEqual([]);
    const on = applySettingsPatch(
      applySettingsPatch(DEFAULT_SETTINGS, { workspaces: { continueAfterRestart: true } }),
      Schema.decodeUnknownSync(SettingsPatch)({
        workspaces: { orchestratorConnectors: [" parse ", "https://mcp.example.invalid/teams"] },
      }),
    );
    expect(orchestratorConnectors(on)).toEqual(["parse", "https://mcp.example.invalid/teams"]);
    expect(continueAfterRestart(on)).toBe(true);
    expectRoundTrip(Settings, on);
  });

  it("refuses an address that carries more than the server's location", () => {
    for (const ok of [
      "parse",
      "claude.ai Teams",
      "https://mcp.example.invalid/teams",
      "https://*.organization.example.invalid/*",
    ]) {
      expect(connectorEntryProblem(ok), ok).toBeUndefined();
    }
    for (const bad of [
      "https://user:secret@organization.example.invalid/x",
      "https://organization.example.invalid/x?token=abc",
      "https://organization.example.invalid/x#k",
      " ",
    ]) {
      expect(connectorEntryProblem(bad), bad).toBeDefined();
      expect(() =>
        Schema.decodeUnknownSync(SettingsPatch)({ workspaces: { orchestratorConnectors: [bad] } }),
      ).toThrow();
    }
  });
});

describe("voice input", () => {
  it("is off unless turned on, and runs the Balanced stop's model until the slider moves", () => {
    expect(voiceInputOn(DEFAULT_SETTINGS)).toBe(false);
    expect(speechPerformanceOf(DEFAULT_SETTINGS)).toBe("balanced");
    expect(speechModelOf(DEFAULT_SETTINGS)).toBe("nemotron-speech-en-0.6b-560ms-int8");
    const patch = Schema.decodeUnknownSync(SettingsPatch)({
      experimental: { voiceInput: true },
      voice: { performance: "efficient" },
    });
    expectRoundTrip(SettingsPatch, patch);
    const on = applySettingsPatch(DEFAULT_SETTINGS, patch);
    expectRoundTrip(Settings, on);
    expect(voiceInputOn(on)).toBe(true);
    expect(speechModelOf(on)).toBe("nemotron-speech-en-0.6b-1120ms-int8");
    const cleared = applySettingsPatch(on, { voice: { performance: null } });
    expect(speechModelOf(cleared)).toBe("nemotron-speech-en-0.6b-560ms-int8");
    expect(() =>
      Schema.decodeUnknownSync(SettingsPatch)({ voice: { performance: "quality" } }),
    ).toThrow();
  });
});

describe("orchestration mode", () => {
  it("runs unattended threads in auto unless the user bypasses permissions everywhere", () => {
    expect(orchestrationMode(withMode("default"))).toBe("auto");
    expect(orchestrationMode(withMode("acceptEdits"))).toBe("auto");
    expect(orchestrationMode(withMode("auto"))).toBe("auto");
    expect(orchestrationMode(withMode("bypassPermissions"))).toBe("bypassPermissions");
  });
});

describe("SettingsPatch clearing", () => {
  const decodePatch = Schema.decodeUnknownSync(SettingsPatch);
  const configured = applySettingsPatch(
    DEFAULT_SETTINGS,
    decodePatch({
      layout: { focusMode: true },
      fonts: { mono: "Geist Mono", monoSize: 13 },
      updates: { pinnedVersion: "1.8.0" },
    }),
  );

  it("round-trips null leaves", () => {
    expectRoundTrip(
      SettingsPatch,
      decodePatch({
        layout: { focusMode: null },
        fonts: { mono: null },
        agents: { idleEvictMinutes: 30 },
      }),
    );
  });

  it("sets, clears and leaves unchanged", () => {
    expect(configured.layout?.focusMode).toBe(true);
    expect(configured.fonts).toEqual({ mono: "Geist Mono", monoSize: 13 });

    const cleared = applySettingsPatch(
      configured,
      decodePatch({ layout: { focusMode: null }, fonts: { mono: null } }),
    );
    expect(cleared.layout).toEqual({});
    expect(cleared.fonts).toEqual({ monoSize: 13 });
    expect(cleared.updates).toEqual({ channel: "stable", pinnedVersion: "1.8.0" });
    expectRoundTrip(Settings, cleared);

    expect(applySettingsPatch(configured, decodePatch({ fonts: {}, layout: {} }))).toEqual(
      configured,
    );
    expect(applySettingsPatch(configured, {})).toEqual(configured);
  });

  it("rejects null for required fields and whole groups", () => {
    expect(() => decodePatch({ appearance: { look: null } })).toThrow();
    expect(() => decodePatch({ updates: { channel: null } })).toThrow();
    expect(() => decodePatch({ layout: null })).toThrow();
  });
});

describe("layout.grid", () => {
  const decodeGrid = Schema.decodeUnknownSync(GridLayout);

  it("round-trips every preset with matching panes and fractions", () => {
    for (const [preset, { cols, rows }] of Object.entries(GRID_SHAPES)) {
      const panes = Array.from({ length: cols * rows }, (_, i) => (i === 0 ? "t1" : null));
      const grid = decodeGrid({
        preset,
        panes,
        colFr: ones(cols),
        rowFr: ones(rows),
        focused: cols * rows - 1,
      });
      expectRoundTrip(GridLayout, grid);
    }
  });

  it("rejects mismatched counts, non-positive fractions and an out-of-range focus", () => {
    const base = { preset: "2x2", panes: ["t1", "t2", null, null] };
    expect(() => decodeGrid(base)).not.toThrow();
    for (const bad of [
      { ...base, panes: ["t1", "t2", null] },
      { ...base, preset: "3c2r" },
      { ...base, colFr: [1, 1, 1] },
      { ...base, rowFr: [1] },
      { ...base, colFr: [1, 0] },
      { ...base, rowFr: [2, -1] },
      { ...base, focused: 4 },
      { ...base, preset: "4x4" },
    ])
      expect(() => decodeGrid(bad), JSON.stringify(bad)).toThrow();
  });

  it("patches in and clears with null, leaving the rest of the layout alone", () => {
    const decodePatch = Schema.decodeUnknownSync(SettingsPatch);
    const grid = { preset: "2c", panes: ["t1", "t2"], colFr: [2, 1], focused: 1 };
    const focused = applySettingsPatch(
      DEFAULT_SETTINGS,
      decodePatch({ layout: { focusMode: true } }),
    );
    const withGrid = applySettingsPatch(focused, decodePatch({ layout: { grid } }));
    expect(withGrid.layout).toEqual({ focusMode: true, grid });
    expectRoundTrip(Settings, withGrid);

    const cleared = applySettingsPatch(withGrid, decodePatch({ layout: { grid: null } }));
    expect(cleared.layout).toEqual({ focusMode: true });
    expect(() => decodePatch({ layout: { grid: { preset: "2c", panes: ["t1"] } } })).toThrow();
  });
});

describe("panel and focus mode", () => {
  const decodeSettings = Schema.decodeUnknownSync(Settings);
  const decodePatch = Schema.decodeUnknownSync(SettingsPatch);

  it("defaults the panel and leaves the layout unset", () => {
    expect(DEFAULT_SETTINGS.panel).toEqual({ side: "right", open: true, width: 352, tab: "diff" });
    expectRoundTrip(Settings, DEFAULT_SETTINGS);
    const decoded = decodeSettings(Schema.encodeSync(Settings)(DEFAULT_SETTINGS));
    expect(decoded.layout).toBeUndefined();
  });

  it("sets and clears Quiet when idle beside the other layout fields", () => {
    const on = applySettingsPatch(
      DEFAULT_SETTINGS,
      decodePatch({ layout: { focusMode: true, quietWhenIdle: true } }),
    );
    expect(on.layout).toEqual({ focusMode: true, quietWhenIdle: true });
    expectRoundTrip(Settings, on);
    const off = applySettingsPatch(on, decodePatch({ layout: { quietWhenIdle: null } }));
    expect(off.layout).toEqual({ focusMode: true });
  });

  it("reads the overview sidebar as automatic until it is set", () => {
    expect(overviewSidebarOf(DEFAULT_SETTINGS)).toBeUndefined();
    for (const mode of ["open", "compact", "hidden"] as const) {
      const set = applySettingsPatch(
        DEFAULT_SETTINGS,
        decodePatch({ layout: { overviewSidebar: mode } }),
      );
      expect(overviewSidebarOf(set)).toBe(mode);
      expectRoundTrip(Settings, set);
    }
    expect(() => decodePatch({ layout: { overviewSidebar: "wide" } })).toThrow();

    // Clearing it goes back to automatic.
    const picked = applySettingsPatch(
      DEFAULT_SETTINGS,
      decodePatch({ layout: { overviewSidebar: "open" } }),
    );
    const cleared = applySettingsPatch(picked, decodePatch({ layout: { overviewSidebar: null } }));
    expect(overviewSidebarOf(cleared)).toBeUndefined();
    expect(cleared.layout).toEqual({});
  });

  it("shows the overview's sections but usage by default, storing only what differs", () => {
    expect(overviewHiddenOf(DEFAULT_SETTINGS)).toEqual(["usage"]);
    expect(overviewSectionsValue(["usage"])).toBeNull();
    expect(overviewSectionsValue(["usage", "solo"])).toEqual({ solo: false });
    expect(overviewSectionsValue([])).toEqual({ usage: true });

    const off = applySettingsPatch(
      DEFAULT_SETTINGS,
      decodePatch({ layout: { overviewSections: overviewSectionsValue(["doneToday", "solo"]) } }),
    );
    expect(off.layout?.overviewSections).toEqual({
      solo: false,
      doneToday: false,
      usage: true,
    });
    // In the order they sit in the column, whatever order they were turned off in.
    expect(overviewHiddenOf(off)).toEqual(["solo", "doneToday"]);
    expectRoundTrip(Settings, off);

    // A section stored as shown reads as shown; a patch replaces the whole set.
    const shown = applySettingsPatch(
      DEFAULT_SETTINGS,
      decodePatch({ layout: { overviewSections: { pullRequests: true } } }),
    );
    expect(overviewHiddenOf(shown)).toEqual(["usage"]);
    const replaced = applySettingsPatch(
      off,
      decodePatch({ layout: { overviewSections: { usage: false } } }),
    );
    expect(overviewHiddenOf(replaced)).toEqual(["usage"]);
    expect(() => decodePatch({ layout: { overviewSections: { solo: "no" } } })).toThrow();

    const cleared = applySettingsPatch(off, decodePatch({ layout: { overviewSections: null } }));
    expect(overviewHiddenOf(cleared)).toEqual(["usage"]);
    expect(cleared.layout).toEqual({});
  });

  it("sets and clears what a launch opens, read as the last orchestrator while unset", () => {
    expect(openAtLaunchOf(DEFAULT_SETTINGS)).toBe("orchestrator");
    const thread = applySettingsPatch(
      DEFAULT_SETTINGS,
      decodePatch({ layout: { focusMode: true, openAtLaunch: "thread" } }),
    );
    expect(openAtLaunchOf(thread)).toBe("thread");
    expectRoundTrip(Settings, thread);
    const cleared = applySettingsPatch(thread, decodePatch({ layout: { openAtLaunch: null } }));
    expect(cleared.layout).toEqual({ focusMode: true });
    expect(() => decodePatch({ layout: { openAtLaunch: "board" } })).toThrow();
  });

  it("sets and clears what notifies, read as asks and failures while unset", () => {
    expect(notifyAboutOf(DEFAULT_SETTINGS)).toBe("asksAndFailures");
    const asks = applySettingsPatch(
      DEFAULT_SETTINGS,
      decodePatch({ notifications: { notifyAbout: "asks" } }),
    );
    expect(notifyAboutOf(asks)).toBe("asks");
    expectRoundTrip(Settings, asks);
    const cleared = applySettingsPatch(asks, decodePatch({ notifications: { notifyAbout: null } }));
    expect(cleared.notifications).toEqual(DEFAULT_SETTINGS.notifications);
    expect(() => decodePatch({ notifications: { notifyAbout: "everything" } })).toThrow();
  });

  it("patches panel fields, and sets and clears focus mode", () => {
    const next = applySettingsPatch(
      DEFAULT_SETTINGS,
      decodePatch({ panel: { open: false, width: 480, tab: "pr" }, layout: { focusMode: true } }),
    );
    expect(next.panel).toEqual({ side: "right", open: false, width: 480, tab: "pr" });
    expect(next.layout?.focusMode).toBe(true);
    expectRoundTrip(Settings, next);

    const cleared = applySettingsPatch(next, decodePatch({ layout: { focusMode: null } }));
    expect(cleared.layout).toEqual({});
    expect(cleared.panel).toEqual(next.panel);

    expect(decodePatch({ panel: { tab: "notifications" } })).toEqual({
      panel: { tab: "notifications" },
    });
    expect(() => decodePatch({ panel: { tab: "browser" } })).toThrow();
    expect(() => decodePatch({ panel: { open: null } })).toThrow();
  });
});

describe("agents.defaultFolder", () => {
  const decodePatch = Schema.decodeUnknownSync(SettingsPatch);

  it("is optional, patches in with ~, and clears with null", () => {
    expect(DEFAULT_SETTINGS.agents.defaultFolder).toBeUndefined();
    const stored = Schema.encodeSync(Settings)(DEFAULT_SETTINGS);
    expect(Schema.decodeUnknownSync(Settings)(stored)).toEqual(DEFAULT_SETTINGS);

    const next = applySettingsPatch(
      DEFAULT_SETTINGS,
      decodePatch({ agents: { defaultFolder: "~/Documents/code" } }),
    );
    expect(next.agents).toEqual({ ...DEFAULT_SETTINGS.agents, defaultFolder: "~/Documents/code" });
    expectRoundTrip(Settings, next);

    const cleared = applySettingsPatch(next, decodePatch({ agents: { defaultFolder: null } }));
    expect(cleared.agents).toEqual(DEFAULT_SETTINGS.agents);
  });
});

describe("agents.restartOnMcpChange", () => {
  it("is on while absent, patches off and back, and round-trips", () => {
    expect(DEFAULT_SETTINGS.agents.restartOnMcpChange).toBeUndefined();
    expect(restartOnMcpChangeOn(DEFAULT_SETTINGS)).toBe(true);
    const decodePatch = Schema.decodeUnknownSync(SettingsPatch);
    const patch = decodePatch({ agents: { restartOnMcpChange: false } });
    expectRoundTrip(SettingsPatch, patch);
    const off = applySettingsPatch(DEFAULT_SETTINGS, patch);
    expectRoundTrip(Settings, off);
    expect(restartOnMcpChangeOn(off)).toBe(false);
    expect(off.agents.idleEvictMinutes).toBe(DEFAULT_SETTINGS.agents.idleEvictMinutes);
    const on = applySettingsPatch(off, decodePatch({ agents: { restartOnMcpChange: true } }));
    expect(restartOnMcpChangeOn(on)).toBe(true);
    expect(() => decodePatch({ agents: { restartOnMcpChange: "yes" } })).toThrow();
  });
});

describe("agents.workerModels", () => {
  it("is absent by default, patches in as a whole roster, and clears with null", () => {
    expect(DEFAULT_SETTINGS.agents.workerModels).toBeUndefined();
    const decodePatch = Schema.decodeUnknownSync(SettingsPatch);
    const roster = [
      { agent: "claude", model: "opus", useFor: "orchestration, implementation", default: true },
      { agent: "codex", model: "gpt-6.1-sol", profileId: "gw", useFor: "reviews, audits" },
    ];
    const patch = decodePatch({ agents: { workerModels: roster } });
    expectRoundTrip(SettingsPatch, patch);
    const next = applySettingsPatch(DEFAULT_SETTINGS, patch);
    expectRoundTrip(Settings, next);
    expect(next.agents.workerModels).toEqual(roster);
    const cleared = applySettingsPatch(next, decodePatch({ agents: { workerModels: null } }));
    expect(cleared.agents).toEqual(DEFAULT_SETTINGS.agents);
  });
});

describe("Palette", () => {
  it("round-trips a seeded preset with its light pairing", () => {
    const tokyoNight = Schema.decodeUnknownSync(Palette)({
      id: "tokyo-night",
      name: "Tokyo Night",
      mode: "dark",
      pairId: "tokyo-light",
      seeds: {
        bg: "#1a1b26",
        surface: "#16161e",
        text: "#c0caf5",
        muted: "#565f89",
        accent: "#7aa2f7",
        accent2: "#bb9af7",
        red: "#f7768e",
        green: "#9ece6a",
        yellow: "#e0af68",
        cyan: "#7dcfff",
      },
    });
    expectRoundTrip(Palette, tokyoNight);
    expect(() =>
      Schema.decodeUnknownSync(Palette)({
        ...tokyoNight,
        seeds: { ...tokyoNight.seeds, bg: "navy" },
      }),
    ).toThrow();
  });
});

describe("agents.customModels", () => {
  it("is absent by default, patches in as a whole list, and reads back per agent", () => {
    expect(customModelsOf(DEFAULT_SETTINGS, "claude")).toEqual([]);
    const patch = Schema.decodeUnknownSync(SettingsPatch)({
      agents: {
        customModels: [
          { agent: "claude", id: "opus[1m]", name: "Opus, 1M context" },
          { agent: "codex", id: "gpt-preview", effort: false },
        ],
      },
    });
    expectRoundTrip(SettingsPatch, patch);
    const next = applySettingsPatch(DEFAULT_SETTINGS, patch);
    expectRoundTrip(Settings, next);
    expect(next.agents.defaultMode).toBe(DEFAULT_SETTINGS.agents.defaultMode);
    expect(customModelsOf(next, "claude").map((m) => m.id)).toEqual(["opus[1m]"]);
    expect(customModelsOf(next, "codex").map((m) => m.id)).toEqual(["gpt-preview"]);

    const emptied = applySettingsPatch(next, { agents: { customModels: [] } });
    expect(customModelsOf(emptied, "claude")).toEqual([]);
  });

  it("rejects an empty id and an unknown agent", () => {
    for (const model of [
      { agent: "claude", id: "" },
      { agent: "unknown-agent", id: "flash" },
    ])
      expect(() =>
        Schema.decodeUnknownSync(SettingsPatch)({ agents: { customModels: [model] } }),
      ).toThrow();
  });
});

describe("composer.sendKey", () => {
  it("defaults to Enter, patches in, and rejects anything else", () => {
    expect(DEFAULT_SETTINGS.composer).toBeUndefined();
    expect(sendKeyOf(DEFAULT_SETTINGS)).toBe("enter");
    const patch = Schema.decodeUnknownSync(SettingsPatch)({ composer: { sendKey: "modEnter" } });
    const next = applySettingsPatch(DEFAULT_SETTINGS, patch);
    expectRoundTrip(Settings, next);
    expect(sendKeyOf(next)).toBe("modEnter");
    expect(() =>
      Schema.decodeUnknownSync(SettingsPatch)({ composer: { sendKey: "shiftEnter" } }),
    ).toThrow();
  });
});

describe("helpers", () => {
  it("defaults fresh and unset settings to local automatic without new consent", () => {
    for (const helpers of [undefined, { enabled: true }, { dailyBudgetUsd: 0.5 }]) {
      const settings = { ...DEFAULT_SETTINGS, ...(helpers === undefined ? {} : { helpers }) };
      expect(helperSource(settings)).toBe("automatic");
      expect(helperLocalFallback(settings)).toBe("automatic");
      expect(helperLocalContextAllowed(settings, "claude", "title")).toBe(false);
      expect(helperLocalContextAllowed(settings, "codex", "recap")).toBe(false);
    }
  });

  it("preserves explicit destination/model choices and keeps consent provider-scoped", () => {
    const patch = Schema.decodeUnknownSync(SettingsPatch)({
      helpers: {
        source: "claude",
        claudeModel: "synthetic-haiku",
        codexModel: "synthetic-luna",
        claudeContext: "opening",
        codexContext: "conversation",
      },
    });
    expectRoundTrip(SettingsPatch, patch);
    const next = applySettingsPatch(DEFAULT_SETTINGS, patch);
    expectRoundTrip(Settings, next);
    expect(helperSource(next)).toBe("claude");
    expect(helperLocalFallback(next)).toBe("none");
    expect(helperLocalContextAllowed(next, "claude", "title")).toBe(true);
    expect(helperLocalContextAllowed(next, "claude", "plan")).toBe(false);
    expect(helperLocalContextAllowed(next, "codex", "plan")).toBe(true);
    const changed = applySettingsPatch(next, {
      helpers: { source: "codex", localFallback: "automatic", codexContext: "off" },
    });
    expect(changed.helpers?.claudeModel).toBe("synthetic-haiku");
    expect(helperLocalFallback(changed)).toBe("automatic");
    expect(helperLocalContextAllowed(changed, "codex", "title")).toBe(false);
    const gateway = applySettingsPatch(changed, { helpers: { source: "gateway" } });
    expect(helperSource(gateway)).toBe("gateway");
    expect(helperLocalFallback(gateway)).toBe("automatic");
    const reset = applySettingsPatch(gateway, {
      helpers: { source: null, claudeContext: null, localFallback: null },
    });
    expect(helperSource(reset)).toBe("automatic");
    expect(helperLocalContextAllowed(reset, "claude", "title")).toBe(false);
  });

  it("is on unless turned off, feature by feature or all at once", () => {
    expect(helperOn(DEFAULT_SETTINGS, "suggest")).toBe(true);
    expect(helperDailyBudgetUsd(DEFAULT_SETTINGS)).toBe(2);
    expect(helperHourlyCalls(DEFAULT_SETTINGS)).toBe(400);
    const patch = Schema.decodeUnknownSync(SettingsPatch)({
      helpers: { plan: false, dailyBudgetUsd: 0.5 },
    });
    expectRoundTrip(SettingsPatch, patch);
    const next = applySettingsPatch(DEFAULT_SETTINGS, patch);
    expectRoundTrip(Settings, next);
    expect(helperOn(next, "plan")).toBe(false);
    expect(helperOn(next, "recap")).toBe(true);
    expect(helperDailyBudgetUsd(next)).toBe(0.5);
    const off = applySettingsPatch(next, {
      helpers: { enabled: false, plan: null, dailyBudgetUsd: null },
    });
    expect(helperOn({ ...off, helpers: { plan: true } }, "plan")).toBe(true);
    expect(helperOn(off, "title")).toBe(false);
    expect(helperDailyBudgetUsd(off)).toBe(2);
    expect(helperOn(DEFAULT_SETTINGS, "wait")).toBe(true);
    const noWait = Schema.decodeUnknownSync(SettingsPatch)({ helpers: { wait: false } });
    expectRoundTrip(SettingsPatch, noWait);
    const quiet = applySettingsPatch(DEFAULT_SETTINGS, noWait);
    expectRoundTrip(Settings, quiet);
    expect(helperOn(quiet, "wait")).toBe(false);
    expect(helperOn(applySettingsPatch(quiet, { helpers: { wait: null } }), "wait")).toBe(true);
    expect(() =>
      Schema.decodeUnknownSync(SettingsPatch)({ helpers: { dailyBudgetUsd: 0 } }),
    ).toThrow();
  });

  it("round-trips today's usage", () => {
    expectRoundTrip(HelperStatus, {
      day: "2026-10-01",
      calls: 3,
      inputTokens: 12_000,
      outputTokens: 2_100,
      costUsd: 0.00225,
      failures: 1,
      lines: [
        {
          kind: "plan",
          model: "gpt-6-luna",
          calls: 3,
          inputTokens: 12_000,
          outputTokens: 2_100,
          costUsd: 0.00225,
          failures: 1,
        },
      ],
      dailyBudgetUsd: 2,
      paused: { reason: "keyDisabled", until: 1_790_000_000_000 },
    });
  });
});

describe("Diagnostics", () => {
  const diagnostics: Diagnostics = {
    version: "0.4.0",
    platform: "linux",
    arch: "arm64",
    versions: { node: "24.0.0" },
    dataDir: "/home/user/.local/share/gram-state",
    threads: { total: 2, live: 1 },
  };

  it("round-trips", () => {
    expectRoundTrip(Diagnostics, diagnostics);
  });
});
