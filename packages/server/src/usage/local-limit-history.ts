import {
  LOCAL_LIMIT_OBSERVATIONS_MAX,
  type UsageLimitObservation,
  type UsageLocalLimitHistory,
} from "@gram/contracts";
import { object, timeOf } from "./history-types.ts";
import type { Fields } from "./json-projection.ts";

const limitWindow: Fields = { used_percent: true, window_minutes: true, resets_at: true };
/** Independently projected so malformed optional quota metadata cannot invalidate token counts. */
export const localLimitFields: Fields = {
  type: true,
  timestamp: true,
  payload: {
    type: true,
    rate_limits: { limit_id: true, primary: limitWindow, secondary: limitWindow },
  },
};

const order = (a: UsageLimitObservation, b: UsageLimitObservation) =>
  a.at - b.at ||
  a.window.localeCompare(b.window) ||
  a.utilization - b.utilization ||
  (a.resetsAt ?? 0) - (b.resetsAt ?? 0);
const key = (sample: UsageLimitObservation) =>
  `${sample.provider}/${sample.window}/${sample.at}/${sample.utilization}/${sample.resetsAt ?? ""}`;

/** Fixed-size metadata only. Copied rollouts/repeated refreshes cannot duplicate observations. */
export function makeLocalLimitCollector() {
  const samples = new Map<string, UsageLimitObservation>();
  let invalidReadings = 0,
    truncated = false;
  const add = (sample: UsageLimitObservation) => {
    const id = key(sample);
    if (samples.has(id)) return;
    samples.set(id, sample);
    const group = [...samples.values()].filter(
      (each) => each.window === sample.window && each.provider === sample.provider,
    );
    if (group.length > LOCAL_LIMIT_OBSERVATIONS_MAX) {
      samples.delete(key(group.toSorted(order)[0]!));
      truncated = true;
    }
  };
  const snapshot = (): UsageLocalLimitHistory => ({
    observations: [...samples.values()].toSorted(order),
    invalidReadings,
    truncated,
  });
  return {
    snapshot,
    retainedBytes: () =>
      [...samples.values()].reduce((n, sample) => n + Buffer.byteLength(JSON.stringify(sample)), 0),
    merge(history: UsageLocalLimitHistory) {
      history.observations.forEach(add);
      invalidReadings += history.invalidReadings;
      truncated ||= history.truncated;
    },
    window(from: number, to: number) {
      for (const [id, sample] of samples)
        if (sample.at < from || sample.at >= to) samples.delete(id);
    },
    /** A valid token projection proves the candidate even when optional quota projection failed. */
    invalidProjection(value: unknown, from: number, to: number) {
      const raw = object(value),
        payload = object(raw.payload),
        at = timeOf(raw.timestamp);
      if (
        raw.type === "event_msg" &&
        payload.type === "token_count" &&
        (at === undefined || (at >= from && at < to))
      )
        invalidReadings++;
    },
    consume(value: unknown, from: number, to: number) {
      const raw = object(value),
        payload = object(raw.payload);
      if (raw.type !== "event_msg" || payload.type !== "token_count" || payload.rate_limits == null)
        return;
      const at = timeOf(raw.timestamp),
        limits = object(payload.rate_limits);
      if (at !== undefined && (at < from || at >= to)) return;
      // Per-model buckets and credits/spend controls are not subscription-wide quota readings.
      if (limits.limit_id != null && limits.limit_id !== "codex") return;
      if (at === undefined || Object.keys(limits).length === 0) {
        invalidReadings++;
        return;
      }
      for (const lane of [limits.primary, limits.secondary]) {
        if (lane == null) continue;
        const limit = object(lane);
        const window =
          limit.window_minutes === 300
            ? "five_hour"
            : limit.window_minutes === 10_080
              ? "seven_day"
              : undefined;
        if (window === undefined) {
          invalidReadings++;
          continue;
        }
        const used = limit.used_percent,
          reset = limit.resets_at;
        if (
          typeof used !== "number" ||
          !Number.isFinite(used) ||
          used < 0 ||
          used > 100 ||
          (reset != null &&
            (typeof reset !== "number" ||
              !Number.isSafeInteger(reset) ||
              reset <= 0 ||
              !Number.isSafeInteger(reset * 1000)))
        ) {
          invalidReadings++;
          continue;
        }
        add({
          provider: "codex",
          window,
          at,
          utilization: used / 100,
          ...(typeof reset === "number" ? { resetsAt: reset * 1000 } : {}),
        });
      }
    },
  };
}

/** Count skipped valid JSON without ever projecting its content. Reducers still validate identity. */
export function isUsageMetadataLine(provider: "claude" | "codex", value: unknown): boolean {
  const raw = object(value),
    payload = object(raw.payload);
  if (provider === "claude") return raw.type === "assistant";
  return (
    raw.type === "session_meta" ||
    raw.type === "turn_context" ||
    raw.type === "token_usage_record" ||
    (raw.type === "event_msg" &&
      [
        "token_count",
        "task_started",
        "turn_started",
        "task_complete",
        "turn_complete",
        "model_reroute",
      ].includes(String(payload.type)))
  );
}
