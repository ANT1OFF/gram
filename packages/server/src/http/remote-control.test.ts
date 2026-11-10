import { afterAll, describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerConfig } from "../config.ts";
import { HttpServer } from "../platform/unstable.ts";
import { TEST_CONFIG } from "../runtime/test-harness.ts";
import {
  RECHECK_MS,
  RECOVERY_DELAYS_MS,
  RemoteControl,
  RemoteRefused,
  Tailscale,
  TailscaleMissing,
  type TailscaleRun,
  type TailscaleShape,
} from "./remote-control.ts";

const LOOPBACK = 4321;
const DNS = "mac.tail123.ts.net";
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const dataDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "gram-remote-control-"));
  dirs.push(dir);
  return dir;
};

interface Listener {
  proxy: string;
  funnel?: boolean;
  /** Extra path handlers beside `/`. */
  paths?: string[];
}

const ok = (stdout: string): TailscaleRun => ({ code: 0, stdout, stderr: "" });

/** A synthetic tailnet: one machine, its Serve listeners, and every CLI call made. */
const fakeTailscale = (
  options: {
    backend?: string;
    certs?: boolean;
    listeners?: Record<number, Listener>;
    missing?: boolean;
    refuseServe?: string;
    /** This machine's tailnet name; the default `DNS`. */
    dns?: string;
    /** How many `status` calls fail with no answer before they answer again. */
    statusFails?: number;
    /** How many `serve status` calls fail with no answer before they answer again. */
    serveStatusFails?: number;
  } = {},
) => {
  const listeners = new Map<number, Listener>(
    Object.entries(options.listeners ?? {}).map(([port, listener]) => [Number(port), listener]),
  );
  const calls: string[] = [];
  const shape: TailscaleShape = {
    run: (args) =>
      Effect.suspend(() => {
        calls.push(args.join(" "));
        if (options.missing) return Effect.fail(new TailscaleMissing());
        const dns = options.dns ?? DNS;
        if (args[0] === "status") {
          if ((options.statusFails ?? 0) > 0) {
            options.statusFails = (options.statusFails ?? 0) - 1;
            return Effect.succeed({ code: 1, stdout: "", stderr: "timed out" });
          }
          return Effect.succeed(
            ok(
              JSON.stringify({
                BackendState: options.backend ?? "Running",
                Self: { DNSName: `${dns}.` },
                CertDomains: options.certs === false ? null : [dns],
              }),
            ),
          );
        }
        if (args.join(" ") === "serve status --json" && (options.serveStatusFails ?? 0) > 0) {
          options.serveStatusFails = (options.serveStatusFails ?? 0) - 1;
          return Effect.succeed({ code: 1, stdout: "", stderr: "timed out" });
        }
        if (args.join(" ") === "serve status --json")
          return Effect.succeed(
            ok(
              JSON.stringify({
                TCP: Object.fromEntries([...listeners.keys()].map((p) => [p, { HTTPS: true }])),
                Web: Object.fromEntries(
                  [...listeners].map(([p, l]) => [
                    `${dns}:${p}`,
                    {
                      Handlers: {
                        "/": { Proxy: l.proxy },
                        ...Object.fromEntries(
                          (l.paths ?? []).map((path) => [path, { Path: "/srv" }]),
                        ),
                      },
                    },
                  ]),
                ),
                AllowFunnel: Object.fromEntries(
                  [...listeners].filter(([, l]) => l.funnel).map(([p]) => [`${dns}:${p}`, true]),
                ),
              }),
            ),
          );
        const https = args.find((arg) => arg.startsWith("--https="));
        const port = Number(https?.slice("--https=".length));
        if (args[0] === "serve" && args.at(-1) === "off") {
          listeners.delete(port);
          return Effect.succeed(ok(""));
        }
        if (args[0] === "serve" && args[1] === "--bg") {
          if (options.refuseServe !== undefined)
            return Effect.succeed({ code: 1, stdout: options.refuseServe, stderr: "" });
          listeners.set(port, { proxy: args.at(-1)! });
          return Effect.succeed(ok(""));
        }
        return Effect.succeed({ code: 1, stdout: "", stderr: "unknown" });
      }),
  };
  return { shape, listeners, calls };
};

const control = (
  tailscale: TailscaleShape,
  dir: string,
  loopback = LOOPBACK,
  remoteOrigin?: string,
) =>
  RemoteControl.layer.pipe(
    Layer.provide(Layer.succeed(Tailscale, tailscale)),
    Layer.provide(
      ServerConfig.layer({
        ...TEST_CONFIG,
        dataDir: dir,
        ...(remoteOrigin ? { remoteOrigin } : {}),
      }),
    ),
    Layer.provide(
      Layer.succeed(HttpServer.HttpServer, {
        address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: loopback },
      } as unknown as HttpServer.HttpServer["Service"]),
    ),
  );

const settled = Effect.gen(function* () {
  // Startup re-points Serve in the background; enable waits its turn on the same lock.
  for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
});

describe("phone access switched from Settings", () => {
  it.effect("turns on with Gram's own HTTPS listener on 9443, and off again", () =>
    Effect.gen(function* () {
      const tailnet = fakeTailscale({ listeners: { 443: { proxy: "http://127.0.0.1:3000" } } });
      const dir = dataDir();
      yield* Effect.gen(function* () {
        const remote = yield* RemoteControl;
        expect(yield* remote.status).toEqual({
          mode: "off",
          tailscale: { state: "ready", dnsName: DNS },
          port: 9443,
          devices: [],
        });
        expect(remote.current()).toBeUndefined();
        const on = yield* remote.enable();
        expect(on).toMatchObject({ mode: "on", port: 9443, origin: `https://${DNS}:9443` });
        expect(tailnet.calls).toContain(`serve --bg --https=9443 http://127.0.0.1:${LOOPBACK}`);
        expect(remote.current()?.origin).toBe(`https://${DNS}:9443`);
        expect(remote.current()?.cookieName).toBe("__Host-gram_remote_9443");
        expect(tailnet.calls.some((call) => call.includes("funnel"))).toBe(false);
        const off = yield* remote.disable;
        expect(off).toMatchObject({ mode: "off", port: 9443 });
        expect(remote.current()).toBeUndefined();
        expect([...tailnet.listeners.keys()]).toEqual([443]);
      }).pipe(Effect.provide(control(tailnet.shape, dir)));
    }),
  );

  it.effect("never takes or removes a port another listener holds", () =>
    Effect.gen(function* () {
      const tailnet = fakeTailscale({
        listeners: {
          9443: { proxy: "http://127.0.0.1:5000" },
          9444: { proxy: "http://127.0.0.1:5001", funnel: true },
        },
      });
      yield* Effect.gen(function* () {
        const remote = yield* RemoteControl;
        expect((yield* remote.status).port).toBe(9443);
        const taken = yield* Effect.flip(remote.enable(9443));
        expect(taken.message).toBe("Another Tailscale Serve listener uses port 9443");
        const funnel = yield* Effect.flip(remote.enable(9444));
        expect(funnel.message).toContain("Funnel");
        // Picking its own port skips the held ones.
        expect((yield* remote.enable()).port).toBe(9445);
        yield* remote.disable;
        expect([...tailnet.listeners.keys()].toSorted()).toEqual([9443, 9444]);
      }).pipe(Effect.provide(control(tailnet.shape, dataDir())));
    }),
  );

  it.effect("says what Tailscale needs before it can serve", () =>
    Effect.gen(function* () {
      const cases = [
        [{ missing: true }, "missing", "isn't installed"],
        [{ backend: "NeedsLogin" }, "signed-out", "Sign in"],
        [{ backend: "Stopped" }, "stopped", "isn't connected"],
        [{ certs: false }, "no-https", "HTTPS certificates"],
      ] as const;
      for (const [options, state, message] of cases) {
        const tailnet = fakeTailscale(options);
        yield* Effect.gen(function* () {
          const remote = yield* RemoteControl;
          expect((yield* remote.status).tailscale.state).toBe(state);
          expect((yield* Effect.flip(remote.enable())).message).toContain(message);
          expect(remote.current()).toBeUndefined();
        }).pipe(Effect.provide(control(tailnet.shape, dataDir())));
      }
      const consent = fakeTailscale({
        refuseServe:
          "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n  https://login.tailscale.com/f/serve?node=synthetic\n",
      });
      yield* Effect.gen(function* () {
        const remote = yield* RemoteControl;
        expect((yield* Effect.flip(remote.enable())).message).toBe(
          "Allow Tailscale Serve for this tailnet at https://login.tailscale.com/f/serve?node=synthetic",
        );
        expect(remote.current()).toBeUndefined();
      }).pipe(Effect.provide(control(consent.shape, dataDir())));
    }),
  );

  it.effect("re-points its listener at the next run's port, and takes it down on stop", () =>
    Effect.gen(function* () {
      const tailnet = fakeTailscale();
      const dir = dataDir();
      yield* Effect.gen(function* () {
        yield* (yield* RemoteControl).enable(9443);
      }).pipe(Effect.provide(control(tailnet.shape, dir)));
      // Stopping the server takes the listener down, so a reused loopback port isn't shared.
      expect(tailnet.listeners.has(9443)).toBe(false);
      // A crash leaves it pointing at the old port.
      tailnet.listeners.set(9443, { proxy: `http://127.0.0.1:${LOOPBACK}` });
      yield* Effect.gen(function* () {
        const remote = yield* RemoteControl;
        yield* settled;
        expect(remote.current()?.origin).toBe(`https://${DNS}:9443`);
        expect(tailnet.listeners.get(9443)?.proxy).toBe("http://127.0.0.1:5555");
        expect((yield* remote.status).mode).toBe("on");
      }).pipe(Effect.provide(control(tailnet.shape, dir, 5555)));
    }),
  );

  it.effect("stays off at startup when the saved port now belongs to someone else", () =>
    Effect.gen(function* () {
      const tailnet = fakeTailscale();
      const dir = dataDir();
      yield* Effect.gen(function* () {
        yield* (yield* RemoteControl).enable(9443);
      }).pipe(Effect.provide(control(tailnet.shape, dir)));
      tailnet.listeners.set(9443, { proxy: "https+insecure://localhost:8080" });
      yield* Effect.gen(function* () {
        const remote = yield* RemoteControl;
        yield* settled;
        expect(remote.current()).toBeUndefined();
        expect(yield* remote.status).toMatchObject({
          mode: "on",
          problem: "Another Tailscale Serve listener uses port 9443",
        });
        yield* remote.disable;
        expect(tailnet.listeners.get(9443)?.proxy).toBe("https+insecure://localhost:8080");
      }).pipe(Effect.provide(control(tailnet.shape, dir, 5555)));
    }),
  );

  it.effect("leaves GRAM_REMOTE_ORIGIN in charge: the switch is locked and Serve untouched", () =>
    Effect.gen(function* () {
      const tailnet = fakeTailscale();
      const origin = "https://device.tail123.ts.net:9443";
      yield* Effect.gen(function* () {
        const remote = yield* RemoteControl;
        expect(yield* remote.status).toMatchObject({ mode: "env", origin, port: 9443 });
        expect((yield* Effect.flip(remote.enable())).message).toContain("GRAM_REMOTE_ORIGIN");
        expect((yield* Effect.flip(remote.disable)).message).toContain("GRAM_REMOTE_ORIGIN");
        expect(remote.current()?.cookieName).toBe(`__Host-gram_remote_${LOOPBACK}`);
      }).pipe(Effect.provide(control(tailnet.shape, dataDir(), LOOPBACK, origin)));
      expect(tailnet.calls).toEqual([]);
    }),
  );

  it.effect("leaves alone a listener the user put on Gram's saved port after Gram quit", () =>
    Effect.gen(function* () {
      const tailnet = fakeTailscale();
      const dir = dataDir();
      yield* Effect.gen(function* () {
        yield* (yield* RemoteControl).enable(9443);
      }).pipe(Effect.provide(control(tailnet.shape, dir)));
      // Same shape as Gram's own target, but not the one Gram wrote.
      tailnet.listeners.set(9443, { proxy: "http://127.0.0.1:3000" });
      yield* Effect.gen(function* () {
        const remote = yield* RemoteControl;
        yield* settled;
        expect(remote.current()).toBeUndefined();
        expect((yield* remote.status).problem).toBe(
          "Another Tailscale Serve listener uses port 9443",
        );
        yield* remote.disable;
      }).pipe(Effect.provide(control(tailnet.shape, dir, 5555)));
      expect(tailnet.listeners.get(9443)?.proxy).toBe("http://127.0.0.1:3000");
      expect(tailnet.calls.filter((call) => call.startsWith("serve --bg"))).toHaveLength(1);
    }),
  );

  it.effect("puts the setting back when Tailscale refuses to turn on", () =>
    Effect.gen(function* () {
      const tailnet = fakeTailscale({ refuseServe: "error" });
      yield* Effect.gen(function* () {
        const remote = yield* RemoteControl;
        yield* Effect.flip(remote.enable());
        expect(yield* remote.status).toMatchObject({ mode: "off" });
      }).pipe(Effect.provide(control(tailnet.shape, dataDir())));
    }),
  );

  it.effect("treats Gram's target with another path handler added as the user's listener", () =>
    Effect.gen(function* () {
      const tailnet = fakeTailscale();
      const dir = dataDir();
      yield* Effect.gen(function* () {
        yield* (yield* RemoteControl).enable(9443);
      }).pipe(Effect.provide(control(tailnet.shape, dir)));
      tailnet.listeners.set(9443, { proxy: `http://127.0.0.1:${LOOPBACK}`, paths: ["/files"] });
      yield* Effect.gen(function* () {
        const remote = yield* RemoteControl;
        yield* settled;
        expect(remote.current()).toBeUndefined();
        yield* remote.disable;
      }).pipe(Effect.provide(control(tailnet.shape, dir, 5555)));
      expect(tailnet.listeners.get(9443)?.paths).toEqual(["/files"]);
    }),
  );

  it.effect("says so, and stays on, when Tailscale won't remove Gram's listener", () =>
    Effect.gen(function* () {
      const tailnet = fakeTailscale();
      const base = tailnet.shape;
      let refuseOff = false;
      const shape: TailscaleShape = {
        run: (args) =>
          refuseOff && args.at(-1) === "off"
            ? Effect.succeed({ code: 1, stdout: "", stderr: "busy" })
            : base.run(args),
      };
      yield* Effect.gen(function* () {
        const remote = yield* RemoteControl;
        yield* remote.enable(9443);
        refuseOff = true;
        const error = yield* Effect.flip(remote.disable);
        expect(error.message).toContain("didn't remove");
        expect(yield* remote.status).toMatchObject({ mode: "on", problem: error.message });
        expect(remote.current()).toBeUndefined();
        refuseOff = false;
      }).pipe(Effect.provide(control(shape, dataDir())));
    }),
  );

  it.effect("removes its old listener before moving to another port", () =>
    Effect.gen(function* () {
      const tailnet = fakeTailscale();
      const dir = dataDir();
      yield* Effect.gen(function* () {
        yield* (yield* RemoteControl).enable(9443);
      }).pipe(Effect.provide(control(tailnet.shape, dir)));
      // A start that failed left it behind, pointing at the old run.
      tailnet.listeners.set(9443, { proxy: `http://127.0.0.1:${LOOPBACK}` });
      tailnet.listeners.set(9444, { proxy: "http://127.0.0.1:1" });
      yield* Effect.gen(function* () {
        const remote = yield* RemoteControl;
        yield* settled;
        // Startup took it back; turn off and move.
        yield* remote.disable;
        tailnet.listeners.set(9443, { proxy: "http://127.0.0.1:5555" });
        expect((yield* remote.enable(9445)).port).toBe(9445);
      }).pipe(Effect.provide(control(tailnet.shape, dir, 5555)));
      expect(tailnet.listeners.has(9443)).toBe(false);
      expect(tailnet.listeners.get(9444)?.proxy).toBe("http://127.0.0.1:1");
    }),
  );
});

/** A run that turned access on at 9443 and quit while Tailscale couldn't take its listener down. */
const leftBehind = (tailnet: ReturnType<typeof fakeTailscale>, dir: string, port: number) =>
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      yield* (yield* RemoteControl).enable(9443);
    }).pipe(Effect.provide(control(tailnet.shape, dir, port)));
    tailnet.listeners.set(9443, { proxy: `http://127.0.0.1:${port}` });
  });

const OLD_PORT = 61452;
const NEW_PORT = 59873;

describe("phone access recovering by itself", () => {
  it.effect("waits out Tailscale stopped at startup, then re-points Gram's stale listener", () =>
    Effect.gen(function* () {
      const options: { backend?: string } = {};
      const tailnet = fakeTailscale(options);
      const dir = dataDir();
      yield* leftBehind(tailnet, dir, OLD_PORT);
      options.backend = "Stopped";
      yield* Effect.gen(function* () {
        const remote = yield* RemoteControl;
        yield* settled;
        expect(remote.current()).toBeUndefined();
        expect(remote.dialAccess()).toBe("stopped");
        const stopped = yield* remote.status;
        expect(stopped).toMatchObject({ mode: "on", tailscale: { state: "stopped" } });
        expect(stopped.problem).toMatch(
          /^Tailscale is stopped on this (Mac|computer)\. Turn it on, and Gram sets up access again by itself\.$/,
        );
        // Still the old run's: nothing is changed while Tailscale is stopped.
        expect(tailnet.listeners.get(9443)?.proxy).toBe(`http://127.0.0.1:${OLD_PORT}`);

        options.backend = "Running";
        yield* TestClock.adjust(RECOVERY_DELAYS_MS[0]);
        yield* settled;
        expect(tailnet.listeners.get(9443)?.proxy).toBe(`http://127.0.0.1:${NEW_PORT}`);
        expect(remote.current()?.origin).toBe(`https://${DNS}:9443`);
        expect(remote.dialAccess()).toBe("on");
        const back = yield* remote.status;
        expect(back).toMatchObject({ mode: "on", origin: `https://${DNS}:9443` });
        expect(back).not.toHaveProperty("problem");
        expect(tailnet.calls.some((call) => call.includes("funnel"))).toBe(false);
      }).pipe(Effect.provide(control(tailnet.shape, dir, NEW_PORT)));
    }),
  );

  it.effect("backs off to a minute apart while Tailscale stays stopped", () =>
    Effect.gen(function* () {
      const options: { backend?: string } = {};
      const tailnet = fakeTailscale(options);
      const dir = dataDir();
      yield* leftBehind(tailnet, dir, OLD_PORT);
      options.backend = "Stopped";
      tailnet.calls.length = 0;
      yield* Effect.gen(function* () {
        yield* RemoteControl;
        yield* settled;
        const looks = () => tailnet.calls.filter((call) => call === "status --json").length;
        expect(looks()).toBe(1);
        for (const delay of [...RECOVERY_DELAYS_MS, 60_000, 60_000]) {
          // Just short of the next look: none yet.
          yield* TestClock.adjust(delay - 1);
          yield* settled;
          const before = looks();
          yield* TestClock.adjust(1);
          yield* settled;
          expect(looks()).toBe(before + 1);
        }
        // Seven looks over five minutes, and nothing but looks.
        expect(looks()).toBe(8);
        expect(tailnet.calls.every((call) => call === "status --json")).toBe(true);
      }).pipe(Effect.provide(control(tailnet.shape, dir, NEW_PORT)));
    }),
  );

  it.effect("tries at once when a status check finds Tailscale back during a backoff", () =>
    Effect.gen(function* () {
      const options: { backend?: string } = {};
      const tailnet = fakeTailscale(options);
      const dir = dataDir();
      yield* leftBehind(tailnet, dir, OLD_PORT);
      options.backend = "Stopped";
      yield* Effect.gen(function* () {
        const remote = yield* RemoteControl;
        yield* settled;
        // Past the first three tries, the next waits 40 s.
        for (const delay of RECOVERY_DELAYS_MS.slice(0, 3)) {
          yield* TestClock.adjust(delay);
          yield* settled;
        }
        options.backend = "Running";
        // Past the status cache, well inside the backoff.
        yield* TestClock.adjust(16_000);
        yield* settled;
        expect(remote.current()).toBeUndefined();
        yield* remote.status;
        yield* settled;
        expect(remote.current()?.origin).toBe(`https://${DNS}:9443`);
        expect(tailnet.listeners.get(9443)?.proxy).toBe(`http://127.0.0.1:${NEW_PORT}`);
      }).pipe(Effect.provide(control(tailnet.shape, dir, NEW_PORT)));
    }),
  );

  it.effect("leaves other Serve and Funnel entries alone while it takes its own back", () =>
    Effect.gen(function* () {
      const options: { backend?: string } = {};
      const tailnet = fakeTailscale(options);
      const dir = dataDir();
      yield* leftBehind(tailnet, dir, OLD_PORT);
      tailnet.listeners.set(443, { proxy: "http://127.0.0.1:3000" });
      tailnet.listeners.set(8443, { proxy: "http://127.0.0.1:8080", funnel: true });
      tailnet.listeners.set(9444, { proxy: `http://127.0.0.1:${OLD_PORT}`, paths: ["/files"] });
      options.backend = "Stopped";
      tailnet.calls.length = 0;
      yield* Effect.gen(function* () {
        const remote = yield* RemoteControl;
        yield* settled;
        options.backend = "Running";
        yield* TestClock.adjust(RECOVERY_DELAYS_MS[0]);
        yield* settled;
        expect(remote.current()?.origin).toBe(`https://${DNS}:9443`);
      }).pipe(Effect.provide(control(tailnet.shape, dir, NEW_PORT)));
      expect(tailnet.listeners.get(443)).toEqual({ proxy: "http://127.0.0.1:3000" });
      expect(tailnet.listeners.get(8443)).toEqual({ proxy: "http://127.0.0.1:8080", funnel: true });
      expect(tailnet.listeners.get(9444)).toEqual({
        proxy: `http://127.0.0.1:${OLD_PORT}`,
        paths: ["/files"],
      });
      // Only its own port, re-pointed once and taken down on stop.
      expect(tailnet.calls.filter((call) => call.startsWith("serve --"))).toEqual([
        `serve --bg --https=9443 http://127.0.0.1:${NEW_PORT}`,
        "serve --https=9443 off",
      ]);
    }),
  );

  it.effect("puts back its listener when Tailscale loses it, and not one another app took", () =>
    Effect.gen(function* () {
      const tailnet = fakeTailscale();
      yield* Effect.gen(function* () {
        const remote = yield* RemoteControl;
        yield* remote.enable(9443);
        tailnet.listeners.delete(9443);
        yield* TestClock.adjust(RECHECK_MS);
        yield* settled;
        expect(tailnet.listeners.get(9443)?.proxy).toBe(`http://127.0.0.1:${LOOPBACK}`);
        expect(remote.dialAccess()).toBe("on");

        tailnet.listeners.set(9443, { proxy: "http://127.0.0.1:3000" });
        yield* TestClock.adjust(RECHECK_MS);
        yield* settled;
        expect(tailnet.listeners.get(9443)?.proxy).toBe("http://127.0.0.1:3000");
        expect(remote.dialAccess()).toBe("serve");
        expect((yield* remote.status).problem).toBe(
          "Another Tailscale Serve listener uses port 9443",
        );
        // Taken back only once it is gone.
        tailnet.listeners.delete(9443);
        yield* TestClock.adjust(RECOVERY_DELAYS_MS[0]);
        yield* settled;
        expect(tailnet.listeners.get(9443)?.proxy).toBe(`http://127.0.0.1:${LOOPBACK}`);
        expect(remote.dialAccess()).toBe("on");
      }).pipe(Effect.provide(control(tailnet.shape, dataDir())));
    }),
  );

  it.effect("finishes a turn-off Tailscale refused once it can, instead of serving again", () =>
    Effect.gen(function* () {
      const tailnet = fakeTailscale();
      const base = tailnet.shape;
      let refuseOff = true;
      const shape: TailscaleShape = {
        run: (args) =>
          refuseOff && args.at(-1) === "off"
            ? Effect.succeed({ code: 1, stdout: "", stderr: "busy" })
            : base.run(args),
      };
      yield* Effect.gen(function* () {
        const remote = yield* RemoteControl;
        yield* remote.enable(9443);
        yield* Effect.flip(remote.disable);
        expect(remote.dialAccess()).toBe("off");
        yield* TestClock.adjust(RECOVERY_DELAYS_MS[0]);
        yield* settled;
        // Still refused: on, saying so, and not serving again.
        expect(remote.current()).toBeUndefined();
        expect(yield* remote.status).toMatchObject({ mode: "on" });
        refuseOff = false;
        yield* TestClock.adjust(RECOVERY_DELAYS_MS[1]);
        yield* settled;
        expect(tailnet.listeners.has(9443)).toBe(false);
        const off = yield* remote.status;
        expect(off).toMatchObject({ mode: "off" });
        expect(off).not.toHaveProperty("problem");
        expect(remote.current()).toBeUndefined();
      }).pipe(Effect.provide(control(shape, dataDir())));
    }),
  );

  it.effect("says why machines can't dial in while the switch is on", () =>
    Effect.gen(function* () {
      const cases = [
        [{ missing: true }, "missing", /^Gram can't find Tailscale on this (Mac|computer)\./],
        [
          { backend: "NeedsLogin" },
          "signed-out",
          /^Tailscale is signed out on this (Mac|computer)\. Sign in/,
        ],
        [
          { backend: "Stopped" },
          "stopped",
          /^Tailscale is stopped on this (Mac|computer)\. Turn it on/,
        ],
        [{ certs: false }, "no-https", /^Turn on HTTPS certificates/],
      ] as const;
      for (const [down, cause, message] of cases) {
        const options: Parameters<typeof fakeTailscale>[0] = {};
        const tailnet = fakeTailscale(options);
        const dir = dataDir();
        yield* leftBehind(tailnet, dir, OLD_PORT);
        Object.assign(options, down);
        yield* Effect.gen(function* () {
          const remote = yield* RemoteControl;
          yield* settled;
          expect(remote.dialAccess()).toBe(cause);
          expect((yield* remote.status).problem).toMatch(message);
        }).pipe(Effect.provide(control(tailnet.shape, dir, NEW_PORT)));
      }
      const off = fakeTailscale({ backend: "Stopped" });
      yield* Effect.gen(function* () {
        const remote = yield* RemoteControl;
        yield* settled;
        // Switched off, a stopped Tailscale is no problem of Gram's.
        expect(remote.dialAccess()).toBe("off");
        expect(yield* remote.status).not.toHaveProperty("problem");
        expect(off.calls).toEqual(["status --json"]);
      }).pipe(Effect.provide(control(off.shape, dataDir())));
    }),
  );
});

const statusLooks = (calls: ReadonlyArray<string>) =>
  calls.filter((call) => call === "status --json").length;

/** A pairing code from a link `mint()` made, and a claim of it as a phone's browser would. */
const codeOf = (url: string) => new URLSearchParams(new URL(url).hash.slice(1)).get("pair")!;
const claimOn = (
  origin: string,
  claimer: { claim: (request: never, code: string) => unknown },
  code: string,
) =>
  claimer.claim(
    {
      method: "POST",
      url: "/remote/claim",
      headers: { host: new URL(origin).host, origin },
      cookies: {},
    } as never,
    code,
  );

describe("independent review of #344", () => {
  const ORIGIN = `https://${DNS}:9443`;

  it.effect("closes access, and its watchers hear, once recovery sees Tailscale stopped", () =>
    Effect.gen(function* () {
      const options: { backend?: string } = {};
      const tailnet = fakeTailscale(options);
      yield* Effect.gen(function* () {
        const remote = yield* RemoteControl;
        // Startup's first look, then the user turns access on.
        yield* settled;
        yield* remote.enable(9443);
        const seen: Array<string | undefined> = [];
        remote.watch((origin) => seen.push(origin));
        expect(seen).toEqual([ORIGIN]);
        // An invitation made while serving, not yet used.
        const code = codeOf(remote.current()!.mint().url);

        options.backend = "Stopped";
        yield* TestClock.adjust(RECHECK_MS);
        yield* settled;
        expect(remote.dialAccess()).toBe("stopped");
        // Nothing left to authorize a dial or a claim against.
        expect(remote.current()).toBeUndefined();
        expect(seen).toEqual([ORIGIN, undefined]);
        expect((yield* remote.status).mode).toBe("on");

        options.backend = "Running";
        yield* TestClock.adjust(RECOVERY_DELAYS_MS[0]);
        yield* settled;
        expect(remote.current()?.origin).toBe(ORIGIN);
        expect(seen).toEqual([ORIGIN, undefined, ORIGIN]);
        // The invitation went with the access it was made on.
        expect(claimOn(ORIGIN, remote.current()!, code)).toBeUndefined();
      }).pipe(Effect.provide(control(tailnet.shape, dataDir())));
    }),
  );

  it.effect("moves access to the new tailnet name when Tailscale comes back renamed", () =>
    Effect.gen(function* () {
      const options: { backend?: string; dns?: string } = {};
      const tailnet = fakeTailscale(options);
      yield* Effect.gen(function* () {
        const remote = yield* RemoteControl;
        // Startup's first look, then the user turns access on.
        yield* settled;
        yield* remote.enable(9443);
        const seen: Array<string | undefined> = [];
        remote.watch((origin) => seen.push(origin));
        options.backend = "Stopped";
        yield* TestClock.adjust(RECHECK_MS);
        yield* settled;
        options.backend = "Running";
        options.dns = "renamed.tail123.ts.net";
        yield* TestClock.adjust(RECOVERY_DELAYS_MS[0]);
        yield* settled;
        const renamed = "https://renamed.tail123.ts.net:9443";
        expect(remote.current()?.origin).toBe(renamed);
        expect(seen).toEqual([ORIGIN, undefined, renamed]);
        expect(yield* remote.status).toMatchObject({ mode: "on", origin: renamed });
      }).pipe(Effect.provide(control(tailnet.shape, dataDir())));
    }),
  );

  it.effect("moves access when the tailnet name changes without Tailscale stopping", () =>
    Effect.gen(function* () {
      const options: { dns?: string } = {};
      const tailnet = fakeTailscale(options);
      yield* Effect.gen(function* () {
        const remote = yield* RemoteControl;
        // Startup's first look, then the user turns access on.
        yield* settled;
        yield* remote.enable(9443);
        const seen: Array<string | undefined> = [];
        remote.watch((origin) => seen.push(origin));
        options.dns = "renamed.tail123.ts.net";
        yield* TestClock.adjust(RECHECK_MS);
        yield* settled;
        // Closed on the old name first, then opened on the new one.
        expect(seen).toEqual([ORIGIN, undefined, "https://renamed.tail123.ts.net:9443"]);
      }).pipe(Effect.provide(control(tailnet.shape, dataDir())));
    }),
  );

  it.effect("bears one unanswered look, and closes access on the second", () =>
    Effect.gen(function* () {
      const options: { statusFails?: number } = {};
      const tailnet = fakeTailscale(options);
      yield* Effect.gen(function* () {
        const remote = yield* RemoteControl;
        // Startup's first look, then the user turns access on.
        yield* settled;
        yield* remote.enable(9443);
        options.statusFails = 2;
        yield* TestClock.adjust(RECHECK_MS);
        yield* settled;
        expect(remote.current()?.origin).toBe(ORIGIN);
        yield* TestClock.adjust(RECOVERY_DELAYS_MS[0]);
        yield* settled;
        expect(remote.current()).toBeUndefined();
        expect(remote.dialAccess()).toBe("error");
        yield* TestClock.adjust(RECOVERY_DELAYS_MS[1]);
        yield* settled;
        expect(remote.current()?.origin).toBe(ORIGIN);
      }).pipe(Effect.provide(control(tailnet.shape, dataDir())));
    }),
  );

  it.effect("keeps a turn-off off when saving it failed, rather than serving again", () =>
    Effect.gen(function* () {
      const tailnet = fakeTailscale();
      const dir = dataDir();
      const folder = join(dir, "remote-access");
      yield* Effect.gen(function* () {
        const remote = yield* RemoteControl;
        // Startup's first look, then the user turns access on.
        yield* settled;
        yield* remote.enable(9443);
        // Readable, but no new file can be made in it: the save of `enabled: false` fails.
        chmodSync(folder, 0o500);
        const error = yield* Effect.flip(remote.disable).pipe(
          Effect.ensuring(Effect.sync(() => chmodSync(folder, 0o700))),
        );
        expect(error).toBeInstanceOf(RemoteRefused);
        expect(error.message).toContain("couldn't be saved");
        expect(tailnet.listeners.has(9443)).toBe(false);
        expect(remote.dialAccess()).toBe("off");

        for (const delay of [RECHECK_MS, RECHECK_MS, RECHECK_MS]) {
          yield* TestClock.adjust(delay);
          yield* settled;
        }
        expect(tailnet.listeners.has(9443)).toBe(false);
        expect(remote.current()).toBeUndefined();
        expect((yield* remote.status).mode).toBe("off");
        // Turning on again is the user's to do, and works.
        expect((yield* remote.enable(9443)).origin).toBe(ORIGIN);
      }).pipe(Effect.provide(control(tailnet.shape, dir)));
    }),
  );

  it.effect("never removes a listener the user shared with Funnel while a turn-off waited", () =>
    Effect.gen(function* () {
      const options: { backend?: string } = {};
      const tailnet = fakeTailscale(options);
      yield* Effect.gen(function* () {
        const remote = yield* RemoteControl;
        // Startup's first look, then the user turns access on.
        yield* settled;
        yield* remote.enable(8443);
        options.backend = "Stopped";
        // Tailscale is stopped, so the listener stays until recovery can remove it.
        yield* Effect.flip(remote.disable);
        // Meanwhile the user shares that listener with Funnel: it is theirs now.
        tailnet.listeners.set(8443, { ...tailnet.listeners.get(8443)!, funnel: true });
        options.backend = "Running";
        yield* TestClock.adjust(RECOVERY_DELAYS_MS[0]);
        yield* settled;
        expect(tailnet.listeners.get(8443)).toEqual({
          proxy: `http://127.0.0.1:${LOOPBACK}`,
          funnel: true,
        });
        expect(yield* remote.status).toMatchObject({ mode: "off" });
      }).pipe(Effect.provide(control(tailnet.shape, dataDir())));
      expect(tailnet.calls).not.toContain("serve --https=8443 off");
    }),
  );

  it.effect("never removes a Funnel-shared listener on turn-off or on shutdown", () =>
    Effect.gen(function* () {
      const tailnet = fakeTailscale();
      yield* Effect.gen(function* () {
        const remote = yield* RemoteControl;
        // Startup's first look, then the user turns access on.
        yield* settled;
        yield* remote.enable(8443);
        tailnet.listeners.set(8443, { ...tailnet.listeners.get(8443)!, funnel: true });
        yield* remote.disable;
        expect(tailnet.listeners.get(8443)?.funnel).toBe(true);
      }).pipe(Effect.provide(control(tailnet.shape, dataDir())));
      yield* Effect.gen(function* () {
        tailnet.listeners.delete(8443);
        yield* (yield* RemoteControl).enable(8443);
        tailnet.listeners.set(8443, { ...tailnet.listeners.get(8443)!, funnel: true });
      }).pipe(Effect.provide(control(tailnet.shape, dataDir())));
      // The shutdown finalizer left it too.
      expect(tailnet.listeners.get(8443)?.funnel).toBe(true);
      expect(tailnet.calls).not.toContain("serve --https=8443 off");
    }),
  );

  it.effect("runs one Tailscale CLI call at a time across status checks and recovery", () =>
    Effect.gen(function* () {
      const tailnet = fakeTailscale();
      let inFlight = 0;
      let most = 0;
      let gate: Deferred.Deferred<void> | undefined;
      const shape: TailscaleShape = {
        run: (args) =>
          Effect.gen(function* () {
            inFlight += 1;
            most = Math.max(most, inFlight);
            if (gate !== undefined && args[0] === "status") yield* Deferred.await(gate);
            return yield* tailnet.shape.run(args);
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                inFlight -= 1;
              }),
            ),
          ),
      };
      yield* Effect.gen(function* () {
        const remote = yield* RemoteControl;
        // Startup's first look, then the user turns access on.
        yield* settled;
        yield* remote.enable(9443);
        const before = statusLooks(tailnet.calls);
        // Recovery's look hangs, past the status cache.
        gate = yield* Deferred.make<void>();
        yield* TestClock.adjust(RECHECK_MS);
        yield* settled;
        expect(inFlight).toBe(1);
        // Two status checks meanwhile: neither starts a second call.
        const first = yield* Effect.forkScoped(remote.status);
        const second = yield* Effect.forkScoped(remote.status);
        yield* settled;
        expect(inFlight).toBe(1);
        const open = gate;
        gate = undefined;
        yield* Deferred.succeed(open, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        yield* settled;
        expect(most).toBe(1);
        // They reused recovery's look.
        expect(statusLooks(tailnet.calls) - before).toBe(1);
      }).pipe(
        // A failed assertion still lets the held calls finish, so the scope can close.
        Effect.ensuring(
          Effect.suspend(() =>
            gate === undefined ? Effect.void : Deferred.succeed(gate, undefined),
          ),
        ),
        Effect.scoped,
        Effect.provide(control(shape, dataDir())),
      );
    }),
  );
});

describe("re-review of #344", () => {
  const ORIGIN = `https://${DNS}:9443`;
  const RENAMED = "https://renamed.tail123.ts.net:9443";

  it.effect(
    "retires access recovery closed: a claim or session begun on it gets nothing after",
    () =>
      Effect.gen(function* () {
        const options: { backend?: string } = {};
        const tailnet = fakeTailscale(options);
        yield* Effect.gen(function* () {
          const remote = yield* RemoteControl;
          yield* settled;
          yield* remote.enable(9443);
          const before = remote.current()!;
          // A browser paired before, and a link a phone is about to claim.
          const token = claimOn(ORIGIN, before, codeOf(before.mint().url)) as string;
          const code = codeOf(before.mint().url);
          const session = {
            method: "GET",
            url: "/",
            headers: { host: before.host, origin: ORIGIN },
            cookies: { [before.cookieName]: token },
          };
          expect(before.authorize(session)).toEqual({ kind: "pass" });

          options.backend = "Stopped";
          yield* TestClock.adjust(RECHECK_MS);
          yield* settled;
          options.backend = "Running";
          yield* TestClock.adjust(RECOVERY_DELAYS_MS[0]);
          yield* settled;
          const after = remote.current()!;
          // Open again at the same address, as a new access.
          expect(after.origin).toBe(ORIGIN);
          expect(after).not.toBe(before);
          // The claim that began on the old one, its body read only now: refused.
          expect(claimOn(ORIGIN, before, code)).toBeUndefined();
          expect(claimOn(ORIGIN, after, code)).toBeUndefined();
          expect(before.authorize(session)).toMatchObject({ kind: "reject", status: 401 });
          let closedAtOnce = false;
          before.onDisconnect(before.sessionOf(session) ?? ({ hash: "x" } as never), () => {
            closedAtOnce = true;
          });
          expect(closedAtOnce).toBe(true);
          // The pairing made before is kept, on the access serving now.
          expect(after.authorize(session)).toEqual({ kind: "pass" });
        }).pipe(Effect.provide(control(tailnet.shape, dataDir())));
      }),
  );

  it.effect(
    "closes access on the old name at once when Tailscale reports a new one, even if Serve doesn't answer",
    () =>
      Effect.gen(function* () {
        const options: { dns?: string; serveStatusFails?: number } = {};
        const tailnet = fakeTailscale(options);
        yield* Effect.gen(function* () {
          const remote = yield* RemoteControl;
          yield* settled;
          yield* remote.enable(9443);
          const seen: Array<string | undefined> = [];
          remote.watch((origin) => seen.push(origin));
          // Renamed for certain; Serve's status, asked next, goes unanswered once.
          options.dns = "renamed.tail123.ts.net";
          options.serveStatusFails = 1;
          yield* TestClock.adjust(RECHECK_MS);
          yield* settled;
          expect(remote.current()).toBeUndefined();
          expect(seen).toEqual([ORIGIN, undefined]);
          // Opened on the new name only once Serve is set up for it.
          yield* TestClock.adjust(RECOVERY_DELAYS_MS[0]);
          yield* settled;
          expect(remote.current()?.origin).toBe(RENAMED);
          expect(seen).toEqual([ORIGIN, undefined, RENAMED]);
        }).pipe(Effect.provide(control(tailnet.shape, dataDir())));
      }),
  );
});

describe("third re-review of #344", () => {
  const ORIGIN = `https://${DNS}:9443`;

  for (const all of [false, true])
    it.effect(
      `removes ${all ? "every browser" : "a browser"} through an access recovery replaced, for good`,
      () =>
        Effect.gen(function* () {
          const options: { backend?: string } = {};
          const tailnet = fakeTailscale(options);
          yield* Effect.gen(function* () {
            const remote = yield* RemoteControl;
            yield* settled;
            yield* remote.enable(9443);
            const before = remote.current()!;
            const token = claimOn(ORIGIN, before, codeOf(before.mint().url)) as string;
            const session = {
              method: "GET",
              url: "/",
              headers: { host: before.host, origin: ORIGIN },
              cookies: { [before.cookieName]: token },
            };
            // A removal that began on the access serving then.
            const id = before.devices()[0]!.id;

            options.backend = "Stopped";
            yield* TestClock.adjust(RECHECK_MS);
            yield* settled;
            options.backend = "Running";
            yield* TestClock.adjust(RECOVERY_DELAYS_MS[0]);
            yield* settled;
            const after = remote.current()!;
            expect(after).not.toBe(before);
            expect(after.authorize(session)).toEqual({ kind: "pass" });
            let closed = false;
            after.onDisconnect(after.sessionOf(session)!, () => {
              closed = true;
            });

            // It finishes on the old access, which recovery has replaced.
            if (all) before.revokeAll();
            else expect(before.revoke(id)).toBe(true);
            expect(after.authorize(session)).toMatchObject({ kind: "reject", status: 401 });
            expect(after.devices()).toEqual([]);
            expect(closed).toBe(true);
          }).pipe(Effect.provide(control(tailnet.shape, dataDir())));
        }),
    );
});
