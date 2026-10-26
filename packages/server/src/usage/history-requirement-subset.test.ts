import { expect, it } from "vitest";
import { makeHistoryReducer } from "./history-records.ts";
import { canonicalHistory } from "./history-canonical.ts";
const old = "2026-09-01T12:00:00Z",
  now = "2026-10-06T12:00:00Z",
  e = (type: string, payload: object, timestamp = old) => ({ type, payload, timestamp }),
  c = (input_tokens: number) => ({ input_tokens, output_tokens: 0 });
for (const refused of [false, true])
  for (const last of [10, 0, undefined])
    it(`first native requirement smaller than its actual request cannot certify continuity refused=${refused} last=${last}`, () => {
      const r = makeHistoryReducer("codex");
      [
        e("session_meta", { id: "owner" }),
        e("event_msg", { type: "token_count", info: { total_token_usage: c(0) } }),
        e("turn_context", { turn_id: "old", model: "actual" }, refused ? "invalid" : old),
        e("event_msg", {
          type: "token_count",
          info: { total_token_usage: c(10), last_token_usage: c(10) },
        }),
        e(
          "token_usage_record",
          {
            thread_id: "owner",
            turn_id: "old",
            response_id: "r1",
            usage: c(10),
            turn_token_usage: c(5),
          },
          refused ? "invalid" : old,
        ),
        e("event_msg", { type: "task_complete", turn_id: "old" }),
        e("turn_context", { turn_id: "new", model: "actual" }, now),
        e(
          "event_msg",
          {
            type: "token_count",
            info: {
              total_token_usage: c(last === 0 ? 20 : 30),
              ...(last === undefined ? {} : { last_token_usage: c(last) }),
            },
          },
          now,
        ),
        e("event_msg", { type: "task_complete", turn_id: "new" }, now),
      ].forEach((x) => r.consume(x));
      const rows = [...canonicalHistory([...r.records.values()]).unique.values()];
      expect(rows.find((x) => x.id === "old")?.tokens.inputTokens).toBe(10);
      expect(rows.find((x) => x.id === "new")?.tokens.inputTokens).toBe(last);
      if (last !== undefined) expect(rows.find((x) => x.id === "new")?.partial).toBe(true);
    });
