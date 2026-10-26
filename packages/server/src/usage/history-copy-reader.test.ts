import { expect, it } from "vitest";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalHistory } from "./history-canonical.ts";
import { makeHistoryReader } from "./history-reader.ts";

const c = (input_tokens: number) => ({ input_tokens, output_tokens: 0 });
const lines = (values: object[]) => values.map((value) => JSON.stringify(value) + "\n").join("");

for (const selected of [false, true])
  it(`four physical sources retain requirements through append and zero-byte refresh selected=${selected}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "gram-copy-requirements-"));
    const at = selected ? "2026-09-01T12:00:00Z" : "2026-10-06T12:00:00Z";
    const e = (type: string, payload: object) => ({ type, payload, timestamp: at });
    const response = (expected: number) =>
      e("token_usage_record", {
        thread_id: "owner",
        turn_id: "native",
        response_id: "r1",
        usage: c(10),
        turn_token_usage: c(expected),
      });
    try {
      for (let i = 0; i < 4; i++)
        await writeFile(
          join(dir, `rollout-${i}.jsonl`),
          lines([
            e("session_meta", { id: "owner" }),
            e("turn_context", { turn_id: "native", model: "actual" }),
            response(10),
            e("event_msg", { type: "task_complete", turn_id: "native" }),
          ]),
        );
      const reader = makeHistoryReader(),
        roots = [{ provider: "codex" as const, dir }],
        signal = new AbortController().signal;
      const window = {
        from: Date.parse("2026-10-05T00:00:00Z"),
        to: Date.parse("2026-10-12T00:00:00Z"),
      };
      const warm = await reader.scan(roots, signal, window);
      const warmRecords = [...canonicalHistory(warm.records, warm.provenance).unique.values()];
      expect(warmRecords).toHaveLength(selected ? 0 : 1);
      if (!selected) expect(warmRecords[0]!.complete).toBe(true);
      await appendFile(join(dir, "rollout-3.jsonl"), lines([response(20)]));
      const scans = [];
      for (let i = 0; i < 3; i++) scans.push(await reader.scan(roots, signal, window));
      expect(scans[0]!.work!.bytes).toBeGreaterThan(0);
      expect(scans[1]!.work!.bytes).toBe(0);
      expect(scans[2]!.work!.bytes).toBe(0);
      for (const scan of scans) {
        const records = [...canonicalHistory(scan.records, scan.provenance).unique.values()];
        expect(records).toHaveLength(selected ? 0 : 1);
        if (!selected) {
          expect(records[0]!.tokens.inputTokens).toBe(10);
          expect(records[0]!.complete).toBe(false);
          expect(records[0]!.at).toBe(Date.parse(at));
          expect(records[0]!.model).toBe("actual");
          expect(records[0]!.nativeIds).toEqual(["native"]);
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
