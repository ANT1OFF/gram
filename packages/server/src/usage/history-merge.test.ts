import { describe, expect, it } from "vitest";
import { aggregateUsage, type UsageRecord } from "./aggregate.ts";
import { mergeHistoryUsage } from "./history-merge.ts";
import type { HistoryRecord } from "./history-records.ts";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const cli = (overrides: Partial<HistoryRecord> = {}): HistoryRecord => ({
  provider: "codex",
  session: "wire-session",
  id: "wire-turn",
  nativeIds: ["wire-turn"],
  model: "actual-old",
  at: NOW - 1000,
  tokens: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
  complete: true,
  trusted: true,
  partial: false,
  parent: null,
  ...overrides,
});
const stored = (overrides: Partial<UsageRecord> = {}): UsageRecord => ({
  id: "gram-turn",
  thread_id: "gram-thread",
  started_at: NOW - 1000,
  ended_at: NOW - 500,
  reason: "completed",
  agent: "codex",
  model: null,
  source_session: "wire-session",
  native_ids: '["wire-turn"]',
  usage: JSON.stringify({ tokens: { inputTokens: 1_000_100, outputTokens: 10_010 } }),
  ...overrides,
});
const merge = (gram: UsageRecord[], records: HistoryRecord[]) => {
  const result = mergeHistoryUsage(gram, { records, sources: [], ambiguous: 0 });
  return { ...result, overview: aggregateUsage(result.records, { days: 7 }, NOW) };
};

describe("native history/accounting join", () => {
  it("projects only a model from exact complete context without changing counters, time or original identities", () => {
    const original = stored({
      model_conflict: 0,
      usage: JSON.stringify({
        tokens: { inputTokens: 150, outputTokens: 15 },
        telemetryVersion: "codex-request-delta-v1",
      }),
    });
    const before = structuredClone(original);
    const result = merge([original], [cli({ partial: true })]);
    expect(result.records).toEqual([{ ...before, model: "actual-old" }]);
    expect(original).toEqual(before);
    expect(result.coverage).toMatchObject({
      matchedTurns: 0,
      overlappingRecords: 1,
      importedRecords: 0,
    });
    conservation(result);
    for (const candidate of [
      cli({ partial: true, complete: false }),
      cli({ partial: true, model: null }),
      cli({ partial: true, modelConflict: true }),
    ]) {
      expect(merge([original], [candidate]).records[0]?.model).toBeNull();
    }
    for (const model_conflict of [null, 1]) {
      expect(
        merge([{ ...original, model_conflict }], [cli({ partial: true })]).records[0]?.model,
      ).toBeNull();
    }
  });
  it("preserves original and cross-source model conflicts even when CLI fully replaces counts", () => {
    for (const original of [stored({ model_conflict: 1 }), stored({ model: "other-actual" })]) {
      const result = merge([original], [cli()]);
      expect(result.overview).toMatchObject({
        recordedTurns: 1,
        unknownModelTurns: 1,
        totals: { totalTokens: 110 },
      });
      conservation(result);
    }
  });
  it("excludes inflated unversioned Gram amounts when matching CLI identity coverage is incomplete", () => {
    const original = stored({ native_ids: '["wire-turn","missing-native-turn"]' });
    const before = JSON.stringify(original);
    const result = merge([original], [cli({ complete: false })]);
    expect(result.overview.totals.totalTokens).toBe(110);
    expect(result.coverage).toMatchObject({
      matchedTurns: 0,
      untrustedGramTurns: 1,
      importedRecords: 1,
    });
    expect(JSON.stringify(original)).toBe(before);
    expect(result.records.every((record) => !record.usage?.includes("1000100"))).toBe(true);
  });
  it("replaces a provably matched unversioned snapshot, including an actual zero, without mutating it", () => {
    const original = stored(),
      before = JSON.stringify(original);
    const result = merge([original], [cli({ tokens: { inputTokens: 0, outputTokens: 0 } })]);
    expect(result.overview).toMatchObject({ recordedTurns: 1, totals: { totalTokens: 0 } });
    expect(result.coverage).toMatchObject({
      matchedTurns: 1,
      importedRecords: 0,
      untrustedGramTurns: 0,
    });
    expect(JSON.stringify(original)).toBe(before);
  });
  it("requires provider AND captured session, never naked native IDs or current thread state", () => {
    for (const source_session of [null, "different-session"]) {
      const result = merge([stored({ source_session })], [cli()]);
      expect(result.coverage.matchedTurns).toBe(0);
      expect(result.overview.totals.totalTokens).toBe(110);
      expect(result.coverage.untrustedGramTurns).toBe(1);
    }
    expect(
      merge([stored({ agent: "claude", source_session: "wire-session" })], [cli()]).coverage
        .matchedTurns,
    ).toBe(0);
  });
  it("retains proven normalized Gram accounting for incomplete overlap and suppresses its CLI part", () => {
    const usage = JSON.stringify({
      tokens: { inputTokens: 150, outputTokens: 15 },
      telemetryVersion: "codex-request-delta-v1",
    });
    const result = merge([stored({ usage, native_ids: '["wire-turn","other-turn"]' })], [cli()]);
    expect(result.overview.totals.totalTokens).toBe(165);
    expect(result.coverage).toMatchObject({
      matchedTurns: 0,
      importedRecords: 0,
      untrustedGramTurns: 0,
    });
  });
  it("deduplicates native-ID arrays, and excludes competing Gram claims of the same native turn", () => {
    expect(
      merge([stored({ native_ids: '["wire-turn","wire-turn"]' })], [cli()]).overview.totals
        .totalTokens,
    ).toBe(110);
    const result = merge([stored(), stored({ id: "different-gram-turn" })], [cli()]);
    expect(result.overview.totals.totalTokens).toBe(110);
    expect(result.coverage.untrustedGramTurns).toBe(2);
  });
  it("rejects conflicting source/session collisions and counts identical copied files once", () => {
    expect(merge([], [cli(), cli()]).overview.totals.totalTokens).toBe(110);
    const result = merge([], [cli(), cli({ model: "conflicting-model" })]);
    expect(result.overview.totals.totalTokens).toBe(0);
    expect(result.coverage.ambiguousRecords).toBe(1);
    expect(merge([], [cli(), cli({ session: "other-session" })]).overview.totals.totalTokens).toBe(
      220,
    );
  });
  it("excludes inherited fork IDs using the actual parent and keeps new child turns", () => {
    const inherited = cli({ session: "child", parent: "wire-session" });
    const fresh = cli({
      session: "child",
      parent: "wire-session",
      id: "new-turn",
      nativeIds: ["new-turn"],
    });
    expect(merge([], [cli(), inherited, fresh]).overview.totals.totalTokens).toBe(220);
    const unavailableParent = merge([], [fresh]);
    expect(unavailableParent.overview.totals.totalTokens).toBe(0);
    expect(unavailableParent.coverage.ambiguousRecords).toBe(1);
  });
  it("keeps a fully covered mixed-model MAIN group Unknown and aggregates its turn once", () => {
    const a = cli({ provider: "claude", id: "request-one", nativeIds: ["uuid-one"] });
    const b = cli({
      provider: "claude",
      id: "request-two",
      nativeIds: ["uuid-two"],
      model: "actual-new",
    });
    const result = merge(
      [stored({ agent: "claude", native_ids: '["uuid-one","uuid-two"]' })],
      [a, b],
    );
    expect(result.overview).toMatchObject({
      recordedTurns: 1,
      unknownModelTurns: 1,
      totals: { totalTokens: 220 },
    });
    expect(result.overview.rows[0]?.model).toBeNull();
  });
});

const validClaude = (overrides: Partial<UsageRecord> = {}) =>
  stored({
    agent: "claude",
    usage: JSON.stringify({ tokens: { inputTokens: 7, outputTokens: 2 } }),
    ...overrides,
  });
const claude = (overrides: Partial<HistoryRecord> = {}) =>
  cli({ provider: "claude", nativeIds: ["cli-uuid"], ...overrides });
const conservation = (result: ReturnType<typeof mergeHistoryUsage>) => {
  const c = result.coverage;
  expect(c.selectedGramTurns).toBe(
    c.matchedTurns + c.unmatchedGramTurns + c.untrustedGramTurns + c.ambiguousGramTurns,
  );
  expect(c.historyRecords).toBe(
    c.importedRecords +
      c.matchedRecords +
      c.overlappingRecords +
      c.duplicateRecords +
      c.omittedRecords +
      c.coalescedRecords +
      c.supersededRecords,
  );
};
describe("identity completeness and coverage partitions", () => {
  it("preserves valid unscoped Claude amounts with provable UUID non-overlap among complete records", () => {
    const result = merge(
      [validClaude({ source_session: null, native_ids: '["gram-uuid"]' })],
      [claude()],
    );
    expect(result.overview.totals.totalTokens).toBe(119);
    expect(result.coverage).toMatchObject({
      unmatchedGramTurns: 1,
      ambiguousGramTurns: 0,
      untrustedGramTurns: 0,
    });
    conservation(result);
  });
  it.each([undefined, null, "wire-session"])(
    "does not use incomplete UUID records as negative evidence for scope %s",
    (source_session) => {
      const result = merge(
        [validClaude({ source_session: source_session ?? null, native_ids: '["gram-uuid"]' })],
        [claude({ nativeIds: [], complete: false })],
      );
      expect(result.overview.totals.totalTokens).toBe(110);
      expect(result.coverage).toMatchObject({
        ambiguousGramTurns: 1,
        untrustedGramTurns: 0,
        importedRecords: 1,
      });
      conservation(result);
    },
  );
  it("does not manufacture non-overlap from truncated/skipped/corrupt sources", () => {
    const result = mergeHistoryUsage(
      [validClaude({ source_session: null, native_ids: '["gram-uuid"]' })],
      {
        records: [claude()],
        sources: [
          { provider: "claude", status: "partial", files: 1, skippedFiles: 1, invalidLines: 1 },
        ],
        ambiguous: 0,
      },
    );
    expect(result.coverage.ambiguousGramTurns).toBe(1);
    expect(aggregateUsage(result.records, { days: 7 }, NOW).totals.totalTokens).toBe(110);
    conservation(result);
  });
  it("never replaces the same UUID captured in another session", () => {
    const result = merge(
      [validClaude({ source_session: "original-session", native_ids: '["cli-uuid"]' })],
      [claude()],
    );
    expect(result.coverage).toMatchObject({ matchedTurns: 0, unmatchedGramTurns: 1 });
    expect(result.overview.totals.totalTokens).toBe(119);
    conservation(result);
  });
  it("retains partial validated last requests but does not trust the last-request marker without partial", () => {
    for (const partial of [true, false]) {
      const result = merge(
        [
          stored({
            usage: JSON.stringify({
              tokens: { inputTokens: 7, outputTokens: 2 },
              telemetryVersion: "codex-last-request-v1",
              partial,
            }),
            native_ids: '["other-turn"]',
          }),
        ],
        [cli()],
      );
      expect(result.coverage.untrustedGramTurns).toBe(partial ? 0 : 1);
      conservation(result);
    }
  });
  it("counts replay copies once and preserves both conservation equations for conflicts/groups", () => {
    for (const records of [
      [cli(), cli()],
      [cli(), cli({ model: "conflict" })],
      [
        cli({
          id: "response:a",
          turn: "wire-turn",
          turnComplete: true,
          expectedTurnTokens: {
            inputTokens: 200,
            outputTokens: 20,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        }),
        cli({
          id: "response:b",
          turn: "wire-turn",
          turnComplete: true,
          expectedTurnTokens: {
            inputTokens: 200,
            outputTokens: 20,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        }),
        cli(),
      ],
    ]) {
      const result = merge([stored()], records);
      conservation(result);
    }
  });
});

it("does not add an id-less partial copy to an identified request from the same original session", () => {
  const original = cli({ fileIdentity: "device:original" });
  const copy = cli({
    fileIdentity: "device:partial-copy",
    id: "request-1",
    nativeIds: [],
    complete: false,
  });
  const result = merge([], [original, copy]);
  expect(result.overview.totals.totalTokens).toBe(110);
  expect(result.coverage).toMatchObject({
    importedRecords: 1,
    omittedRecords: 1,
    ambiguousRecords: 1,
  });
  conservation(result);
  const soleSource = merge([], [copy]);
  expect(soleSource.overview.totals.totalTokens).toBe(110);
  expect(soleSource.overview.partialUsageTurns).toBe(1);
});
