import { execFileSync } from "node:child_process";
import { mkdtempSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { nativeRecordStore } from "./native-record-store.ts";

const record = { schema: 1, from: "0.1.0-rc.17", to: "0.1.0-rc.18", at: 1_000 } as const;
const dir = () => mkdtempSync(join(tmpdir(), "gram-native-record-"));

describe("nativeRecordStore", () => {
  it("writes an owner-only record, reads it back and removes it", async () => {
    const store = nativeRecordStore(dir());
    expect(await store.read()).toBeUndefined();
    await store.write(record);
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
    expect(await store.read()).toEqual(record);
    await store.remove();
    expect(await store.read()).toBeUndefined();
  });

  it("reads nothing from a symlink, an oversized or a malformed file", async () => {
    const symlinked = nativeRecordStore(dir());
    const target = join(dir(), "elsewhere.json");
    writeFileSync(target, JSON.stringify(record));
    symlinkSync(target, symlinked.path);
    expect(await symlinked.read()).toBeUndefined();

    const big = nativeRecordStore(dir());
    writeFileSync(big.path, JSON.stringify({ ...record, pad: "x".repeat(5000) }));
    expect(await big.read()).toBeUndefined();

    const fifo = nativeRecordStore(dir());
    execFileSync("/usr/bin/mkfifo", [fifo.path]);
    expect(await fifo.read()).toBeUndefined();

    const malformed = nativeRecordStore(dir());
    writeFileSync(malformed.path, "not json");
    expect(await malformed.read()).toBeUndefined();
  });
});
