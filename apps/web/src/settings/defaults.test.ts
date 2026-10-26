import { applySettingsPatch, DEFAULT_SETTINGS } from "@gram/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  AGENTS_DEFAULTS,
  changedSettings,
  GENERAL_DEFAULTS,
  isDefault,
  listLabels,
  NOTIFICATIONS_DEFAULTS,
  resetFor,
  restorePatch,
} from "./defaults";

const PAGES = [GENERAL_DEFAULTS, AGENTS_DEFAULTS, NOTIFICATIONS_DEFAULTS];

describe("settings defaults", () => {
  it("counts every setting as its default on fresh settings", () => {
    for (const page of PAGES) {
      expect(changedSettings(Object.values(page), DEFAULT_SETTINGS)).toEqual([]);
    }
  });

  it("reads unset keys as the default they stand for", () => {
    // Stored explicitly, the same values as the defaults the unset keys mean.
    const explicit = applySettingsPatch(DEFAULT_SETTINGS, {
      agents: { branchPrefix: "feat" },
      composer: { sendKey: "enter" },
      notifications: { reviewRequests: true, reviewRequestsDirectOnly: true },
    });
    expect(isDefault(GENERAL_DEFAULTS.branchPrefix, explicit)).toBe(true);
    expect(isDefault(GENERAL_DEFAULTS.sendKey, explicit)).toBe(true);
    expect(isDefault(NOTIFICATIONS_DEFAULTS.reviewRequests, explicit)).toBe(true);
    expect(isDefault(NOTIFICATIONS_DEFAULTS.directOnly, explicit)).toBe(true);
  });

  it("finds what changed, and one patch puts all of it back", () => {
    const changed = applySettingsPatch(DEFAULT_SETTINGS, {
      agents: { branchPrefix: "fix", defaultFolder: "~/work", followWorktreeMoves: false },
      composer: { sendKey: "modEnter" },
      editor: { command: "zed" },
      notifications: { native: false, sounds: false, reviewRequestsMaxAgeDays: 30 },
    });
    const general = changedSettings(Object.values(GENERAL_DEFAULTS), changed);
    expect(general.map((setting) => setting.label)).toEqual([
      "Default folder",
      "Branch prefix",
      "Send with",
      "Follow worktree moves",
      "Open in editor",
    ]);
    const notifications = changedSettings(Object.values(NOTIFICATIONS_DEFAULTS), changed);
    expect(notifications.map((setting) => setting.label)).toEqual([
      "Desktop notifications",
      "Sound",
      "Maximum age",
    ]);

    const restored = applySettingsPatch(changed, restorePatch([...general, ...notifications]));
    for (const page of PAGES) expect(changedSettings(Object.values(page), restored)).toEqual([]);
  });

  it("merges resets that share a section instead of letting the last one win", () => {
    expect(restorePatch([GENERAL_DEFAULTS.defaultFolder, GENERAL_DEFAULTS.branchPrefix])).toEqual({
      agents: { defaultFolder: null, branchPrefix: null },
    });
  });

  it("offers a reset only while a setting differs", () => {
    const apply = vi.fn();
    expect(resetFor(DEFAULT_SETTINGS, apply)(AGENTS_DEFAULTS.idleEvictMinutes)).toBeUndefined();
    const changed = applySettingsPatch(DEFAULT_SETTINGS, { agents: { idleEvictMinutes: 45 } });
    resetFor(changed, apply)(AGENTS_DEFAULTS.idleEvictMinutes)?.();
    expect(apply).toHaveBeenCalledWith({
      agents: { idleEvictMinutes: DEFAULT_SETTINGS.agents.idleEvictMinutes },
    });
  });

  it("lists labels the way a sentence would", () => {
    expect(listLabels(["Send with"])).toBe("Send with");
    expect(listLabels(["Send with", "Side panel"])).toBe("Send with and Side panel");
    expect(listLabels(["A", "B", "C"])).toBe("A, B and C");
  });
});
