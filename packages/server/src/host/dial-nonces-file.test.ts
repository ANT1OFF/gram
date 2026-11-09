import type * as Fs from "node:fs";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  CONNECT_SKEW_MS,
  generateHostKey,
  hostIdOf,
  privateKeyFrom,
  signedConnectHeaders,
} from "./machine-keys.ts";
import { createPairedMachines, fileMachineStore, fileNonceStore } from "./paired-machines.ts";

/** Whether setting a file's times fails, as a fault between writing and stamping would. */
const fault = vi.hoisted(() => {
  const state = { stamp: false };
  const failing =
    <A extends unknown[]>(real: (...args: A) => void) =>
    (...args: A) => {
      if (state.stamp) throw new Error("synthetic stamp failure");
      real(...args);
    };
  return Object.assign(state, { failing });
});
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof Fs>();
  return {
    ...fs,
    futimesSync: fault.failing(fs.futimesSync),
    lutimesSync: fault.failing(fs.lutimesSync),
  };
});

const ORIGIN = "https://main.example-tailnet.ts.net";
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gram-dial-nonces-"));
});
afterEach(() => {
  fault.stamp = false;
  rmSync(dir, { recursive: true, force: true });
});

// Third re-check of #324: the nonce file replaced the old one before its time was stamped, so a
// stamp that failed after a clock was set back left it with the lower time; with its content
// then unreadable, the bound came from that time and a dial the last run took was taken again.
it("never lowers the nonce file's time through a write that fails", () => {
  // Two minutes ahead of the filesystem's own clock, which a replaced file's time comes from, in
  // whole seconds, as some filesystems keep.
  const start = Math.floor(Date.now() / 1000) * 1000 + 2 * CONNECT_SKEW_MS;
  let time = start;
  const now = () => time;
  const machines = createPairedMachines(fileMachineStore(dir), now, fileNonceStore(dir));
  const key = generateHostKey();
  const id = hostIdOf(key.publicKey);
  const code = new URLSearchParams(new URL(machines.mint(ORIGIN).url).hash.slice(1)).get("code")!;
  machines.join(ORIGIN, { code, name: "box", platform: "linux", ...key });
  machines.confirm(id);
  const own = privateKeyFrom(key.privateKeyPem);
  const ahead = signedConnectHeaders(own, ORIGIN, id, start + CONNECT_SKEW_MS);
  expect(machines.authorizeConnect(ORIGIN, ahead).kind).toBe("ok");

  time = start - 60_000;
  fault.stamp = true;
  const fresh = signedConnectHeaders(own, ORIGIN, id, time);
  expect(machines.authorizeConnect(ORIGIN, fresh)).toMatchObject({ status: 503 });
  fault.stamp = false;
  const file = join(dir, "remote-access", "dial-nonces.json");
  expect(statSync(file).mtimeMs).toBeGreaterThanOrEqual(start);

  // Its content lost, its time kept.
  const { mtime } = statSync(file);
  writeFileSync(file, "{");
  utimesSync(file, mtime, mtime);
  // Restarted while the clock is still set back, then replayed once it is right again.
  const after = createPairedMachines(fileMachineStore(dir), now, fileNonceStore(dir));
  time = start;
  expect(after.authorizeConnect(ORIGIN, ahead)).toMatchObject({ kind: "refused" });
});
