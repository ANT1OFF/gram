import { describe, expect, it } from "vitest";

import {
  judgeInstallRecord,
  NATIVE_RECORD_MAX_AGE_MS,
  parseInstallRecord,
  serializeInstallRecord,
} from "./native-record.ts";

const record = { schema: 1, from: "0.1.0-rc.17", to: "0.1.0-rc.18", at: 1_000_000 } as const;

describe("install record", () => {
  it("round-trips and refuses anything that isn't exactly a record", () => {
    expect(parseInstallRecord(serializeInstallRecord(record))).toEqual(record);
    for (const text of [
      "",
      "null",
      "[]",
      JSON.stringify({ ...record, schema: 2 }),
      JSON.stringify({ ...record, from: "latest" }),
      JSON.stringify({ ...record, to: 18 }),
      JSON.stringify({ ...record, at: "yesterday" }),
      JSON.stringify({ ...record, at: 1.5 }),
    ]) {
      expect(parseInstallRecord(text)).toBeUndefined();
    }
  });

  it("is applied when Gram now runs the version it restarted for", () => {
    expect(judgeInstallRecord(record, "0.1.0-rc.18", record.at + 5_000, "Log: x")).toEqual({
      kind: "applied",
    });
  });

  it("says the update wasn't applied when Gram came back on the old version", () => {
    expect(judgeInstallRecord(record, "0.1.0-rc.17", record.at + 5_000, "Log: x")).toEqual({
      kind: "notApplied",
      version: "0.1.0-rc.18",
      reason: "Gram restarted but macOS kept 0.1.0-rc.17. Log: x",
    });
  });

  it("ignores a record about another version or another week", () => {
    expect(judgeInstallRecord(record, "0.1.0-rc.20", record.at, "")).toEqual({ kind: "stale" });
    expect(
      judgeInstallRecord(record, "0.1.0-rc.17", record.at + NATIVE_RECORD_MAX_AGE_MS + 1, ""),
    ).toEqual({ kind: "stale" });
    expect(judgeInstallRecord(record, "0.1.0-rc.17", record.at - 120_000, "")).toEqual({
      kind: "stale",
    });
  });
});
