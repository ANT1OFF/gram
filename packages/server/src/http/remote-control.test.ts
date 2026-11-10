import { afterAll, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerConfig } from "../config.ts";
import { HttpServer } from "../platform/unstable.ts";
import { TEST_CONFIG } from "../runtime/test-harness.ts";
import {
  RECHECK_MS,
  RECOVERY_DELAYS_MS,
  RemoteControl,
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
        if (args[0] === "status")
          return Effect.succeed(
            ok(
              JSON.stringify({
                BackendState: options.backend ?? "Running",
                Self: { DNSName: `${DNS}.` },
                CertDomains: options.certs === false ? null : [DNS],
              }),
            ),
          );
        if (args.join(" ") === "serve status --json")
          return Effect.succeed(
            ok(
              JSON.stringify({
                TCP: Object.fromEntries([...listeners.keys()].map((p) => [p, { HTTPS: true }])),
                Web: Object.fromEntries(
                  [...listeners].map(([p, l]) => [
                    `${DNS}:${p}`,
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
                  [...listeners].filter(([, l]) => l.funnel).map(([p]) => [`${DNS}:${p}`, true]),
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
