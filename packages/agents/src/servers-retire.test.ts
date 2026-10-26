import { describe, expect, it } from "@effect/vitest";
import type { GatewayProfile, ProfileId } from "@gram/contracts";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import { CodexServers, CodexServersLive } from "./codex/servers.ts";
import { GatewayKeyProvider } from "./gateway.ts";
import { acquireHeld, type Retainable } from "./servers-hold.ts";

const profile: GatewayProfile = {
  id: "team" as ProfileId,
  name: "Team",
  baseURL: "http://127.0.0.1:9/v1",
  keyRef: "profile:team",
  models: [],
};

const keys = Layer.succeed(GatewayKeyProvider)({
  credentials: () => Effect.succeed({ profile, key: Redacted.make("gram-test-key") }),
});

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Polls `probe` every 50 ms until it returns a value, dying after 10 s. */
const poll = <A>(what: string, probe: () => A | undefined) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const value = probe();
      if (value !== undefined) return value;
      yield* Effect.sleep(50);
    }
    return yield* Effect.die(new Error(`timed out waiting for ${what}`));
  });

const exited = (pid: number) =>
  poll(`process ${pid} to exit`, () => (isAlive(pid) ? undefined : true));

/**
 * A fake Codex binary in `dir` that records each server's pid; `app-server` answers every JSON-RPC
 * request with an empty result.
 */
const writeFakeBinary = (dir: string) => {
  const pidFile = join(dir, "servers.pid");
  const binary = join(dir, "agent");
  writeFileSync(
    binary,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("0.0.0"); process.exit(0); }
fs.appendFileSync(${JSON.stringify(pidFile)}, process.pid + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined && message.method !== undefined) {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
  }
});
`,
  );
  chmodSync(binary, 0o755);
  // A login shell that counts its probes, then runs them as `sh` would.
  const probeFile = join(dir, "probes");
  const shell = join(dir, "shell");
  writeFileSync(
    shell,
    `#!/bin/sh\necho probe >> ${JSON.stringify(probeFile)}\nexec /bin/sh "$@"\n`,
  );
  chmodSync(shell, 0o755);
  const probes = () =>
    existsSync(probeFile) ? readFileSync(probeFile, "utf8").trim().split("\n").length : 0;
  const pids = (count: number) =>
    poll(`${count} server pids`, () => {
      const lines = existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim().split("\n") : [];
      return lines.length >= count ? lines.map(Number) : undefined;
    });
  return { binary, shell, pids, probes };
};

/** The part of `CodexServers` under test. */
interface RetiringServers {
  readonly acquire: (profileId: ProfileId | undefined) => Effect.Effect<Retainable, unknown>;
  readonly invalidate: (profileId: ProfileId) => Effect.Effect<void>;
  readonly retire: (profileId: ProfileId | undefined) => Effect.Effect<void>;
  readonly retireAll: Effect.Effect<void>;
}

/** Runs `body` against a fresh server manager for `adapter`, on a fake binary in a temp dir. */
const withServers = <A>(
  _adapter: "codex",
  body: (
    servers: RetiringServers,
    pids: (count: number) => Effect.Effect<Array<number>>,
    probes: () => number,
  ) => Effect.Effect<A, unknown>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "gram-servers-retire-"))),
    (dir) => {
      const { binary, shell, pids, probes } = writeFakeBinary(dir);
      const config = { binaryPath: binary, shell };
      return Effect.gen(function* () {
        const servers = yield* CodexServers;
        return yield* body(
          {
            acquire: (profileId) => servers.acquire(profileId, "gateway"),
            invalidate: servers.invalidate,
            retire: servers.retire,
            retireAll: servers.retireAll,
          },
          pids,
          probes,
        );
      }).pipe(Effect.provide(CodexServersLive(config).pipe(Layer.provide(keys))));
    },
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  );

describe.skipIf(process.platform === "win32")("servers.invalidate and retain", () => {
  for (const adapter of ["codex"] as const) {
    it.live(
      `${adapter}: a retired server stops only after its last session releases it`,
      () =>
        withServers(adapter, (servers, pids) =>
          Effect.gen(function* () {
            const first = yield* servers.acquire(profile.id);
            const sessionA = yield* Scope.make();
            const sessionB = yield* Scope.make();
            yield* first.retain.pipe(Effect.provideService(Scope.Scope, sessionA));
            yield* first.retain.pipe(Effect.provideService(Scope.Scope, sessionB));

            yield* servers.invalidate(profile.id);
            const second = yield* servers.acquire(profile.id);
            expect(second).not.toBe(first);
            const [oldPid = 0, newPid = 0] = yield* pids(2);
            expect(newPid).not.toBe(oldPid);
            expect(isAlive(oldPid)).toBe(true);

            yield* Scope.close(sessionA, Exit.void);
            yield* Effect.sleep(200);
            expect(isAlive(oldPid)).toBe(true);

            yield* Scope.close(sessionB, Exit.void);
            yield* exited(oldPid);
            expect(isAlive(newPid)).toBe(true);
            expect(yield* servers.acquire(profile.id)).toBe(second);
          }),
        ),
      30_000,
    );

    it.live(
      `${adapter}: retiring every server for a new executable spares the sessions on the old one`,
      () =>
        withServers(adapter, (servers, pids) =>
          Effect.gen(function* () {
            const first = yield* servers.acquire(profile.id);
            const session = yield* Scope.make();
            yield* first.retain.pipe(Effect.provideService(Scope.Scope, session));

            yield* servers.retireAll;
            const second = yield* servers.acquire(profile.id);
            expect(second).not.toBe(first);
            const [oldPid = 0, newPid = 0] = yield* pids(2);
            yield* Effect.sleep(200);
            expect(isAlive(oldPid)).toBe(true);

            yield* Scope.close(session, Exit.void);
            yield* exited(oldPid);
            expect(isAlive(newPid)).toBe(true);
          }),
        ),
      30_000,
    );

    it.live(
      `${adapter}: a session whose server is invalidated before it holds it opens on the fresh one`,
      () =>
        withServers(adapter, (servers, pids) =>
          Effect.gen(function* () {
            const stale = yield* servers.acquire(profile.id);
            const [stalePid = 0] = yield* pids(1);
            // The key rotates after the session's `acquire` returned, before its hold.
            yield* servers.invalidate(profile.id);
            yield* exited(stalePid);

            const session = yield* Scope.make();
            expect(yield* stale.retain.pipe(Effect.provideService(Scope.Scope, session))).toBe(
              false,
            );
            let acquires = 0;
            const acquire = Effect.suspend(() =>
              acquires++ === 0 ? Effect.succeed(stale) : servers.acquire(profile.id),
            );
            const held = yield* acquireHeld(acquire).pipe(
              Effect.provideService(Scope.Scope, session),
            );
            expect(held).not.toBe(stale);
            expect(acquires).toBe(2);
            const [, freshPid = 0] = yield* pids(2);
            expect(isAlive(freshPid)).toBe(true);

            // The fresh server is really held: invalidating it waits for the session to close.
            yield* servers.invalidate(profile.id);
            yield* Effect.sleep(200);
            expect(isAlive(freshPid)).toBe(true);
            yield* Scope.close(session, Exit.void);
            yield* exited(freshPid);
          }),
        ),
      30_000,
    );

    it.live(
      `${adapter}: a thread's restart retires its own configuration's server and spares a profile's`,
      () =>
        withServers(adapter, (servers, pids, probes) =>
          Effect.gen(function* () {
            const own = yield* servers.acquire(undefined);
            const team = yield* servers.acquire(profile.id);
            const other = yield* Scope.make();
            yield* own.retain.pipe(Effect.provideService(Scope.Scope, other));
            const [ownPid = 0, teamPid = 0] = yield* pids(2);

            const probed = probes();
            expect(probed).toBeGreaterThan(0);
            yield* servers.retire(undefined);
            const fresh = yield* servers.acquire(undefined);
            // The login shell is asked again, for an export or a PATH changed since.
            expect(probes()).toBeGreaterThan(probed);
            expect(fresh).not.toBe(own);
            expect(yield* servers.acquire(profile.id)).toBe(team);
            const [, , freshPid = 0] = yield* pids(3);
            // Another thread still on the old server keeps it until its session closes.
            yield* Effect.sleep(200);
            expect(isAlive(ownPid)).toBe(true);
            yield* Scope.close(other, Exit.void);
            yield* exited(ownPid);
            expect(isAlive(freshPid)).toBe(true);
            expect(isAlive(teamPid)).toBe(true);
          }),
        ),
      30_000,
    );

    it.live(
      `${adapter}: an unused server stops as soon as it's invalidated`,
      () =>
        withServers(adapter, (servers, pids) =>
          Effect.gen(function* () {
            yield* servers.acquire(profile.id);
            const [pid = 0] = yield* pids(1);
            yield* servers.invalidate(profile.id);
            yield* exited(pid);
          }),
        ),
      30_000,
    );
  }
});

describe.skipIf(process.platform === "win32")("codex: a managed runtime", () => {
  it.live(
    "holds its version while the app-server runs, and starts again from the previous one after a rollback",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), "gram-servers-managed-"))),
        (dir) =>
          Effect.gen(function* () {
            const good = writeFakeBinary(dir);
            const broken = join(dir, "broken");
            writeFileSync(broken, "#!/bin/sh\nexit 3\n");
            chmodSync(broken, 0o755);
            const events: Array<string> = [];
            let selected = broken;
            const runtime = {
              resolve: Effect.sync(() => {
                const path = selected;
                const name = path === broken ? "broken" : "good";
                events.push(`hold ${name}`);
                return {
                  path,
                  version: "0.159.2",
                  release: () => void events.push(`release ${name}`),
                  started: Effect.sync(() => void events.push(`started ${name}`)),
                  failed: () =>
                    Effect.sync(() => {
                      events.push(`failed ${name}`);
                      selected = good.binary;
                      return true;
                    }),
                };
              }),
            };
            yield* Effect.gen(function* () {
              const servers = yield* CodexServers;
              const server = yield* servers.acquire(undefined, "user");
              const session = yield* Scope.make();
              yield* server.retain.pipe(Effect.provideService(Scope.Scope, session));
              const [pid = 0] = yield* good.pids(1);
              expect(events).toEqual([
                "hold broken",
                "release broken",
                "failed broken",
                "hold good",
                "started good",
              ]);
              // Retired by an update, it keeps its version until its session closes.
              yield* servers.retireAll;
              yield* Effect.sleep(200);
              expect(events).not.toContain("release good");
              yield* Scope.close(session, Exit.void);
              yield* exited(pid);
              yield* poll("the hold to go", () =>
                events.includes("release good") ? true : undefined,
              );
            }).pipe(
              Effect.provide(
                CodexServersLive({ shell: "/bin/sh", runtime }).pipe(Layer.provide(keys)),
              ),
            );
          }),
        (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
      ),
    30_000,
  );
});
