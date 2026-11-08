import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect, type Socket as NetSocket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { HOST_PROTOCOL_VERSION, type HostHello, LOCAL_HOST_ID } from "@gram/contracts";
import { Proc, ProcLive } from "@gram/git";
import * as Effect from "effect/Effect";
import { filesOn } from "./files.ts";
import { connectHost, scanFromWire, scanToWire, serveHost, type HostService } from "./protocol.ts";
import type { PortScan } from "../ports/scan.ts";

/** Two ends of one local stream: the host's and the control plane's. */
const streamPair = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ host: NetSocket; control: NetSocket; dir: string }>((resolve, reject) => {
        const dir = mkdtempSync(join(tmpdir(), "gram-host-protocol-"));
        const path = join(dir, "s");
        const server = createServer((host) => {
          server.close();
          resolve({ host, control, dir });
        });
        server.once("error", reject);
        let control: NetSocket;
        server.listen(path, () => {
          control = connect(path);
        });
      }),
  ),
  ({ host, control, dir }) =>
    Effect.sync(() => {
      host.destroy();
      control.destroy();
      rmSync(dir, { recursive: true, force: true });
    }),
);

const SCAN: PortScan = {
  listening: new Map([[41, [5173, 5174]]]),
  children: new Map([[1, [41]]]),
  processes: new Map([
    [1, { pid: 1, ppid: 0, command: "zsh" }],
    [41, { pid: 41, ppid: 1, pgid: 41, tpgid: 41, command: "vite" }],
  ]),
};

const hello = (overrides: Partial<HostHello> = {}): HostHello => ({
  protocol: HOST_PROTOCOL_VERSION,
  hostId: LOCAL_HOST_ID,
  capabilities: ["files", "ports"],
  platform: process.platform,
  pid: 4242,
  ...overrides,
});

/** A host served on one end of a fresh stream, and the control plane's connection to it. */
const connected = (overrides: Partial<HostHello> = {}) =>
  Effect.gen(function* () {
    const { host, control } = yield* streamPair;
    const service: HostService = {
      hello: hello(overrides),
      files: filesOn(yield* Proc),
      scan: Effect.succeed(SCAN),
    };
    yield* Effect.forkScoped(
      serveHost(yield* NodeSocket.fromDuplex(Effect.succeed(host)), service),
    );
    return yield* connectHost(yield* NodeSocket.fromDuplex(Effect.succeed(control)));
  });

describe("host protocol", () => {
  it("carries a port scan across the wire unchanged", () => {
    const back = scanFromWire(scanToWire(SCAN));
    expect([...back.listening]).toEqual([...SCAN.listening]);
    expect([...back.children]).toEqual([...SCAN.children]);
    expect([...back.processes!]).toEqual([...SCAN.processes!]);
  });

  it.effect("says hello, then lists a folder and scans ports through the host", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gram-host-files-"));
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
      writeFileSync(join(dir, "notes.md"), "# hello host\n");
      const host = yield* connected();
      expect(host.hello).toMatchObject({ protocol: HOST_PROTOCOL_VERSION, pid: 4242 });
      const listing = yield* host.files.list(dir, { showHidden: false, limit: 10 });
      expect(listing.entries.map((entry) => entry.name)).toEqual(["notes.md"]);
      const scan = yield* host.scan;
      expect(scan.listening.get(41)).toEqual([5173, 5174]);
      expect(scan.processes?.get(41)?.command).toBe("vite");
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );

  it.effect("keeps a host's refusal as the Files panel's own error, with its message", () =>
    Effect.gen(function* () {
      const host = yield* connected();
      const missing = yield* host.files
        .list("/nonexistent/gram-host-test", { showHidden: false, limit: 10 })
        .pipe(Effect.flip);
      expect(missing._tag).toBe("NotFound");
      const empty = yield* host.files
        .search(tmpdir(), "  ", { offset: 0, limit: 10 })
        .pipe(Effect.flip);
      expect(empty).toMatchObject({
        _tag: "InvalidState",
        message: "Enter something to search for",
      });
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );

  it.effect("refuses a host on another protocol version", () =>
    Effect.gen(function* () {
      const error = yield* connected({ protocol: HOST_PROTOCOL_VERSION + 1 }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "HostUnavailable" });
      expect(error.message).toContain(`protocol ${HOST_PROTOCOL_VERSION + 1}`);
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );

  it.effect("refuses a host that doesn't serve what this build needs", () =>
    Effect.gen(function* () {
      const error = yield* connected({ capabilities: ["files"] }).pipe(Effect.flip);
      expect(error.message).toContain("doesn't serve ports");
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );
});
