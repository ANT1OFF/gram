import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import {
  HOST_PROTOCOL_VERSION,
  type HostFolderChecked,
  type HostId,
  InvalidState,
  NotFound,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { removeDir, tempDir } from "../git/test-repo.ts";
import { fingerprintOf, generateHostKey, hostIdOf } from "../host/machine-keys.ts";
import { memoryMachineStore } from "../host/paired-machines.ts";
import type { HostFolders } from "../host/folders.ts";
import { RemoteHosts } from "../host/remote-hosts.ts";
import { HttpServerRequest, HttpServerResponse } from "../platform/unstable.ts";
import {
  MACHINES_FOLDERS_BROWSE_PATH,
  MACHINES_FOLDERS_CHECK_PATH,
  MACHINES_LIST_PATH,
  MACHINES_SSH_JOIN_PATH,
  MACHINES_UPDATE_PATH,
  machineManagement,
} from "./machine-routes.ts";
import type { RemoteAccess } from "./remote-access.ts";

const ORIGIN = "https://studio.example-tailnet.ts.net";
const REMOTE = { host: "studio.example-tailnet.ts.net", origin: ORIGIN } as RemoteAccess;
const MOVED = `gram-host: This machine already joined ${ORIGIN}; moving its service to this app.`;

/** An `ssh` that records the script it was given and prints `say`. */
const fakeSsh = (dir: string, say: string) => {
  const path = join(dir, "ssh");
  writeFileSync(path, `#!/bin/sh\ncat >"${dir}/stdin"\ncat <<'SAID'\n${say}\nSAID\n`);
  chmodSync(path, 0o755);
  return path;
};

/** One POST from the local app, answered as the server answers it. */
const post = (
  hosts: RemoteHosts["Service"],
  path: string,
  body: unknown,
  options: {
    readonly remote?: RemoteAccess | undefined;
    readonly ssh?: string;
    readonly folders?: (id: HostId) => HostFolders;
  } = {},
) =>
  machineManagement(
    hosts,
    "remote" in options ? options.remote : REMOTE,
    path,
    "1.15.2",
    options.ssh,
    undefined,
    options.folders,
  ).pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(
        new Request(`http://127.0.0.1${path}`, {
          method: "POST",
          headers: {
            origin: "http://127.0.0.1",
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(JSON.stringify(body))),
          },
          body: JSON.stringify(body),
        }),
      ),
    ),
    Effect.map((response) => HttpServerResponse.toWeb(response)),
    Effect.flatMap((response) =>
      Effect.promise(async () => {
        const text = await response.text();
        let answer: Record<string, unknown>;
        try {
          answer = JSON.parse(text) as Record<string, unknown>;
        } catch {
          answer = { text };
        }
        return { status: response.status, body: answer };
      }),
    ),
  );

/** A machine joined with the link and confirmed, as the command joins one. */
const joined = (hosts: RemoteHosts["Service"], name = "cachyos") => {
  const key = generateHostKey();
  const code = new URLSearchParams(new URL(hosts.machines.mint(ORIGIN).url).hash.slice(1)).get(
    "code",
  )!;
  hosts.machines.join(ORIGIN, { code, name, platform: "linux", publicKey: key.publicKey });
  const id = hostIdOf(key.publicKey);
  hosts.machines.confirm(id);
  return { id, fingerprint: fingerprintOf(key.publicKey) };
};

/** Stands in for the machine's host: what it was asked, and its answers. */
const fakeFolders =
  (asked: Array<string>) =>
  (id: HostId): HostFolders => ({
    browse: (input, limit) =>
      Effect.sync(() => void asked.push(`${id} browse ${input} ${limit}`)).pipe(
        Effect.as({ path: "/home/dev", entries: [], truncated: false }),
      ),
    check: (path): Effect.Effect<HostFolderChecked, NotFound | InvalidState> => {
      asked.push(`${id} check ${path}`);
      if (path === "~/.ssh")
        return Effect.fail(
          new InvalidState({ message: "Gram doesn't run a chat in /home/dev/.ssh." }),
        );
      if (path === "~/gone")
        return Effect.fail(
          new NotFound({
            entity: "project",
            id: "/home/dev/gone",
            message: "Folder not found: /home/dev/gone",
          }),
        );
      return Effect.succeed({ path: "/home/dev/scratch" });
    },
  });

describe("a joined machine's folders, for the local app", () => {
  it.effect("are listed and checked by the machine's host, refusals as the contract's errors", () =>
    Effect.gen(function* () {
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      const { id } = joined(hosts);
      const asked: Array<string> = [];
      const folders = fakeFolders(asked);
      const listed = yield* post(
        hosts,
        MACHINES_FOLDERS_BROWSE_PATH,
        { id, path: "~/" },
        { folders },
      );
      expect(listed).toEqual({
        status: 200,
        body: { path: "/home/dev", entries: [], truncated: false },
      });
      const checked = yield* post(
        hosts,
        MACHINES_FOLDERS_CHECK_PATH,
        { id, path: "~/scratch" },
        { folders },
      );
      expect(checked).toEqual({ status: 200, body: { path: "/home/dev/scratch" } });
      expect(
        yield* post(hosts, MACHINES_FOLDERS_CHECK_PATH, { id, path: "~/.ssh" }, { folders }),
      ).toEqual({
        status: 422,
        body: { _tag: "InvalidState", message: "Gram doesn't run a chat in /home/dev/.ssh." },
      });
      expect(
        yield* post(hosts, MACHINES_FOLDERS_CHECK_PATH, { id, path: "~/gone" }, { folders }),
      ).toEqual({
        status: 404,
        body: {
          _tag: "NotFound",
          entity: "project",
          id: "/home/dev/gone",
          message: "Folder not found: /home/dev/gone",
        },
      });
      expect(asked).toEqual([
        `${id} browse ~/ 500`,
        `${id} check ~/scratch`,
        `${id} check ~/.ssh`,
        `${id} check ~/gone`,
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("answer nothing for a machine that isn't joined and confirmed", () =>
    Effect.gen(function* () {
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      const asked: Array<string> = [];
      const folders = fakeFolders(asked);
      const unknown = yield* post(
        hosts,
        MACHINES_FOLDERS_BROWSE_PATH,
        { id: "m-ffffffffffffffffffffffff", path: "~/" },
        { folders },
      );
      expect(unknown.status).toBe(404);
      const { id } = joined(hosts);
      expect((yield* post(hosts, MACHINES_FOLDERS_BROWSE_PATH, { id, path: "~/" })).status).toBe(
        404,
      );
      expect((yield* post(hosts, MACHINES_FOLDERS_CHECK_PATH, { id }, { folders })).status).toBe(
        400,
      );
      expect(asked).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

describe("Settings → Machines", () => {
  it.effect("lists this Gram's release and protocol, and the command that updates a machine", () =>
    Effect.gen(function* () {
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      joined(hosts);
      const on = yield* post(hosts, MACHINES_LIST_PATH, {});
      expect(on.body).toMatchObject({
        protocol: HOST_PROTOCOL_VERSION,
        release: "1.15.2",
        updateCommand: `curl -fsSL ${ORIGIN}/host/install | sh`,
        machines: [{ name: "cachyos", offline: { kind: "never" } }],
      });
      const off = yield* post(hosts, MACHINES_LIST_PATH, {}, { remote: undefined });
      expect(off.body).not.toHaveProperty("updateCommand");
      expect(off.body).toMatchObject({ machines: [{ offline: { kind: "tailscale-off" } }] });
    }).pipe(Effect.scoped),
  );

  it.effect("updates a machine over SSH only where Gram added it, and only that machine", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      const box = joined(hosts);
      const other = joined(hosts, "tower");

      // Joined by the command: Gram has nowhere to SSH to.
      const command = yield* post(hosts, MACHINES_UPDATE_PATH, { id: box.id });
      expect(command).toMatchObject({ status: 409, body: { reason: "not-ssh" } });
      expect((yield* post(hosts, MACHINES_UPDATE_PATH, { id: "m-nope" })).status).toBe(404);

      // Added over SSH again: its service moved, and the fingerprint it printed says which it was.
      const rejoin = yield* post(
        hosts,
        MACHINES_SSH_JOIN_PATH,
        { target: "me@cachyos" },
        { ssh: fakeSsh(dir, `${MOVED}\nFingerprint: ${box.fingerprint}`) },
      );
      expect(rejoin).toMatchObject({ status: 200, body: { joined: "rejoined" } });
      expect(hosts.machines.get(box.id)).toMatchObject({ sshTarget: "me@cachyos" });
      expect(hosts.machines.get(other.id)).not.toHaveProperty("sshTarget");

      // The update reruns the installer there, which only moves a joined machine's service.
      const updated = yield* post(
        hosts,
        MACHINES_UPDATE_PATH,
        { id: box.id },
        { ssh: fakeSsh(dir, `${MOVED}\nFingerprint: ${box.fingerprint}`) },
      );
      expect(updated).toMatchObject({ status: 200, body: { machines: expect.any(Array) } });
      const script = readFileSync(join(dir, "stdin"), "utf8");
      expect(script).toContain("UPDATE='1'");
      expect(script).toContain("LINK=''");
      expect(script).toContain("VERSION='1.15.2'");

      // Another machine answered at that address: nothing is taken for done.
      const elsewhere = yield* post(
        hosts,
        MACHINES_UPDATE_PATH,
        { id: box.id },
        { ssh: fakeSsh(dir, `${MOVED}\nFingerprint: ${other.fingerprint}`) },
      );
      expect(elsewhere.status).toBe(409);
      expect(String(elsewhere.body["message"])).toContain("didn't print cachyos's fingerprint");

      // Access over Tailscale off: no update.
      const off = yield* post(hosts, MACHINES_UPDATE_PATH, { id: box.id }, { remote: undefined });
      expect(off).toMatchObject({ status: 409, body: { reason: "tailscale-off" } });
    }).pipe(Effect.scoped),
  );
});
