import type { AgentEvent } from "@gram/contracts";

type RateLimit = Omit<Extract<AgentEvent, { type: "rateLimit" }>, "type">;

/** Utilisation past which a window's warning shows again. Its first warning shows wherever it is. */
const RATE_LIMIT_THRESHOLDS = [0.8, 0.95] as const;

/**
 * How long a window with no warning or rejection is remembered, and one with no known reset at all,
 * when its reset hasn't passed first.
 */
const RATE_LIMIT_FORGET_MS = 6 * 60 * 60 * 1000;

/** Warnings below, at and past the thresholds rank 1 to 3; a rejection ranks above them all. */
const levelOf = (limit: RateLimit) =>
  limit.status === "rejected"
    ? RATE_LIMIT_THRESHOLDS.length + 2
    : 1 + RATE_LIMIT_THRESHOLDS.filter((t) => (limit.utilization ?? 0) >= t).length;

/**
 * Picks the rate-limit reports worth telling the user about, across every thread. The agent reports
 * a limit on every request near it, and each session reports its own, so ten busy threads would
 * say it ten times a request. Each window remembers the highest level it has shown, and a report
 * shows only when it raises that. A window is forgotten once its latest known reset has passed, six
 * hours after its last report, or, with no reset known, six hours after it was first shown, so a
 * reset that is missing, late or stale can neither silence it for good nor show it twice. Windows
 * are per `account`, since a gateway profile's `five_hour` is a different quota from the
 * subscription's. Held in memory only, so a restart may show one again.
 */
export const makeRateLimitGate = () => {
  const shown = new Map<
    string,
    {
      readonly level: number;
      readonly resetsAt: number | undefined;
      readonly seenAt: number;
      readonly shownAt: number;
    }
  >();
  return (account: string, limit: RateLimit, now: number): boolean => {
    for (const [key, entry] of shown) {
      const reset =
        entry.resetsAt === undefined
          ? now - entry.shownAt >= RATE_LIMIT_FORGET_MS
          : entry.resetsAt <= now;
      if (reset || now - entry.seenAt >= RATE_LIMIT_FORGET_MS) shown.delete(key);
    }
    const key = `${account}\0${limit.window}`;
    const seen = shown.get(key);
    const level = Math.max(levelOf(limit), seen?.level ?? 0);
    // A reset already past says nothing about when this window ends; the six hours cover it.
    const resetsAt =
      limit.resetsAt !== undefined && limit.resetsAt > now ? limit.resetsAt : seen?.resetsAt;
    shown.set(key, { level, resetsAt, seenAt: now, shownAt: seen?.shownAt ?? now });
    return level > (seen?.level ?? 0);
  };
};
