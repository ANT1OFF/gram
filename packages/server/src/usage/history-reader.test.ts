import { afterEach, describe, expect, it } from "vitest";
import { appendFile, link, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HISTORY_LIMITS, makeHistoryReader } from "./history-reader.ts";
import { usageHistoryRoots } from "./history-roots.ts";
import { JsonProjection } from "./json-projection.ts";
import { historyFields } from "./history-records.ts";
import { mergeHistoryUsage } from "./history-merge.ts";
import { aggregateUsage } from "./aggregate.ts";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const temp = async () => {
  const root = await mkdtemp(join(tmpdir(), "gram-usage-reader-offline-"));
  roots.push(root);
  return root;
};
const timestamp = "2026-10-06T12:00:00Z";
const assistant = (uuid = "uuid", input_tokens = 7, extra = {}) => ({
  type: "assistant",
  timestamp,
  sessionId: "session",
  uuid,
  requestId: uuid,
  message: {
    id: uuid,
    model: "actual-model",
    usage: {
      input_tokens,
      output_tokens: 2,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 3,
    },
    content: [{ text: "Invented private content" }],
  },
  ...extra,
});
const line = (value: unknown) => JSON.stringify(value) + "\n";
const rolloutLine = (type: string, payload: object) => line({ type, timestamp, payload });
const count = (input_tokens: number, output_tokens: number) => ({
  input_tokens,
  output_tokens,
});
const signal = () => new AbortController().signal;
const setup = async (text = line(assistant())) => {
  const root = await temp(),
    file = join(root, "history.jsonl");
  await writeFile(file, text);
  const configured = [{ provider: "claude" as const, dir: root }];
  return { root, file, configured };
};

const quota = (used_percent: number, eventTimestamp = "2026-10-06T12:00:00Z") =>
  line({
    type: "event_msg",
    timestamp: eventTimestamp,
    payload: {
      type: "token_count",
      info: null,
      rate_limits: {
        limit_id: "codex",
        primary: { used_percent, window_minutes: 300, resets_at: 1_791_300_000 },
        credits: { balance: "invented-private-credit-detail" },
        plan_type: "invented-private-plan",
      },
      content: "invented-private-event-content",
    },
  });

describe("local quota metadata projection", () => {
  const header = rolloutLine("session_meta", { id: "synthetic-quota-session" });
  it.each([
    { primary: { used_percent: { unexpected: 42 }, window_minutes: 300 } },
    { primary: { used_percent: "x".repeat(2048), window_minutes: 300 } },
    { primary: { used_percent: 42, window_minutes: 300, resets_at: { unexpected: 1 } } },
    { limit_id: { unexpected: "codex" } },
  ])(
    "keeps valid token accounting and subsequent native-turn continuity beside malformed quota case %#",
    async (rate_limits) => {
      const dir = await temp(),
        file = join(dir, "rollout-malformed-quota.jsonl");
      const token = (input_tokens: number, output_tokens: number, limits?: object) =>
        rolloutLine("event_msg", {
          type: "token_count",
          info: { total_token_usage: { input_tokens, output_tokens } },
          ...(limits === undefined ? {} : { rate_limits: limits }),
        });
      await writeFile(
        file,
        header +
          token(0, 0) +
          rolloutLine("turn_context", { turn_id: "first", model: "actual" }) +
          token(10, 2, rate_limits) +
          rolloutLine("event_msg", { type: "task_complete", turn_id: "first" }) +
          rolloutLine("turn_context", { turn_id: "second", model: "actual" }) +
          token(15, 3) +
          rolloutLine("event_msg", { type: "task_complete", turn_id: "second" }),
      );
      const reader = makeHistoryReader(),
        configured = [{ provider: "codex" as const, dir }];
      const first = await reader.scan(configured, signal());
      expect(first.records.map((record) => record.tokens)).toEqual([
        { inputTokens: 10, outputTokens: 2 },
        { inputTokens: 5, outputTokens: 1 },
      ]);
      expect(first.records.every((record) => record.complete && !record.partial)).toBe(true);
      expect(first.sources[0]).toMatchObject({ invalidLines: 0 });
      expect(first.localLimitHistory).toEqual({
        observations: [],
        invalidReadings: 1,
        truncated: false,
      });
      const again = await reader.scan(configured, signal());
      expect(again.records).toEqual(first.records);
      expect(again.localLimitHistory).toEqual(first.localLimitHistory);
      expect(again.work?.bytes).toBe(0);
    },
  );

  it("imports only quota fields across copies, refreshes, append tails, rewrites and deletion", async () => {
    const dir = await temp(),
      file = join(dir, "rollout-quota.jsonl"),
      copy = join(dir, "rollout-copy.jsonl");
    const first = quota(42);
    await writeFile(
      file,
      header +
        first +
        line({ type: "future_format", message: { content: "invented-private-message" } }) +
        line({
          type: "event_msg",
          payload: { type: "future_event", text: "invented-private-text" },
        }),
    );
    await writeFile(copy, header + first);
    const reader = makeHistoryReader(),
      configured = [{ provider: "codex" as const, dir }];
    const scan = () => reader.scan(configured, signal());
    const initial = await scan();
    expect(initial.localLimitHistory?.observations).toHaveLength(1);
    expect(initial.sources[0]).toMatchObject({ skippedLines: 2, invalidLines: 0 });
    expect(JSON.stringify(initial)).not.toMatch(/invented-private|balance|credits|plan_type/);
    expect((await scan()).work?.bytes).toBe(0);
    const next = quota(57, "2026-10-06T12:01:00Z");
    await appendFile(file, next.trimEnd());
    expect((await scan()).localLimitHistory?.observations).toHaveLength(1);
    await appendFile(file, "\n{bad}\n");
    const appended = await scan();
    expect(appended.localLimitHistory?.observations.map((sample) => sample.utilization)).toEqual([
      0.42, 0.57,
    ]);
    expect(appended.sources[0]).toMatchObject({
      skippedLines: 2,
      invalidLines: 1,
      status: "partial",
    });
    await writeFile(file, header + quota(61));
    await rm(copy);
    expect(
      (await scan()).localLimitHistory?.observations.map((sample) => sample.utilization),
    ).toEqual([0.61]);
    await rm(file);
    expect((await scan()).localLimitHistory?.observations).toEqual([]);
  });
  it("bounds quota metadata in both response admission and the incremental cache", async () => {
    const dir = await temp();
    await writeFile(join(dir, "rollout-quota.jsonl"), header + quota(42));
    const scan = await makeHistoryReader({ ...HISTORY_LIMITS, metadataBytes: 1 }).scan(
      [{ provider: "codex", dir }],
      signal(),
    );
    expect(scan.localLimitHistory).toMatchObject({ observations: [], truncated: true });
    expect(scan.sources[0]?.status).toBe("partial");
    expect(scan.work?.metadataBytes).toBe(0);
    expect(scan.work?.cacheMetadataBytes).toBe(0);
  });
});

describe("bounded local source reader", () => {
  it("retains native-turn partial evidence and rejects old-turn replay across incremental refreshes", async () => {
    const root = await temp(),
      file = join(root, "rollout-partial.jsonl");
    const token = (input: number, output: number, last?: object) =>
      rolloutLine("event_msg", {
        type: "token_count",
        info: { total_token_usage: count(input, output), last_token_usage: last },
      });
    const turn = (id: string, input: number, output: number) =>
      rolloutLine("turn_context", { turn_id: id, model: "actual" }) +
      token(input, output, count(10, 1)) +
      rolloutLine("event_msg", { type: "task_complete", turn_id: id });
    await writeFile(
      file,
      rolloutLine("session_meta", { id: "session" }) +
        rolloutLine("turn_context", { turn_id: "first", model: "actual" }) +
        token(100, 10) +
        token(110, 11, count(10, 1)) +
        rolloutLine("event_msg", { type: "task_complete", turn_id: "first" }),
    );
    const reader = makeHistoryReader(),
      configured = [{ provider: "codex" as const, dir: root }];
    const first = await reader.scan(configured, signal());
    expect(first.records[0]).toMatchObject({
      partial: true,
      tokens: { inputTokens: 10, outputTokens: 1 },
    });
    await appendFile(
      file,
      turn("second", 120, 12) + turn("first", 110, 11) + turn("third", 130, 13),
    );
    const next = await reader.scan(configured, signal());
    expect(next.sources[0]).toMatchObject({ status: "partial", invalidLines: 1 });
    expect(next.records.map((record) => record.tokens.inputTokens)).toEqual([10, 10, 10]);
    const merged = mergeHistoryUsage([], next);
    expect(
      aggregateUsage(merged.records, { days: 7 }, Date.parse("2026-10-12T12:00:00Z")).totals
        .totalTokens,
    ).toBe(33);
    expect(merged.coverage).toMatchObject({
      importedRecords: 3,
      historyRecords: 3,
      omittedRecords: 0,
    });
    expect(await reader.scan(configured, signal())).toMatchObject({
      sources: next.sources,
      records: next.records,
    });
  });
  it("projects only usage metadata, deduplicates roots, and never returns contents or paths", async () => {
    const { configured } = await setup();
    const result = await makeHistoryReader().scan([...configured, ...configured], signal());
    expect(result.records).toHaveLength(1);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ status: "available", files: 1 });
    expect(JSON.stringify(result)).not.toContain("Invented private content");
    expect(JSON.stringify(result)).not.toContain(configured[0]!.dir);
  });
  it("rescans append/tail updates without stale duplicates, then invalidates truncation and deletion", async () => {
    const { file, configured } = await setup();
    const reader = makeHistoryReader();
    expect((await reader.scan(configured, signal())).records).toHaveLength(1);
    await appendFile(file, line(assistant()) + JSON.stringify(assistant("next")));
    const partial = await reader.scan(configured, signal());
    expect(partial.records).toHaveLength(1);
    expect(partial.sources[0]?.status).toBe("partial");
    await appendFile(file, "\n" + line(assistant("third")));
    expect((await reader.scan(configured, signal())).records).toHaveLength(3);
    await writeFile(file, line(assistant("replacement", 1)));
    expect(
      (await reader.scan(configured, signal())).records.map((r) => r.tokens.inputTokens),
    ).toEqual([1]);
    await rm(file);
    expect((await reader.scan(configured, signal())).records).toEqual([]);
  });
  it("verifies the entire prior prefix before reusing an appended file", async () => {
    const { file, configured } = await setup(
      line(assistant("first", 7)) + line(assistant("last", 8)),
    );
    const reader = makeHistoryReader();
    await reader.scan(configured, signal());
    // Same-length rewrite at the first record, followed by an append; a tail-only guard would miss it.
    await writeFile(
      file,
      line(assistant("first", 9)) + line(assistant("last", 8)) + line(assistant("new", 1)),
    );
    expect(
      (await reader.scan(configured, signal())).records.map((r) => r.tokens.inputTokens),
    ).toEqual([9, 8, 1]);
  });
  it("rejects symlink roots, directory escapes and leaf escapes without reading the target", async () => {
    const { root, file, configured } = await setup();
    const outside = await temp();
    await writeFile(join(outside, "outside.jsonl"), line(assistant("outside")));
    await symlink(outside, join(root, "escape"));
    await symlink(join(outside, "outside.jsonl"), join(root, "leaf.jsonl"));
    const result = await makeHistoryReader().scan(configured, signal());
    expect(result.records.map((r) => r.nativeIds)).toEqual([["uuid"]]);
    expect(result.sources[0]).toMatchObject({ status: "partial", skippedFiles: 2 });
    await symlink(root, join(outside, "root-link"));
    const rejected = await makeHistoryReader().scan(
      [{ provider: "claude", dir: join(outside, "root-link") }],
      signal(),
    );
    expect(rejected.records).toEqual([]);
    expect(rejected.sources[0]?.status).toBe("partial");
    expect(file).toContain(root);
  });
  it("restricts file types and source lanes, including credential filenames and nested agents", async () => {
    const { root, configured } = await setup();
    // Invented poison files would add visible records if opened/parsed.
    for (const name of ["auth.json", "auth.jsonl", ".hidden.jsonl", "wrong.txt"])
      await writeFile(join(root, name), line(assistant(name)));
    for (const lane of ["subagents", "memory"]) {
      await mkdir(join(root, lane));
      await writeFile(join(root, lane, "nested.jsonl"), line(assistant(lane)));
    }
    expect((await makeHistoryReader().scan(configured, signal())).records).toHaveLength(1);
    expect(
      (await makeHistoryReader().scan([{ provider: "codex", dir: root }], signal())).records,
    ).toEqual([]);
  });
  it("reports unsupported compressed history and unresolved/missing roots truthfully", async () => {
    const { root, configured } = await setup();
    await writeFile(join(root, "rollout-old.jsonl.zst"), "Invented unsupported compressed data");
    const result = await makeHistoryReader().scan(
      [
        ...configured,
        { provider: "codex", dir: "", unresolved: true },
        { provider: "claude", dir: join(root, "missing") },
      ],
      signal(),
    );
    expect(result.sources.map((s) => s.status)).toEqual(["partial", "partial", "missing"]);
    expect(result.sources[0]?.skippedFiles).toBe(1);
  });
  it("discards oversized lines with bounded progress and parses subsequent valid records", async () => {
    const { configured } = await setup(
      line({ type: "user", content: "x".repeat(3000) }) + line(assistant()),
    );
    const reader = makeHistoryReader({ ...HISTORY_LIMITS, lineBytes: 1024, fileReadBytes: 1500 });
    const first = await reader.scan(configured, signal());
    expect(first.sources[0]?.status).toBe("partial");
    const second = await reader.scan(configured, signal());
    const third = await reader.scan(configured, signal());
    expect(
      [...first.records, ...second.records, ...third.records].some(
        (r) => r.model === "actual-model",
      ),
    ).toBe(true);
    expect(third.sources[0]?.invalidLines).toBe(1);
    expect(first.work!.bytes).toBeLessThanOrEqual(1500);
  });
  it("admits at most the record/metadata/file/entry budgets and marks omissions partial", async () => {
    const { root, configured } = await setup(line(assistant("one")) + line(assistant("two")));
    const limited = await makeHistoryReader({ ...HISTORY_LIMITS, records: 1 }).scan(
      configured,
      signal(),
    );
    expect(limited.records.length).toBeLessThanOrEqual(1);
    expect(limited.sources[0]?.status).toBe("partial");
    const metadata = await makeHistoryReader({ ...HISTORY_LIMITS, metadataBytes: 1 }).scan(
      configured,
      signal(),
    );
    expect(metadata.records).toEqual([]);
    expect(metadata.work!.metadataBytes).toBe(0);
    await writeFile(join(root, "second.jsonl"), line(assistant("three")));
    const files = await makeHistoryReader({ ...HISTORY_LIMITS, files: 1 }).scan(
      configured,
      signal(),
    );
    expect(files.sources[0]?.files).toBeLessThanOrEqual(1);
    expect(files.sources[0]?.status).toBe("partial");
    const entries = await makeHistoryReader({ ...HISTORY_LIMITS, entries: 1 }).scan(
      configured,
      signal(),
    );
    expect(entries.work!.entries).toBeLessThanOrEqual(2); // one observed sentinel, never opened
    expect(entries.sources[0]?.status).toBe("partial");
  });
  it("bounds bytes/time/depth and root work with an honest partial response", async () => {
    const { root, configured } = await setup();
    const bytes = await makeHistoryReader({ ...HISTORY_LIMITS, bytes: 10 }).scan(
      configured,
      signal(),
    );
    expect(bytes.work!.bytes).toBe(10);
    expect(bytes.sources[0]?.status).toBe("partial");
    const timed = await makeHistoryReader({ ...HISTORY_LIMITS, milliseconds: 0 }).scan(
      configured,
      signal(),
    );
    expect(timed.work!.bytes).toBe(0);
    expect(timed.sources[0]?.status).toBe("partial");
    await mkdir(join(root, "too-deep"));
    const deep = await makeHistoryReader({ ...HISTORY_LIMITS, depth: 0 }).scan(
      configured,
      signal(),
    );
    expect(deep.sources[0]?.status).toBe("partial");
    const extra = await temp();
    const capped = await makeHistoryReader({ ...HISTORY_LIMITS, roots: 1 }).scan(
      [...configured, { provider: "claude", dir: extra }],
      signal(),
    );
    expect(capped.sources).toHaveLength(1);
    expect(capped.sources[0]?.status).toBe("partial");
  });
  it("recovers after cancellation without retaining abandoned cached data", async () => {
    const { configured } = await setup();
    const reader = makeHistoryReader();
    await reader.scan(configured, signal());
    const controller = new AbortController();
    controller.abort(new Error("Invented cancellation"));
    await expect(reader.scan(configured, controller.signal)).rejects.toThrow(
      "Invented cancellation",
    );
    expect((await reader.scan(configured, signal())).records).toHaveLength(1);
  });
  it("filters timestamps without reading transcript content into the response", async () => {
    const { configured } = await setup();
    const reader = makeHistoryReader();
    const from = Date.parse("2026-10-07T00:00:00Z");
    expect(
      (await reader.scan(configured, signal(), { from, to: from + 86400000 })).records,
    ).toEqual([]);
    expect(
      (await reader.scan(configured, signal(), { from: from - 2 * 86400000, to: from + 86400000 }))
        .records,
    ).toHaveLength(1);
  });
});

describe("trusted home resolution", () => {
  it("uses only OS/configured absolute or home-relative locations and never a login shell", () => {
    const locations = usageHistoryRoots("/invented/home", "/invented/data", {
      CODEX_HOME: "~/custom-codex",
      CLAUDE_CONFIG_DIR: "/invented/claude",
    });
    expect(locations).toContainEqual({
      provider: "codex",
      dir: "/invented/home/custom-codex/sessions",
    });
    expect(locations).toContainEqual({
      provider: "codex",
      dir: "/invented/data/codex-home/archived_sessions",
    });
    for (const lane of ["sessions", "archived_sessions"]) {
      expect(locations).toContainEqual({
        provider: "codex",
        dir: `/invented/data/codex-owned-home/${lane}`,
      });
    }
    expect(locations).toContainEqual({ provider: "claude", dir: "/invented/claude/projects" });
    expect(
      usageHistoryRoots("/invented/home", "/invented/data", {
        CODEX_HOME: "relative",
        CLAUDE_CONFIG_DIR: "$(poison)",
      }).filter((r) => r.unresolved),
    ).toHaveLength(2);
    expect(locations.every((r) => !r.dir.includes("auth"))).toBe(true);
  });
});

const parse = (raw: string) => {
  const parser = new JsonProjection(historyFields);
  for (let offset = 0; offset < raw.length; offset += 17)
    parser.feed(raw.slice(offset, offset + 17));
  return parser.finish();
};
describe("streaming JSON projection", () => {
  it("validates skipped large Unicode strings without retaining them", () => {
    const data = {
      ...assistant(),
      prompt: "秘密🙂".repeat(100000),
      instructions: { text: "Invented system data" },
      tool_output: "x".repeat(10000),
    };
    expect(parse(JSON.stringify(data))).toEqual({
      type: "assistant",
      timestamp,
      sessionId: "session",
      uuid: "uuid",
      requestId: "uuid",
      message: { id: "uuid", model: "actual-model", usage: data.message.usage },
    });
  });
  it.each([
    '{"type":"assistant","type":"other"}',
    '{"message":{"model":[]}}',
    '{"type":"bad\\q"}',
    '{"ignored":"bad\\u0xx0"}',
    '{"ignored":"unescaped\nnewline"}',
    '{"type":true,}',
    '{"type":true}\u00a0',
    "[".repeat(65) + "0" + "]".repeat(65),
  ])("rejects malformed/oversized projection %s", (raw) => {
    expect(parse(raw)).toBeUndefined();
  });
  it("does not turn __proto__ source fields into object prototypes", () => {
    expect(parse('{"__proto__":{"type":"poison"},"type":"assistant"}')).toEqual({
      type: "assistant",
    });
    expect(Object.getPrototypeOf(parse('{"type":"assistant"}'))).toBeNull();
  });
});

const modernCounts = (input_tokens: number, output_tokens: number) => ({
  input_tokens,
  output_tokens,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  reasoning_output_tokens: 0,
});
const modernEvent = (type: string, payload: object) => ({ type, timestamp, payload });
it("reads modern Codex response records through the metadata projection and marks a corrupt tail incomplete", async () => {
  const root = await temp();
  const records = [
    modernEvent("session_meta", { id: "native-session" }),
    modernEvent("turn_context", { turn_id: "native-turn", model: "actual-context" }),
    modernEvent("token_usage_record", {
      thread_id: "native-session",
      turn_id: "native-turn",
      response_id: "response-one",
      usage: modernCounts(10, 1),
      turn_token_usage: modernCounts(10, 1),
      telemetryVersion: "codex-last-request-v1",
    }),
    modernEvent("event_msg", { type: "task_complete", turn_id: "native-turn" }),
  ];
  const file = join(root, "rollout-modern.jsonl");
  await writeFile(file, records.map(line).join(""));
  const configured = [{ provider: "codex" as const, dir: root }];
  const reader = makeHistoryReader();
  const data = await reader.scan(configured, signal());
  expect(data.records[0]).toMatchObject({
    basis: "delta",
    model: "actual-context",
    turnComplete: true,
    nativeIds: ["native-turn"],
    complete: true,
  });
  expect(data.sources[0]?.status).toBe("available");
  await appendFile(file, "{broken}\n");
  const corrupt = await reader.scan(configured, signal());
  expect(corrupt.records[0]?.complete).toBe(false);
  expect(corrupt.sources[0]).toMatchObject({ status: "partial", invalidLines: 1 });
});

it("charges replay state outside the date window to cache admission", async () => {
  const root = await temp(),
    file = join(root, "rollout-offline-replay.jsonl");
  const values = [
    { type: "session_meta", timestamp, payload: { id: "old-session" } },
    { type: "turn_context", timestamp, payload: { turn_id: "old-turn", model: "actual-old" } },
  ];
  for (let i = 1; i <= 30; i++)
    values.push({
      type: "event_msg",
      timestamp,
      payload: {
        type: "token_count",
        info: { total_token_usage: modernCounts(i, i), last_token_usage: modernCounts(1, 1) },
      },
    } as unknown as (typeof values)[number]);
  await writeFile(file, values.map(line).join(""));
  const configured = [{ provider: "codex" as const, dir: root }];
  const reader = makeHistoryReader({ ...HISTORY_LIMITS, metadataBytes: 1024 });
  const window = {
    from: Date.parse("2026-10-07T00:00:00Z"),
    to: Date.parse("2026-10-08T00:00:00Z"),
  };
  const first = await reader.scan(configured, signal(), window);
  expect(first.records).toEqual([]);
  expect(first.work!.cacheMetadataBytes).toBe(0);
  const refreshed = await reader.scan(configured, signal(), window);
  expect(refreshed.work!.bytes).toBeGreaterThan(0); // excessive replay state was evicted, not retained unseen
  expect(refreshed.work!.cacheMetadataBytes).toBeLessThanOrEqual(1024);
});

const counterSource = (
  session: string,
  native: string | undefined,
  at = timestamp,
  parent?: string,
) =>
  [
    {
      type: "session_meta",
      timestamp: at,
      payload: {
        id: session,
        ...(parent === undefined ? {} : { forked_from_id: parent }),
        fileIdentity: "provider-forged-origin",
      },
    },
    {
      type: "turn_context",
      timestamp: at,
      payload: { ...(native === undefined ? {} : { turn_id: native }), model: "actual-context" },
    },
    {
      type: "event_msg",
      timestamp: at,
      payload: {
        type: "token_count",
        info: { last_token_usage: modernCounts(10, 1), total_token_usage: modernCounts(10, 1) },
      },
    },
  ]
    .map(line)
    .join("");
const mergeScan = (scan: Awaited<ReturnType<ReturnType<typeof makeHistoryReader>["scan"]>>) => {
  const result = mergeHistoryUsage([], scan);
  return {
    ...result,
    overview: aggregateUsage(result.records, { days: 7 }, Date.parse("2026-10-12T12:00:00Z")),
  };
};

it("treats repeated roots and hardlinked/aliased idless files as one physical source, with stable cached identity", async () => {
  const root = await temp(),
    file = join(root, "rollout-original.jsonl");
  await writeFile(file, counterSource("same-session", undefined));
  await link(file, join(root, "rollout-hardlink.jsonl"));
  const configured = [
    { provider: "codex" as const, dir: root },
    { provider: "codex" as const, dir: join(root, ".") },
  ];
  const reader = makeHistoryReader();
  const first = await reader.scan(configured, signal());
  expect(first.sources).toHaveLength(1);
  expect(new Set(first.records.map((r) => r.fileIdentity)).size).toBe(1);
  expect(first.records[0]?.fileIdentity).toMatch(/^[a-f0-9]{64}$/);
  expect(first.records[0]?.fileIdentity).not.toBe("provider-forged-origin");
  expect(mergeScan(first)).toMatchObject({
    overview: { recordedTurns: 1, totals: { totalTokens: 11 } },
    coverage: { importedRecords: 1, duplicateRecords: 1, omittedRecords: 0 },
  });
  const cached = await reader.scan(configured, signal());
  expect(cached.work!.bytes).toBe(0);
  expect(mergeScan(cached)).toEqual(mergeScan(first));
});

it("exposes all physical idless-copy omissions and restores sole-source known contributions after deletion", async () => {
  const root = await temp();
  const first = join(root, "rollout-one.jsonl"),
    copy = join(root, "rollout-copy.jsonl");
  await writeFile(first, counterSource("same-session", undefined));
  await writeFile(copy, counterSource("same-session", undefined));
  const reader = makeHistoryReader(),
    configured = [{ provider: "codex" as const, dir: root }];
  const duplicate = mergeScan(await reader.scan(configured, signal()));
  expect(duplicate).toMatchObject({
    overview: { recordedTurns: 0 },
    coverage: { historyRecords: 2, importedRecords: 0, omittedRecords: 2, ambiguousRecords: 4 },
  });
  await rm(copy);
  expect(mergeScan(await reader.scan(configured, signal()))).toMatchObject({
    overview: { recordedTurns: 1, totals: { totalTokens: 11 } },
    coverage: { importedRecords: 1, omittedRecords: 0 },
  });
});

it("retains outside-window physical source identity so a restamped idless copy cannot manufacture non-overlap", async () => {
  const root = await temp();
  await writeFile(
    join(root, "rollout-original.jsonl"),
    counterSource("same-session", "old-native", "2026-09-01T12:00:00Z"),
  );
  await writeFile(
    join(root, "rollout-current-copy.jsonl"),
    counterSource("same-session", undefined),
  );
  const from = Date.parse("2026-10-05T12:00:00Z"),
    to = Date.parse("2026-10-12T12:00:00Z");
  const reader = makeHistoryReader(),
    configured = [{ provider: "codex" as const, dir: root }];
  const first = await reader.scan(configured, signal(), { from, to });
  expect(first.provenance).toHaveLength(2);
  expect(mergeScan(first)).toMatchObject({
    overview: { recordedTurns: 0 },
    coverage: { historyRecords: 1, omittedRecords: 1, importedRecords: 0 },
  });
  expect(mergeScan(await reader.scan(configured, signal(), { from, to }))).toEqual(
    mergeScan(first),
  );
});

it("does not infer new fork identity from missing/corrupt parent IDs outside the display window", async () => {
  const root = await temp();
  const parent = join(root, "rollout-parent.jsonl");
  const child = join(root, "rollout-child.jsonl");
  await writeFile(parent, counterSource("parent", undefined, "2026-09-01T12:00:00Z"));
  await writeFile(child, counterSource("child", "possibly-copied-turn", timestamp, "parent"));
  const reader = makeHistoryReader(),
    configured = [{ provider: "codex" as const, dir: root }];
  const window = {
    from: Date.parse("2026-10-05T12:00:00Z"),
    to: Date.parse("2026-10-12T12:00:00Z"),
  };
  const missing = await reader.scan(configured, signal(), window);
  expect(missing.provenance?.find((p) => p.session === "parent")?.complete).toBe(false);
  expect(mergeScan(missing).coverage).toMatchObject({ omittedRecords: 1, importedRecords: 0 });
  await writeFile(
    parent,
    counterSource("parent", "original-parent-turn", "2026-09-01T12:00:00Z") + "{corrupt}\n",
  );
  const corrupt = await reader.scan(configured, signal(), window);
  expect(corrupt.provenance?.find((p) => p.session === "parent")?.complete).toBe(false);
  expect(mergeScan(corrupt).coverage).toMatchObject({ omittedRecords: 1, importedRecords: 0 });
});
