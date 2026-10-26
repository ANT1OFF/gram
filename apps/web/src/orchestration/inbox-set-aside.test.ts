import {
  DEFAULT_SETTINGS,
  INBOX_SET_ASIDE_LIMIT,
  type Settings,
  type SettingsPatch,
} from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { useServerSettings } from "@/settings-sync/store";

import {
  asleep,
  saveCleared,
  saveSetAside,
  snoozesOf,
  withCleared,
  withoutSnoozes,
  withSnoozes,
} from "./inbox-set-aside";

describe("snoozes", () => {
  it("read an id that holds spaces, split at the last one", () => {
    expect([...snoozesOf(["memory:w:Ship on Friday? 1000", "r-a 2000", "bad", "r-b x"])]).toEqual([
      ["memory:w:Ship on Friday?", 1000],
      ["r-a", 2000],
    ]);
  });

  it("drop woken ones and an id snoozed again, and cap oldest-first", () => {
    expect(withSnoozes(["r-a 50", "r-b 500", "r-c 500"], ["r-c"], 900, 100)).toEqual([
      "r-b 500",
      "r-c 900",
    ]);
    const many = Array.from({ length: INBOX_SET_ASIDE_LIMIT }, (_, i) => `r-${i} 1000`);
    const next = withSnoozes(many, ["r-new"], 2000, 0);
    expect(next).toHaveLength(INBOX_SET_ASIDE_LIMIT);
    expect(next[0]).toBe("r-1 1000");
    expect(next.at(-1)).toBe("r-new 2000");
  });

  it("wake at once on an unsnooze, the others kept as they are", () => {
    expect(
      withoutSnoozes(["memory:w:Ship on Friday? 900", "r-b 500"], ["memory:w:Ship on Friday?"]),
    ).toEqual(["r-b 500"]);
    expect(withoutSnoozes(undefined, ["r-a"])).toEqual([]);
  });

  it("are asleep until their wake time, and say when the soonest wakes", () => {
    const snoozes = snoozesOf(["r-a 100", "r-b 300", "r-c 200"]);
    expect(asleep(snoozes, 150)).toEqual({ ids: new Set(["r-b", "r-c"]), wakes: 200 });
    expect(asleep(snoozes, 300)).toEqual({ ids: new Set(), wakes: undefined });
  });
});

describe("clears", () => {
  it("keep each id once, the newest last, capped", () => {
    expect(withCleared(["a", "b"], ["a"])).toEqual(["b", "a"]);
    const many = Array.from({ length: INBOX_SET_ASIDE_LIMIT }, (_, i) => `f-${i}`);
    expect(withCleared(many, ["f-new"])[0]).toBe("f-1");
  });
});

describe("saving", () => {
  it("builds on a save still in flight, so two quick snoozes both stay", async () => {
    useServerSettings.setState({ settings: DEFAULT_SETTINGS });
    const patches: SettingsPatch[] = [];
    const gate = Promise.withResolvers<void>();
    const save = async (patch: SettingsPatch): Promise<Settings> => {
      patches.push(patch);
      if (patches.length === 1) await gate.promise;
      return DEFAULT_SETTINGS;
    };
    const first = saveSetAside(save, ["r-a"], { snoozeUntil: 5000, now: 0 });
    const second = saveSetAside(save, ["r-b"], { snoozeUntil: 6000, now: 0 });
    gate.resolve();
    await Promise.all([first, second]);
    expect(patches).toEqual([
      { inbox: { snoozed: ["r-a 5000"] } },
      { inbox: { snoozed: ["r-a 5000", "r-b 6000"] } },
    ]);
  });

  it("keeps the other list as it is", async () => {
    useServerSettings.setState({
      settings: { ...DEFAULT_SETTINGS, inbox: { snoozed: ["r-a 5000"], cleared: ["f-1"] } },
    });
    const patches: SettingsPatch[] = [];
    await saveSetAside(
      async (patch) => {
        patches.push(patch);
        return DEFAULT_SETTINGS;
      },
      ["f-2"],
      "clear",
    );
    expect(patches).toEqual([{ inbox: { cleared: ["f-1", "f-2"] } }]);
  });

  it("unsnoozes only the ids it is given", async () => {
    useServerSettings.setState({
      settings: { ...DEFAULT_SETTINGS, inbox: { snoozed: ["r-a 5000", "r-b 6000"], cleared: [] } },
    });
    const patches: SettingsPatch[] = [];
    await saveSetAside(
      async (patch) => {
        patches.push(patch);
        return DEFAULT_SETTINGS;
      },
      ["r-a"],
      "unsnooze",
    );
    expect(patches).toEqual([{ inbox: { snoozed: ["r-b 6000"] } }]);
  });
});

describe("dismissing", () => {
  it("builds on a save still in flight, so two quick dismisses both stay", async () => {
    useServerSettings.setState({ settings: { ...DEFAULT_SETTINGS, inbox: { cleared: ["f-0"] } } });
    const patches: SettingsPatch[] = [];
    const gate = Promise.withResolvers<void>();
    const save = async (patch: SettingsPatch): Promise<Settings> => {
      patches.push(patch);
      if (patches.length === 1) await gate.promise;
      return DEFAULT_SETTINGS;
    };
    const first = saveCleared(save, ["f-1"]);
    const second = saveCleared(save, ["f-2"]);
    gate.resolve();
    await Promise.all([first, second]);
    expect(patches).toEqual([
      { inbox: { cleared: ["f-0", "f-1"] } },
      { inbox: { cleared: ["f-0", "f-1", "f-2"] } },
    ]);
  });
});
