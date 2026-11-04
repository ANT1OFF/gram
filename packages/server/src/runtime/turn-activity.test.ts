import { DEFAULT_SETTINGS, keepAwakeOn, type TurnId } from "@gram/contracts";
import { describe, expect, it, vi } from "vitest";
import { makeTurnActivity } from "./turn-activity.ts";

const first = "solo-turn" as TurnId;
const second = "worker-turn" as TurnId;

describe("turn activity", () => {
  it("reports active on the first running turn and idle when the last ends", () => {
    const report = vi.fn();
    const activity = makeTurnActivity(report, keepAwakeOn(DEFAULT_SETTINGS));
    activity.start(first);
    activity.start(second);
    activity.start(second);
    activity.end(first);
    activity.end(first);
    expect(report.mock.calls).toEqual([[true]]);
    activity.end(second);
    expect(report.mock.calls).toEqual([[true], [false]]);
  });

  it("does not request a blocker with the setting off", () => {
    const report = vi.fn();
    const activity = makeTurnActivity(
      report,
      keepAwakeOn({
        ...DEFAULT_SETTINGS,
        agents: { ...DEFAULT_SETTINGS.agents, keepAwake: false },
      }),
    );
    activity.start(first);
    activity.start(second);
    activity.end(first);
    activity.end(second);
    expect(report).not.toHaveBeenCalled();
  });

  it("applies setting changes during turns and releases on teardown", () => {
    const report = vi.fn();
    const activity = makeTurnActivity(report, true);
    activity.start(first);
    activity.setEnabled(false);
    activity.start(second);
    activity.end(first);
    activity.setEnabled(true);
    activity.dispose();
    expect(report.mock.calls).toEqual([[true], [false], [true], [false]]);
  });
});
