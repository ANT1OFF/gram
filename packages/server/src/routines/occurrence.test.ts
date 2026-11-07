// A routine run's occurrence, as one state machine: its phase from every combination of the durable
// facts it is read from, so no fact a crash or a release can leave is read the wrong way.
import type { ThreadId } from "@gram/contracts";
import { describe, expect, it } from "vitest";
import { occurrencePhase, type OccurrenceFacts } from "./routines.ts";

const id = "t1" as ThreadId;
const thread = (over: Partial<NonNullable<OccurrenceFacts["thread"]>> = {}) => ({
  id,
  title: "CI triage",
  mine: true,
  spawned: true,
  live: true,
  ...over,
});
const facts = (over: Partial<OccurrenceFacts> = {}): OccurrenceFacts => ({
  claim: {},
  heldId: undefined,
  requested: false,
  thread: undefined,
  closed: false,
  ...over,
});

describe("occurrencePhase", () => {
  it("is held while its brief is held, whatever else is there", () => {
    for (const t of [undefined, thread(), thread({ spawned: false })]) {
      expect(occurrencePhase(facts({ heldId: "held-1", thread: t })).phase).toBe("held");
    }
  });

  it("is pending only while nothing durable says it got further", () => {
    expect(occurrencePhase(facts()).phase).toBe("pending");
    // A spawn begun and cut short before its row: resumed under the same id.
    expect(occurrencePhase(facts({ requested: true })).phase).toBe("pending");
    // Seen held, then the brief went (cancelled, dropped) with no worker: settled.
    expect(occurrencePhase(facts({ claim: { heldId: "held-1" } })).phase).toBe("settled");
    // Seen making a worker that is gone now: settled.
    expect(occurrencePhase(facts({ claim: { threadId: id } })).phase).toBe("settled");
    // Its worker was made and closed before the claim recorded it: settled, never made again.
    expect(occurrencePhase(facts({ requested: true, closed: true })).phase).toBe("settled");
  });

  it("is spawning while its worker exists without its spawn finished, live or not", () => {
    for (const live of [true, false]) {
      expect(occurrencePhase(facts({ thread: thread({ spawned: false, live }) }))).toEqual({
        phase: "spawning",
        threadId: id,
      });
    }
  });

  it("is live while its worker is, and settled once it isn't", () => {
    expect(occurrencePhase(facts({ thread: thread() }))).toEqual({
      phase: "live",
      threadId: id,
      title: "CI triage",
    });
    expect(occurrencePhase(facts({ thread: thread({ live: false }) }))).toEqual({
      phase: "settled",
      threadId: id,
    });
  });

  it("is settled once its worker is no longer the routine's", () => {
    for (const t of [thread({ mine: false }), thread({ mine: false, spawned: false })]) {
      expect(occurrencePhase(facts({ thread: t })).phase).toBe("settled");
    }
  });
});
