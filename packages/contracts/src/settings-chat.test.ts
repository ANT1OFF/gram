import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./settings.ts";
import {
  applyCharterWrites,
  applySettingsWrites,
  planSettingsChanges,
  settingsHold,
  readSettingsRows,
  readUserOnlyRows,
  SETTINGS_CATALOGUE,
  USER_ONLY_SETTINGS,
  userOnlySetting,
  type SettingsChange,
  type SettingsWorld,
} from "./settings-chat.ts";
import { DEFAULT_CHARTER, type WorkspaceState } from "./workspaces.ts";

const workspace: WorkspaceState = {
  workspace: {
    id: "ws-1" as never,
    name: "Shop",
    projectIds: ["p-1" as never],
    homeProjectId: "p-1" as never,
    createdAt: 1,
  },
  charter: {
    ...DEFAULT_CHARTER,
    autonomy: "publish",
    workerModels: [
      { agent: "claude", model: "opus", variant: "high", default: true, useFor: "the work" },
      { agent: "codex", model: "gpt-6.1-sol", profileId: "p1" as never, useFor: "reviews" },
    ],
  },
};

const world: SettingsWorld = {
  settings: {
    ...DEFAULT_SETTINGS,
    editor: { command: "/private/bin/editor --wait" },
    agents: { ...DEFAULT_SETTINGS.agents, defaultFolder: "/private/folder" },
  },
  workspace,
};

const plan = (changes: ReadonlyArray<SettingsChange>, against: SettingsWorld = world) =>
  planSettingsChanges(against, changes);

/** What a plan stores, applied to the world it was planned against. */
const charterAfter = (result: ReturnType<typeof plan>, against: SettingsWorld = world) =>
  result.ok ? applyCharterWrites(against.workspace!.charter, result.plan.writes) : undefined;
const settingsAfter = (result: ReturnType<typeof plan>) =>
  result.ok ? applySettingsWrites(world.settings, result.plan.writes) : undefined;

const errorsOf = (changes: ReadonlyArray<SettingsChange>, against?: SettingsWorld) => {
  const result = plan(changes, against);
  if (result.ok) throw new Error("expected the plan to be refused");
  return result.errors.join(" ");
};

describe("settings by chat: tiers", () => {
  it("refuses every user-only key, and whatever lies under it, whatever the spelling", () => {
    for (const { key, via } of USER_ONLY_SETTINGS) {
      for (const spelled of [key, key.toUpperCase(), `${key}.anything`]) {
        expect(errorsOf([{ op: "set", key: spelled, value: true }])).toContain(
          // A workspace's repos, autonomy and worker mode change only on workspace_update's card.
          via === undefined ? "no agent may change it" : `propose it with ${via}`,
        );
      }
    }
    expect(
      USER_ONLY_SETTINGS.filter((each) => each.via !== undefined).map((each) => each.key),
    ).toEqual([
      "workspace.autonomy",
      "workspace.workerMode",
      "workspace.projectIds",
      "workspace.homeProjectId",
    ]);
    expect(userOnlySetting("profiles.p1.key")?.key).toBe("profiles");
  });

  it("names the authority keys the brief requires as user-only", () => {
    for (const key of [
      "workspace.autonomy",
      "workspace.workerMode",
      "agents.defaultMode",
      "workspace.connectors",
      "workspaces.orchestratorPeerMessaging",
      "workspace.projectIds",
      "agents.defaultFolder",
      "helpers.claudeContext",
      "helpers.codexContext",
      "profiles",
      "gateways",
    ]) {
      expect(userOnlySetting(key), key).toBeDefined();
    }
  });

  it("keeps the catalogue and the user-only list apart", () => {
    for (const entry of SETTINGS_CATALOGUE)
      expect(userOnlySetting(entry.key), entry.key).toBe(undefined);
  });

  it("refuses a key that isn't in the catalogue", () => {
    expect(
      errorsOf([{ op: "set", key: "workspace.repoMergeReviewPolicies", value: {} }]),
    ).toContain("isn't settable by chat");
  });
});

describe("settings by chat: reading", () => {
  it("reads only catalogue keys and harmless user-only values", () => {
    const text = JSON.stringify({
      app: readSettingsRows(world, "app"),
      workspace: readSettingsRows(world, "workspace"),
      userOnly: readUserOnlyRows(world),
    });
    expect(text).not.toContain("/private/bin/editor");
    expect(text).not.toContain("/private/folder");
    const userOnly = readUserOnlyRows(world);
    expect(userOnly.find((row) => row.key === "workspace.autonomy")).toMatchObject({
      value: "publish",
    });
    expect(userOnly.find((row) => row.key === "editor.command")).not.toHaveProperty("value");
    expect(readSettingsRows(world, "workspace")).toContainEqual(
      expect.objectContaining({ key: "workspace.maxConcurrentWorkers", value: 10 }),
    );
  });
});

describe("settings by chat: planning", () => {
  it("plans a workspace change as a whole charter, with a row per changed setting", () => {
    const result = plan([
      { op: "set", key: "workspace.maxConcurrentWorkers", value: 4 },
      {
        op: "add",
        key: "workspace.workerModels",
        item: { agent: "claude", model: "haiku", useFor: "docs", default: true },
      },
      {
        op: "update",
        key: "workspace.workerModels",
        match: "codex:gpt-6.1-sol",
        item: { useFor: "audits" },
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.scope).toBe("workspace");
    // Only the fields named are written.
    expect(result.plan.writes.map((write) => write.key)).toEqual([
      "workspace.maxConcurrentWorkers",
      "workspace.workerModels",
    ]);
    expect(charterAfter(result)?.maxConcurrentWorkers).toBe(4);
    const roster = charterAfter(result)?.workerModels ?? [];
    expect(roster.map((model) => `${model.agent}:${model.model}`)).toEqual([
      "claude:opus",
      "codex:gpt-6.1-sol",
      "claude:haiku",
    ]);
    // One default: the new one took the mark.
    expect(roster.filter((model) => model.default === true)).toHaveLength(1);
    expect(roster[2]?.default).toBe(true);
    // The profile the user chose stays on the entry an update touched.
    expect(roster[1]?.profileId).toBe("p1");
    expect(result.plan.rows).toEqual([
      {
        key: "workspace.maxConcurrentWorkers",
        label: "Max concurrent workers",
        before: "10",
        after: "4",
      },
      {
        key: "workspace.workerModels",
        label: "Worker model claude:opus",
        before: "claude:opus · high · default — the work",
        after: "claude:opus · high — the work",
      },
      {
        key: "workspace.workerModels",
        label: "Worker model codex:gpt-6.1-sol@p1",
        before: "codex:gpt-6.1-sol · profile p1 — reviews",
        after: "codex:gpt-6.1-sol · profile p1 — audits",
      },
      {
        key: "workspace.workerModels",
        label: "Worker model claude:haiku",
        before: null,
        after: "claude:haiku · default — docs",
      },
      {
        key: "workspace.workerModels",
        label: "Worker model used when none is named",
        before: "claude:opus",
        after: "claude:haiku",
      },
    ]);
    expect(result.plan.models).toEqual([
      { agent: "claude", model: "haiku", useFor: "docs", default: true },
    ]);
  });

  it("removes a worker model, and the roster clears rather than empties", () => {
    const one: SettingsWorld = {
      ...world,
      workspace: {
        ...workspace,
        charter: { ...workspace.charter, workerModels: [{ agent: "claude", model: "opus" }] },
      },
    };
    const result = plan(
      [{ op: "remove", key: "workspace.workerModels", match: "claude:opus" }],
      one,
    );
    expect(charterAfter(result, one)).not.toHaveProperty("workerModels");
    expect(result.ok && result.plan.rows).toEqual([
      {
        key: "workspace.workerModels",
        label: "Worker model claude:opus",
        before: "claude:opus",
        after: null,
      },
      {
        key: "workspace.workerModels",
        label: "Worker model used when none is named",
        before: "claude:opus",
        after: "the orchestrator's own model",
      },
    ]);
  });

  it("plans an app change as writes to the fields named", () => {
    const result = plan([
      { op: "set", key: "appearance.mode", value: "light" },
      { op: "set", key: "appearance.motion", value: "reduced" },
    ]);
    expect(result.ok && result.plan.writes).toEqual([
      { key: "appearance.mode", path: ["appearance", "mode"], before: "dark", after: "light" },
      {
        key: "appearance.motion",
        path: ["appearance", "motion"],
        before: "system",
        after: "reduced",
      },
    ]);
    expect(settingsAfter(result)?.appearance).toMatchObject({ mode: "light", motion: "reduced" });
    expect(result.ok && result.plan.rows.map((row) => `${row.before}→${row.after}`)).toEqual([
      "dark→light",
      "system→reduced",
    ]);
  });

  it("starts the app roster empty when none is saved, as new workspaces get it", () => {
    expect(
      errorsOf([{ op: "remove", key: "agents.workerModels", match: "claude:haiku" }]),
    ).toContain("has no claude:haiku");
    const result = plan([
      { op: "add", key: "agents.workerModels", item: { agent: "codex", model: "gpt-5.5" } },
    ]);
    expect(settingsAfter(result)?.agents.workerModels?.map((model) => model.model)).toEqual([
      "gpt-5.5",
    ]);
  });

  it("refuses values the Settings schemas refuse, naming the key", () => {
    expect(errorsOf([{ op: "set", key: "workspace.maxConcurrentWorkers", value: 0 }])).toContain(
      "workspace.maxConcurrentWorkers",
    );
    expect(errorsOf([{ op: "set", key: "appearance.mode", value: "purple" }])).toContain(
      "appearance.mode",
    );
    expect(errorsOf([{ op: "set", key: "appearance.mode", value: null }])).toContain(
      "can't be cleared",
    );
    expect(errorsOf([{ op: "set", key: "workspace.mergeReviewPolicy", value: "never" }])).toContain(
      "automatic, solo, bot",
    );
    expect(
      errorsOf([
        { op: "add", key: "workspace.workerModels", item: { agent: "unknown-agent", model: "x" } },
      ]),
    ).toContain("workspace.workerModels");
    expect(
      errorsOf([
        { op: "add", key: "workspace.workerModels", item: { agent: "claude", model: "opus" } },
      ]),
    ).toContain("already has claude:opus");
    expect(
      errorsOf([
        { op: "update", key: "workspace.workerModels", match: "claude:opus", item: { model: "x" } },
      ]),
    ).toContain("remove the entry and add another");
    expect(
      errorsOf([{ op: "remove", key: "workspace.workerModels", match: "claude:sonnet" }]),
    ).toContain("has no claude:sonnet");
    expect(errorsOf([{ op: "set", key: "workspace.workerModels", value: [] }])).toContain(
      "is a list",
    );
    expect(errorsOf([{ op: "remove", key: "appearance.mode", match: "x" }])).toContain(
      "isn't a list",
    );
  });

  it("refuses a gateway profile on any model it is given", () => {
    for (const change of [
      {
        op: "add",
        key: "workspace.workerModels",
        item: { agent: "codex", model: "gpt-6.1-sol", profileId: "p2" },
      },
      {
        op: "update",
        key: "workspace.workerModels",
        match: "claude:opus",
        item: { profileId: "p2" },
      },
      {
        op: "set",
        key: "workspace.orchestratorModel",
        value: { agent: "claude", model: "opus", profileId: "p2" },
      },
      {
        op: "set",
        key: "agents.defaultModel",
        value: { agent: "claude", model: "opus", profileId: "p2" },
      },
    ] as const) {
      expect(errorsOf([change])).toContain("gateway profile can't be chosen by chat");
    }
  });

  it("keeps one scope per proposal", () => {
    expect(
      errorsOf([
        { op: "set", key: "appearance.mode", value: "light" },
        { op: "set", key: "workspace.maxConcurrentWorkers", value: 3 },
      ]),
    ).toContain("not both");
  });

  it("refuses pausing and resuming: a pause is the user's way to stop agents", () => {
    // Re-review R1: the pause was approvable by chat, so an agent could ask to resume it.
    expect(SETTINGS_CATALOGUE.map((entry) => entry.key)).not.toContain("workspace.paused");
    const paused: SettingsWorld = {
      ...world,
      workspace: { ...workspace, paused: { reason: "user", at: 1 } },
    };
    for (const value of [true, false]) {
      expect(errorsOf([{ op: "set", key: "workspace.paused", value }], paused)).toContain(
        "only the user pauses or resumes",
      );
    }
    expect(readUserOnlyRows(paused)).toContainEqual(
      expect.objectContaining({ key: "workspace.paused", value: true }),
    );
  });

  it("needs a workspace for workspace keys, and a change for a proposal", () => {
    expect(
      errorsOf([{ op: "set", key: "workspace.maxConcurrentWorkers", value: 3 }], {
        settings: world.settings,
      }),
    ).toContain("needs a workspace");
    expect(errorsOf([{ op: "set", key: "appearance.mode", value: "dark" }])).toContain(
      "changes nothing",
    );
    expect(errorsOf([])).toContain("at least one change");
  });

  it("sets the orchestrator's effort on its model", () => {
    const withModel: SettingsWorld = {
      ...world,
      workspace: {
        ...workspace,
        charter: { ...workspace.charter, orchestratorModel: { agent: "claude", model: "opus" } },
      },
    };
    const result = plan(
      [{ op: "set", key: "workspace.orchestratorEffort", value: "max" }],
      withModel,
    );
    expect(charterAfter(result, withModel)?.orchestratorModel).toEqual({
      agent: "claude",
      model: "opus",
      variant: "max",
    });
    expect(result.ok && result.plan.notes.join(" ")).toContain("next session");
  });

  it("refuses an effort on a model the workspace doesn't pin", () => {
    // An effort on the inherited default would pin that model, and hang on an app setting.
    const inherited: SettingsWorld = {
      ...world,
      settings: {
        ...world.settings,
        agents: { ...world.settings.agents, defaultModel: { agent: "claude", model: "opus" } },
      },
    };
    expect(
      errorsOf([{ op: "set", key: "workspace.orchestratorEffort", value: "high" }], inherited),
    ).toContain("Set workspace.orchestratorModel with a variant instead");
  });

  it("shows every field a write stores: Standard speed is not the CLI's speed", () => {
    // Review P2: an absent speed keeps the CLI's, and `standard` turns an inherited fast off.
    const result = plan([
      { op: "set", key: "workspace.maxConcurrentWorkers", value: 4 },
      {
        op: "update",
        key: "workspace.workerModels",
        match: "claude:opus",
        item: { speed: "standard" },
      },
    ]);
    expect(result.ok && result.plan.rows).toContainEqual({
      key: "workspace.workerModels",
      label: "Worker model claude:opus",
      before: "claude:opus · high · default — the work",
      after: "claude:opus · high · standard · default — the work",
    });
    expect(result.ok && result.plan.writes.map((write) => write.key)).toEqual([
      "workspace.maxConcurrentWorkers",
      "workspace.workerModels",
    ]);
  });

  it("shows a value written over its default as a change", () => {
    const result = plan([{ op: "set", key: "layout.quietWhenIdle", value: false }]);
    expect(result.ok && result.plan.rows).toEqual([
      {
        key: "layout.quietWhenIdle",
        label: "Quiet when idle",
        before: "off (default)",
        after: "off",
      },
    ]);
  });
});

describe("settings by chat: applying", () => {
  const limit = planSettingsChanges(world, [
    { op: "set", key: "workspace.maxConcurrentWorkers", value: 4 },
  ]);
  if (!limit.ok) throw new Error("expected a plan");

  it("writes only the fields named, onto the charter as it stands now", () => {
    // Review P1: the user lowered autonomy while the card waited; the approved write keeps it.
    const now = {
      ...workspace.charter,
      autonomy: "supervised" as const,
      workerMode: "default" as const,
    };
    expect(applyCharterWrites(now, limit.plan.writes)).toEqual({ ...now, maxConcurrentWorkers: 4 });
  });

  it("writes nothing once a field it names has moved", () => {
    const moved = { ...workspace.charter, maxConcurrentWorkers: 7 };
    expect(applyCharterWrites(moved, limit.plan.writes)).toBeUndefined();
  });

  it("compares stored values whatever their keys' order", () => {
    const models = planSettingsChanges(world, [
      { op: "remove", key: "workspace.workerModels", match: "codex:gpt-6.1-sol" },
    ]);
    if (!models.ok) throw new Error("expected a plan");
    const reordered = {
      ...workspace.charter,
      workerModels: workspace.charter.workerModels!.map(
        (model) => Object.fromEntries(Object.entries(model).toReversed()) as typeof model,
      ),
    };
    expect(applyCharterWrites(reordered, models.plan.writes)?.workerModels).toHaveLength(1);
  });

  it("binds a cleared override to the app default the card shows", () => {
    // Re-review R2: the card promised the default of the moment; a later default was applied.
    const pinned: SettingsWorld = {
      ...world,
      settings: {
        ...world.settings,
        agents: {
          ...world.settings.agents,
          defaultModel: { agent: "claude", model: "fake-haiku" },
        },
      },
      workspace: {
        ...workspace,
        charter: {
          ...workspace.charter,
          orchestratorModel: { agent: "claude", model: "fake-opus" },
        },
      },
    };
    const result = planSettingsChanges(pinned, [
      { op: "set", key: "workspace.orchestratorModel", value: null },
    ]);
    if (!result.ok) throw new Error("expected a plan");
    expect(result.plan.rows).toEqual([
      {
        key: "workspace.orchestratorModel",
        label: "Orchestrator model",
        before: "claude:fake-opus",
        after: "claude:fake-haiku (default)",
      },
    ]);
    expect(result.plan.requires).toEqual([
      {
        key: "agents.defaultModel",
        path: ["agents", "defaultModel"],
        value: { agent: "claude", model: "fake-haiku" },
      },
    ]);
    expect(settingsHold(pinned.settings, result.plan.requires)).toBe(true);
    const moved = {
      ...pinned.settings,
      agents: {
        ...pinned.settings.agents,
        defaultModel: { agent: "codex" as const, model: "fake-opus" },
      },
    };
    expect(settingsHold(moved, result.plan.requires)).toBe(false);
    // An override set over an explicit one depends on nothing else.
    const set = planSettingsChanges(pinned, [
      { op: "set", key: "workspace.orchestratorModel", value: { agent: "claude", model: "opus" } },
    ]);
    expect(set.ok && set.plan.requires).toEqual([]);
  });

  it("shows a roster's new order and the fallback it brings, beside another entry's row", () => {
    // Re-review R3: remove and re-add the first entry, and edit the second's note. Only the note
    // row showed, while the order, and so the fallback worker model, changed too.
    const roster: SettingsWorld = {
      ...world,
      orchestrator: { agent: "claude", model: "fake-opus" },
      workspace: {
        ...workspace,
        charter: {
          ...workspace.charter,
          workerModels: [
            { agent: "claude", model: "fake-haiku" },
            { agent: "codex", model: "fake-haiku" },
          ],
        },
      },
    };
    const result = planSettingsChanges(roster, [
      { op: "remove", key: "workspace.workerModels", match: "claude:fake-haiku" },
      { op: "add", key: "workspace.workerModels", item: { agent: "claude", model: "fake-haiku" } },
      {
        op: "update",
        key: "workspace.workerModels",
        match: "codex:fake-haiku",
        item: { useFor: "reviews" },
      },
    ]);
    if (!result.ok) throw new Error("expected a plan");
    expect(result.plan.rows).toEqual([
      {
        key: "workspace.workerModels",
        label: "Worker model codex:fake-haiku",
        before: "codex:fake-haiku",
        after: "codex:fake-haiku — reviews",
      },
      {
        key: "workspace.workerModels",
        label: "Worker model order",
        before: "claude:fake-haiku, codex:fake-haiku",
        after: "codex:fake-haiku, claude:fake-haiku",
      },
      {
        key: "workspace.workerModels",
        label: "Worker model used when none is named",
        before: "claude:fake-haiku",
        after: "codex:fake-haiku",
      },
    ]);
  });

  it("shows no order row when kept entries keep their order and new ones go last", () => {
    const result = plan([
      { op: "add", key: "workspace.workerModels", item: { agent: "claude", model: "haiku" } },
    ]);
    expect(result.ok && result.plan.rows.map((row) => row.label)).toEqual([
      "Worker model claude:haiku",
    ]);
  });
});

describe("project local check planning", () => {
  const project = { id: "p-1" as never, root: "/invented", name: "other", bookmarked: false };
  it("rejects hidden/control characters and oversized command and setup values", () => {
    for (const field of ["command", "setup"]) {
      for (const value of [
        "echo a\necho b",
        "echo\tb",
        "echo\u0000b",
        "echo\u202eb",
        "echo\u200bb",
        "x".repeat(16_385),
      ])
        expect(
          plan([{ op: "set", key: `project.localCheck.${field}`, value }], { ...world, project })
            .ok,
        ).toBe(false);
      expect(
        plan([{ op: "set", key: `project.localCheck.${field}`, value: "make test # comment" }], {
          ...world,
          project,
        }).ok,
      ).toBe(true);
    }
  });
  it("binds an approved source-selection manifest and rejects malformed pins", () => {
    const preparation = { manifest: "/tmp/selection.json", sha256: "a".repeat(64) };
    const accepted = plan(
      [{ op: "set", key: "project.localCheck.preparation", value: preparation }],
      { ...world, project },
    );
    expect(accepted.ok).toBe(true);
    for (const value of [
      { ...preparation, sha256: "bad" },
      { sha256: preparation.sha256 },
      "selection",
    ]) {
      expect(
        plan([{ op: "set", key: "project.localCheck.preparation", value }], { ...world, project })
          .ok,
      ).toBe(false);
    }
  });
  it("has no project command default and validates the timeout", () => {
    expect(readSettingsRows({ ...world, project }, "project")).toContainEqual(
      expect.objectContaining({
        key: "project.localCheck.command",
        value: expect.stringContaining("off"),
      }),
    );
    for (const timeoutMs of [0, -1, 1.5, 86_400_001, "1000"])
      expect(
        plan([{ op: "set", key: "project.localCheck.timeoutMs", value: timeoutMs }], {
          ...world,
          project,
        }).ok,
      ).toBe(false);
    expect(
      plan([{ op: "set", key: "project.localCheck.command", value: "cargo test" }], world).ok,
    ).toBe(false);
  });
});

describe("settings by chat: the worker brief footer and routing at a limit", () => {
  it("sets, changes and clears the footer with a card row, and refuses one too long", () => {
    const set = plan([
      { op: "set", key: "workspace.workerBriefFooter", value: "Run the checks before merging." },
    ]);
    expect(set.ok && set.plan.rows).toEqual([
      {
        key: "workspace.workerBriefFooter",
        label: "Worker brief footer",
        before: "none",
        after: "Run the checks before merging.",
      },
    ]);
    const footed = { ...world, workspace: { ...workspace, charter: charterAfter(set)! } };
    expect(charterAfter(set)?.workerBriefFooter).toBe("Run the checks before merging.");
    expect(
      charterAfter(
        plan([{ op: "set", key: "workspace.workerBriefFooter", value: null }], footed),
        footed,
      ),
    ).not.toHaveProperty("workerBriefFooter");
    expect(
      charterAfter(
        plan([{ op: "set", key: "workspace.workerBriefFooter", value: "  " }], footed),
        footed,
      ),
    ).not.toHaveProperty("workerBriefFooter");
    expect(
      errorsOf([{ op: "set", key: "workspace.workerBriefFooter", value: "x".repeat(4001) }]),
    ).toContain("at most 4000 characters");
    expect(errorsOf([{ op: "set", key: "workspace.workerBriefFooter", value: 3 }])).toContain(
      "expected text",
    );
  });

  it("turns routing at a limit on and off, stored only while on", () => {
    expect(readSettingsRows(world, "workspace")).toContainEqual(
      expect.objectContaining({ key: "workspace.routeAtLimit", value: false }),
    );
    const on = plan([{ op: "set", key: "workspace.routeAtLimit", value: true }]);
    expect(on.ok && on.plan.rows).toEqual([
      {
        key: "workspace.routeAtLimit",
        label: "Offer another model at a limit",
        before: "off (default)",
        after: "on",
      },
    ]);
    const routed = { ...world, workspace: { ...workspace, charter: charterAfter(on)! } };
    expect(
      charterAfter(
        plan([{ op: "set", key: "workspace.routeAtLimit", value: false }], routed),
        routed,
      ),
    ).not.toHaveProperty("routeAtLimit");
    expect(errorsOf([{ op: "set", key: "workspace.routeAtLimit", value: false }])).toContain(
      "changes nothing",
    );
    expect(errorsOf([{ op: "set", key: "workspace.routeAtLimit", value: "yes" }])).toContain(
      "expected true",
    );
  });
});

describe("settings by chat: idle compaction", () => {
  it("reads as on for the orchestrator when the workspace never set it", () => {
    const rows = readSettingsRows(world, "workspace");
    expect(rows).toContainEqual(
      expect.objectContaining({ key: "workspace.idleAutoCompact", value: true }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({ key: "workspace.idleAutoCompactKinds", value: ["orchestrator"] }),
    );
  });

  it("turns off, back to the default, and covers workers when asked", () => {
    expect(
      charterAfter(plan([{ op: "set", key: "workspace.idleAutoCompact", value: false }])),
    ).toMatchObject({ idleAutoCompact: false });
    const off = {
      ...world,
      workspace: { ...workspace, charter: { ...workspace.charter, idleAutoCompact: false } },
    };
    expect(
      charterAfter(plan([{ op: "set", key: "workspace.idleAutoCompact", value: null }], off), off),
    ).not.toHaveProperty("idleAutoCompact");
    expect(
      charterAfter(
        plan([
          {
            op: "set",
            key: "workspace.idleAutoCompactKinds",
            value: ["orchestrator", "worker", "worker"],
          },
        ]),
      ),
    ).toMatchObject({ idleAutoCompactKinds: ["orchestrator", "worker"] });
  });

  it("refuses values that aren't a switch or a list of kinds", () => {
    expect(errorsOf([{ op: "set", key: "workspace.idleAutoCompact", value: "yes" }])).toContain(
      "workspace.idleAutoCompact",
    );
    expect(errorsOf([{ op: "set", key: "workspace.idleAutoCompactKinds", value: [] }])).toContain(
      "workspace.idleAutoCompactKinds",
    );
    expect(
      errorsOf([{ op: "set", key: "workspace.idleAutoCompactKinds", value: ["plain"] }]),
    ).toContain("workspace.idleAutoCompactKinds");
  });
});
