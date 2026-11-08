import { afterAll, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerConfig } from "../config.ts";
import { HttpServer } from "../platform/unstable.ts";
import { TEST_CONFIG } from "../runtime/test-harness.ts";
import {
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
                    { Handlers: { "/": { Proxy: l.proxy } } },
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
});
