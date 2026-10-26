import {
  limitCurrent,
  nextLimitReading,
  type AgentKind,
  type LimitRecord,
  type LimitSample,
  type ServerEvent,
  type ThreadId,
} from "@gram/contracts";

import type { MockWorld } from "./mock-world";

type UsageLimitEvent = Extract<ServerEvent, { type: "usageLimit" }>;
type LimitsSnapshot = Extract<ServerEvent, { type: "usageLimits.snapshot" }>;

/** e2e specs set this sessionStorage flag to `none` to start with no limits reported. */
export const MOCK_LIMITS_KEY = "gram.mock.limits";

/**
 * Where the mock keeps the readings it has taken, as the server keeps them in its database, so a
 * reload of the page finds them again.
 */
export const MOCK_LIMIT_RECORDS_KEY = "gram.mock.limitRecords";

/** What `simulateUsageLimit` takes: one window's reading, as an agent would report it. */
export interface MockLimitInput {
  readonly agent: AgentKind;
  /** The agent's name: `five_hour` or `seven_day`. */
  readonly window: string;
  readonly utilization: number;
  /** Epoch ms; absent for a reading without one. */
  readonly resetsAt?: number;
  readonly status?: UsageLimitEvent["status"];
  readonly gateway?: boolean;
  /** The agent goes on past the window on credits. */
  readonly credits?: boolean;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** `at` on the next quarter hour, so the invented resets read like real ones. */
const quarter = (at: number) => Math.ceil(at / (15 * MINUTE)) * 15 * MINUTE;

/** A kept reading whose samples are `[minutes ago, share]`; the last is the reading itself. */
const seed = (
  now: number,
  fields: Omit<LimitRecord, "utilization" | "at" | "samples" | "status"> & {
    readonly status?: LimitRecord["status"];
  },
  samples: ReadonlyArray<readonly [minutesAgo: number, utilization: number]>,
): LimitRecord => {
  const kept: LimitSample[] = samples.map(([ago, utilization]) => ({
    at: now - ago * MINUTE,
    utilization,
  }));
  const last = kept.at(-1)!;
  return {
    status: "allowed",
    ...fields,
    utilization: last.utilization,
    at: last.at,
    samples: kept,
  };
};

/**
 * Invented subscription readings for both providers, as the server would replay them. Claude is
 * comfortably inside its limits, read 40 minutes ago, so the popover shows the age. Codex's 5-hour
 * window is at 85%, past the meter's warning, and has risen fast enough over the last hour that
 * the popover forecasts it. Relative to `now`, so the resets stay ahead.
 */
export const mockLimitSeeds = (now: number): LimitRecord[] => [
  seed(now, { agent: "claude", window: "five_hour", resetsAt: quarter(now + 2.5 * HOUR) }, [
    [100, 0.3],
    [70, 0.36],
    [40, 0.42],
  ]),
  seed(now, { agent: "claude", window: "seven_day", resetsAt: quarter(now + 3 * DAY) }, [
    [40, 0.61],
  ]),
  seed(
    now,
    {
      agent: "codex",
      window: "five_hour",
      resetsAt: quarter(now + 75 * MINUTE),
      status: "warning",
    },
    [
      [55, 0.7],
      [30, 0.78],
      [1, 0.85],
    ],
  ),
  seed(now, { agent: "codex", window: "seven_day", resetsAt: quarter(now + 5 * DAY) }, [[1, 0.3]]),
];

const keyOf = (record: Pick<LimitRecord, "agent" | "profileId" | "window">) =>
  `${record.agent}/${record.profileId ?? ""}/${record.window}`;

const storage = () => (typeof sessionStorage === "undefined" ? undefined : sessionStorage);

/**
 * The agents' usage-limit readings as the server handles them: each kept per agent, login and
 * window (in sessionStorage, the mock's stand-in for the server's database), replayed to a new
 * `events` subscriber as one `usageLimits.snapshot`, and relayed live as they come.
 */
export function createLimitsMock(world: MockWorld) {
  const threadId = () => (world.threads()[0]?.thread.id ?? "t-limits") as ThreadId;
  const eventOf = (input: MockLimitInput): UsageLimitEvent => ({
    type: "usageLimit",
    threadId: threadId(),
    agent: input.agent,
    status:
      input.status ?? (input.utilization >= 1 && input.credits !== true ? "rejected" : "allowed"),
    window: input.window,
    utilization: input.utilization,
    ...(input.resetsAt === undefined ? {} : { resetsAt: input.resetsAt }),
    ...(input.gateway === true ? { gateway: true, profileId: "mock-gateway" } : {}),
    ...(input.credits === true ? { credits: true as const } : {}),
  });

  const records = new Map<string, LimitRecord>();
  const saved = storage()?.getItem(MOCK_LIMIT_RECORDS_KEY);
  if (saved !== null && saved !== undefined) {
    for (const record of JSON.parse(saved) as LimitRecord[]) records.set(keyOf(record), record);
  } else if (storage()?.getItem(MOCK_LIMITS_KEY) !== "none") {
    for (const record of mockLimitSeeds(Date.now())) records.set(keyOf(record), record);
  }
  const save = () =>
    storage()?.setItem(MOCK_LIMIT_RECORDS_KEY, JSON.stringify([...records.values()]));

  const keep = (event: UsageLimitEvent) => {
    const key = keyOf(event);
    const reading = nextLimitReading(records.get(key), event, Date.now());
    if (reading === undefined) return;
    records.set(key, {
      agent: event.agent,
      ...(event.profileId === undefined ? {} : { profileId: event.profileId }),
      window: event.window,
      ...reading,
    });
    save();
  };

  return {
    /** What a new `events` subscriber hears first: every reading still current. */
    snapshot: (): LimitsSnapshot => ({
      type: "usageLimits.snapshot",
      limits: [...records.values()].filter((record) => limitCurrent(record, Date.now())),
    }),
    controls: {
      /** An agent reports `input`, as a turn's rate-limit event would. */
      simulateUsageLimit: (input: MockLimitInput): void => {
        const event = eventOf(input);
        keep(event);
        world.emit(event);
      },
    },
  };
}
