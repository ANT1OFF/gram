import type { TokenUsage } from "@gram/contracts";
import {
  object,
  identity,
  modelOf,
  timeOf,
  type HistoryRecord,
  type HistoryReducer,
} from "./history-types.ts";
export function makeClaudeHistory(initialFrom = -Infinity, initialTo = Infinity): HistoryReducer {
  const records = new Map<string, HistoryRecord>(),
    rejected = new Set<string>();
  let from = initialFrom,
    to = initialTo;
  const reducer: HistoryReducer = {
    records,
    nativeTurnIds: new Set(),
    owner: undefined,
    nativeOverflow: false,
    identityComplete: true,
    invalid: 0,
    ambiguous: 0,
    retainedBytes() {
      return [...rejected].reduce((bytes, id) => bytes + Buffer.byteLength(id), 0);
    },
    breakContext() {},
    window(start, end) {
      from = start;
      to = end;
      for (const [id, r] of records) if (r.at < from || r.at >= to) records.delete(id);
    },
    consume(value) {
      const provider = "claude" as const,
        raw = object(value);
      // The pinned SDK remaps UUID/session/tail timestamp and retains usage on fork copies.
      // These are inherited context, not a newly executed request; never charge the fork.
      if (identity(object(raw.forkedFrom).sessionId) !== undefined) {
        if (object(raw.message).usage !== undefined) reducer.ambiguous++;
        return;
      }
      if (raw.type !== "assistant" || raw.isSidechain === true || raw.parent_tool_use_id != null)
        return;
      const message = object(raw.message),
        usage = object(message.usage);
      if (message.usage === undefined) return;
      const scopedSession = identity(raw.sessionId),
        messageId = identity(message.id),
        request = identity(raw.requestId);
      const timestamp = timeOf(raw.timestamp);
      if (scopedSession === undefined || messageId === undefined || timestamp === undefined) {
        reducer.invalid++;
        return;
      }
      if (timestamp < from || timestamp >= to) return;
      const fields = [
        "input_tokens",
        "output_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
      ];
      const counts = fields.map((key) => usage[key]);
      if (
        counts.some(
          (n, index) =>
            !(n === undefined && index > 1) &&
            (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0),
        )
      ) {
        reducer.invalid++;
        return;
      }
      const tokens: TokenUsage = {
        inputTokens: counts[0] as number,
        outputTokens: counts[1] as number,
        ...(counts[2] === undefined ? {} : { cacheReadTokens: counts[2] as number }),
        ...(counts[3] === undefined ? {} : { cacheWriteTokens: counts[3] as number }),
      };
      if (
        !Number.isSafeInteger(
          tokens.inputTokens +
            tokens.outputTokens +
            (tokens.cacheReadTokens ?? 0) +
            (tokens.cacheWriteTokens ?? 0),
        )
      ) {
        reducer.invalid++;
        return;
      }
      const id = JSON.stringify([scopedSession, messageId, request ?? null]);
      if (rejected.has(id)) return;
      const previous = records.get(id),
        currentModel = modelOf(message.model),
        uuid = identity(raw.uuid);
      if (previous !== undefined) {
        if (uuid === undefined) previous.complete = false;
        // Repeated content blocks can progressively report output. They are the same request.
        const compatible = ["inputTokens", "cacheReadTokens", "cacheWriteTokens"].every(
          (key) => previous.tokens[key as keyof TokenUsage] === tokens[key as keyof TokenUsage],
        );
        if (!compatible || previous.model !== currentModel) {
          previous.trusted = false;
          previous.complete = false;
          previous.model = null;
          rejected.add(id);
          reducer.ambiguous++;
          return;
        }
        previous.tokens = {
          ...previous.tokens,
          outputTokens: Math.max(previous.tokens.outputTokens, tokens.outputTokens),
        };
        if (uuid !== undefined && !previous.nativeIds.includes(uuid)) {
          if (previous.nativeIds.length >= 128) {
            previous.complete = false;
            reducer.ambiguous++;
          } else previous.nativeIds.push(uuid);
        }
        return;
      }
      records.set(id, {
        provider,
        session: scopedSession,
        id,
        nativeIds: uuid === undefined ? [] : [uuid],
        model: currentModel,
        at: timestamp,
        tokens,
        partial: false,
        complete: uuid !== undefined,
        trusted: true,
        parent: null,
      });
    },
  };
  return reducer;
}
