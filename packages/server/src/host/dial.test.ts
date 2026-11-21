import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type Socket as NetSocket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { HOST_PROTOCOL_VERSION, HostId } from "@gram/contracts";
import { Proc, ProcLive, Worktrees, WorktreesLive } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { dialForever, dialOnce, HOST_DIAL_TOKEN_HEADER } from "./dial.ts";
import { attachmentsOnHost, fileReadsOn } from "./file-reads.ts";
import { filesOn } from "./files.ts";
import { gitOn } from "./git.ts";
import { generateHostKey, hostIdOf, privateKeyFrom } from "./machine-keys.ts";
import { HOST_FEATURES, HOST_SERVES, type HostService } from "./protocol.ts";
import { reposOn } from "./repos.ts";
import { noAgents, sessionsOnHost } from "./sessions.ts";
import { terminalsOnHost } from "./terminals.ts";

/** A main Gram that isn't there: every dial is refused at once. */
const refused = () => {
  const key = generateHostKey();
  return {
    origin: "http://127.0.0.1:9",
    hostId: hostIdOf(key.publicKey),
    key: privateKeyFrom(key.privateKeyPem),
    url: "ws://127.0.0.1:9/host/connect",
  };
};

/** A service that counts how often it was built and how often it ended. */
const counted = () => {
  const counts = { built: 0, ended: 0 };
  const service = Effect.gen(function* () {
    counts.built += 1;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        counts.ended += 1;
      }),
    );
    // Never served: no dial gets through.
    return {} as HostService;
  });
  return { counts, service };
};

describe("dialForever", () => {
  it.live("keeps what it serves across dials, so sessions outlive a dropped connection", () =>
    Effect.gen(function* () {
      const { counts, service } = counted();
      const fiber = yield* Effect.forkScoped(
        dialForever(refused(), service, { retryFirstMs: 50, detachedMs: 60_000 }),
      );
      yield* Effect.sleep("600 millis");
      // Several dials, one service: before, each dial built its own and ended it with the dial.
      expect(counts).toEqual({ built: 1, ended: 0 });
      yield* Fiber.interrupt(fiber);
      expect(counts).toEqual({ built: 1, ended: 1 });
    }).pipe(Effect.scoped),
  );

  it.live("ends what it kept once it has been without a connection for the grace", () =>
    Effect.gen(function* () {
      const { counts, service } = counted();
      const fiber = yield* Effect.forkScoped(
        dialForever(refused(), service, { retryFirstMs: 200, detachedMs: 100 }),
      );
      yield* Effect.gen(function* () {
        while (counts.ended < 1 || counts.built < 2) yield* Effect.sleep("20 millis");
      }).pipe(Effect.timeout("5 seconds"));
      expect(counts.ended).toBeGreaterThanOrEqual(1);
      // Built afresh for the dial after it ended.
      expect(counts.built).toBeGreaterThanOrEqual(2);
      yield* Fiber.interrupt(fiber);
      expect(counts.built).toBe(counts.ended);
    }).pipe(Effect.scoped),
  );
});

/**
 * A main Gram that takes each dial's WebSocket upgrade and then, unless `pings`, never sends a
 * thing: to the host, a link that broke without a word. One that pings sends what the main Gram's
 * RPC client does every interval, as an unmasked text frame.
 */
const mainGram = (
  pings: number | undefined,
  /**
   * Instead: say one thing and close, as a main Gram that asks a host's hello and then refuses it
   * does, with this close code.
   */
  refuseWith?: number,
  /** How many things it says before it refuses: past the first (the hello), the dial was served. */
  saysBeforeRefusing = 1,
) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{
          port: number;
          dials: () => number;
          heads: () => ReadonlyArray<string>;
          close: () => void;
        }>((resolve) => {
          const sockets: Array<NetSocket> = [];
          const heads: Array<string> = [];
          const timers: Array<ReturnType<typeof setInterval>> = [];
          const server = createServer((socket) => {
            sockets.push(socket);
            socket.on("error", () => {});
            socket.once("data", (head) => {
              heads.push(head.toString());
              const key = /sec-websocket-key: *(.+)\r\n/i.exec(head.toString())?.[1]?.trim() ?? "";
              const accept = createHash("sha1")
                .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
                .digest("base64");
              socket.write(
                "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
                  `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
              );
              const ping = Buffer.from('{"_tag":"Ping"}\n');
              if (refuseWith !== undefined) {
                const code = Buffer.from([refuseWith >> 8, refuseWith & 0xff]);
                for (let said = 0; said < saysBeforeRefusing; said++)
                  socket.write(Buffer.concat([Buffer.from([0x81, ping.length]), ping]));
                socket.write(Buffer.concat([Buffer.from([0x88, code.length]), code]));
                return;
              }
              if (pings === undefined) return;
              timers.push(
                setInterval(() => {
                  if (!socket.destroyed)
                    socket.write(Buffer.concat([Buffer.from([0x81, ping.length]), ping]));
                }, pings),
              );
            });
          });
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            resolve({
              port: typeof address === "object" && address !== null ? address.port : 0,
              dials: () => sockets.length,
              heads: () => heads,
              close: () => {
                for (const timer of timers) clearInterval(timer);
                for (const socket of sockets) socket.destroy();
                server.close();
              },
            });
          });
        }),
    ),
    (main) => Effect.sync(() => main.close()),
  );

/** A host that serves nothing but its hello, for a dial that gets through. */
const servedHost = (hostId: string) =>
  Effect.gen(function* () {
    const proc = yield* Proc;
    return {
      hello: {
        protocol: HOST_PROTOCOL_VERSION,
        hostId: HostId.make(hostId),
        capabilities: HOST_SERVES,
        features: HOST_FEATURES,
        platform: process.platform,
        pid: 1,
      },
      files: filesOn(proc),
      reads: fileReadsOn(proc),
      attachments: yield* attachmentsOnHost(mkdtempSync(join(tmpdir(), "gram-host-attached-"))),
      repos: reposOn(proc, "/nonexistent/gram-host-repos"),
      worktrees: yield* Worktrees,
      git: gitOn(proc),
      terminals: yield* terminalsOnHost,
      sessions: yield* sessionsOnHost(noAgents),
      scan: Effect.succeed({ listening: new Map(), children: new Map() }),
    } satisfies HostService;
  });

/** The host dialling `main` for good, on short timings. */
const dialling = (
  main: { port: number },
  joined?: () => boolean,
  /** Runs once what the host kept across its dials (its sessions among it) has ended. */
  onEnded: () => void = () => {},
) => {
  const key = generateHostKey();
  const hostId = hostIdOf(key.publicKey);
  return dialForever(
    {
      origin: `http://127.0.0.1:${main.port}`,
      hostId,
      key: privateKeyFrom(key.privateKeyPem),
      url: `ws://127.0.0.1:${main.port}/host/connect`,
      ...(joined === undefined ? {} : { joined }),
    },
    servedHost(hostId).pipe(Effect.tap(() => Effect.addFinalizer(() => Effect.sync(onEnded)))),
    { retryFirstMs: 50, detachedMs: 60_000, idleMs: 300 },
  );
};

describe("dialForever over a link that went quiet", () => {
  it.live("dials again once the main Gram has said nothing for too long", () =>
    Effect.gen(function* () {
      const main = yield* mainGram(undefined);
      const fiber = yield* Effect.forkScoped(dialling(main));
      yield* Effect.gen(function* () {
        while (main.dials() < 2) yield* Effect.sleep("20 millis");
      }).pipe(Effect.timeout("5 seconds"));
      // Before this change the host waited on the first socket for good: one dial, ever.
      expect(main.dials()).toBeGreaterThanOrEqual(2);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped, Effect.provide(WorktreesLive.pipe(Layer.provideMerge(ProcLive)))),
  );

  it.live("keeps a dial the main Gram keeps pinging", () =>
    Effect.gen(function* () {
      const main = yield* mainGram(100);
      const fiber = yield* Effect.forkScoped(dialling(main));
      yield* Effect.sleep("1500 millis");
      expect(main.dials()).toBe(1);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped, Effect.provide(WorktreesLive.pipe(Layer.provideMerge(ProcLive)))),
  );
});

/** A host key and the dial options for `main`. */
const keyed = (main: { port: number }) => {
  const key = generateHostKey();
  const hostId = hostIdOf(key.publicKey);
  return {
    hostId,
    options: {
      origin: `http://127.0.0.1:${main.port}`,
      hostId,
      key: privateKeyFrom(key.privateKeyPem),
      url: `ws://127.0.0.1:${main.port}/host/connect`,
    },
  };
};

describe("a dial the main Gram refuses after the host's hello", () => {
  it.live("isn't a dial that got through: what the host kept doesn't count it as served", () =>
    Effect.gen(function* () {
      const main = yield* mainGram(undefined, 1000);
      const { hostId, options } = keyed(main);
      let served = 0;
      yield* dialOnce(
        options,
        servedHost(hostId),
        Effect.sync(() => void (served += 1)),
      ).pipe(Effect.timeout("10 seconds"));
      expect(served).toBe(0);
      // One that keeps talking is.
      const talking = yield* mainGram(50);
      const other = keyed(talking);
      yield* dialOnce(
        other.options,
        servedHost(other.hostId),
        Effect.sync(() => void (served += 1)),
        300,
      ).pipe(Effect.timeout("2 seconds"), Effect.ignore);
      expect(served).toBeGreaterThan(0);
    }).pipe(Effect.scoped, Effect.provide(WorktreesLive.pipe(Layer.provideMerge(ProcLive)))),
  );
});

describe("dialOnce", () => {
  // Its log said only "not connected; dialling again", so a machine that kept dropping its
  // connection gave no clue why on its own side.
  it.live("comes back with why the dial ended, for the host's log", () =>
    Effect.gen(function* () {
      const { service } = counted();
      expect(yield* dialOnce(refused(), service)).toMatch(/^An error occurred during Open/);

      const main = yield* mainGram(undefined);
      const key = generateHostKey();
      const hostId = hostIdOf(key.publicKey);
      const why = yield* dialOnce(
        {
          origin: `http://127.0.0.1:${main.port}`,
          hostId,
          key: privateKeyFrom(key.privateKeyPem),
          url: `ws://127.0.0.1:${main.port}/host/connect`,
        },
        servedHost(hostId),
        Effect.void,
        300,
      );
      expect(why).toMatch(/^nothing from the main Gram for \d+ seconds$/);
    }).pipe(Effect.scoped, Effect.provide(WorktreesLive.pipe(Layer.provideMerge(ProcLive)))),
  );
});

describe("a dial with a launcher's token", () => {
  // An embedder that launched the host tells its hosts apart by this token, not by the key alone.
  it.live("carries the token as it is at each dial, and no header without one", () =>
    Effect.gen(function* () {
      const main = yield* mainGram(undefined);
      const { hostId, options } = keyed(main);
      let token: string | undefined = "first-token";
      const dial = { ...options, dialToken: () => token };
      yield* dialOnce(dial, servedHost(hostId), Effect.void, 300);
      token = "rotated-token";
      yield* dialOnce(dial, servedHost(hostId), Effect.void, 300);
      token = undefined;
      yield* dialOnce(dial, servedHost(hostId), Effect.void, 300);
      yield* dialOnce(options, servedHost(hostId), Effect.void, 300);
      const sent = main
        .heads()
        .map((head) =>
          new RegExp(`^${HOST_DIAL_TOKEN_HEADER}: *(.+)\r$`, "im").exec(head)?.[1]?.trim(),
        );
      expect(sent).toEqual(["first-token", "rotated-token", undefined, undefined]);
      expect(main.heads().every((head) => /x-gram-host-signature: /i.test(head))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(WorktreesLive.pipe(Layer.provideMerge(ProcLive)))),
  );
});

describe("dialForever after the machine left", () => {
  it.live("ends its dial and stops dialling, its sessions ending with it", () =>
    Effect.gen(function* () {
      const main = yield* mainGram(100);
      let left = false;
      let ended = 0;
      const fiber = yield* Effect.forkScoped(
        dialling(
          main,
          () => !left,
          () => void ended++,
        ),
      );
      yield* Effect.sleep("400 millis");
      expect(main.dials()).toBe(1);
      // `gram-host leave --no-service` in another terminal: it can't stop this host, which before
      // this change kept dialling with the key it read at start.
      left = true;
      const stopped = yield* Fiber.await(fiber).pipe(Effect.timeout("2 seconds"));
      expect(stopped._tag).toBe("Success");
      expect(ended).toBe(1);
      yield* Effect.sleep("300 millis");
      expect(main.dials()).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(WorktreesLive.pipe(Layer.provideMerge(ProcLive)))),
  );

  // The #349 review: a leave while the host waits to dial again ended nothing until that wait
  // (up to 30 s) was over, its kept sessions alive meanwhile.
  it.live("ends what it kept at once when it leaves during the wait between dials", () =>
    Effect.gen(function* () {
      const { counts, service } = counted();
      let left = false;
      const fiber = yield* Effect.forkScoped(
        dialForever({ ...refused(), joined: () => !left }, service, {
          // The longest wait there is, entered straight away.
          retryFirstMs: 30_000,
          detachedMs: 60_000,
        }),
      );
      // The refused dial built what the host keeps, then went to wait out its 30 seconds.
      while (counts.built === 0) yield* Effect.sleep("20 millis");
      yield* Effect.sleep("200 millis");
      expect(counts).toEqual({ built: 1, ended: 0 });
      left = true;
      // Within the production cadence of a look a second, not the rest of the 30 s.
      const stopped = yield* Fiber.await(fiber).pipe(Effect.timeout("3 seconds"));
      expect(stopped._tag).toBe("Success");
      expect(counts).toEqual({ built: 1, ended: 1 });
    }).pipe(Effect.scoped),
  );

  it.live("never dials a Gram it left before it started", () =>
    Effect.gen(function* () {
      const main = yield* mainGram(100);
      const { counts, service } = counted();
      const key = generateHostKey();
      yield* dialForever(
        {
          origin: `http://127.0.0.1:${main.port}`,
          hostId: hostIdOf(key.publicKey),
          key: privateKeyFrom(key.privateKeyPem),
          url: `ws://127.0.0.1:${main.port}/host/connect`,
          joined: () => false,
        },
        service,
      ).pipe(Effect.timeout("2 seconds"));
      expect(main.dials()).toBe(0);
      expect(counts.built).toBe(counts.ended);
    }).pipe(Effect.scoped),
  );
});

/** A main Gram that hangs up on every dial before its upgrade, as one that hasn't registered the key. */
const hangingUp = () =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ port: number; dials: () => number; close: () => void }>((resolve) => {
          let dials = 0;
          const server = createServer((socket) => {
            dials += 1;
            socket.destroy();
          });
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            resolve({
              port: typeof address === "object" && address !== null ? address.port : 0,
              dials: () => dials,
              close: () => server.close(),
            });
          });
        }),
    ),
    (main) => Effect.sync(main.close),
  );

describe("dialForever before any dial got through", () => {
  // A platform registers a host it just provisioned from the line the host prints, and the host
  // dialled first about half the time: refused, it waited two seconds to dial again.
  it.live("dials again within a quarter second, and as before once one has got through", () =>
    Effect.gen(function* () {
      const fresh = yield* hangingUp();
      const key = generateHostKey();
      const options = (port: number) => ({
        origin: `http://127.0.0.1:${port}`,
        hostId: hostIdOf(key.publicKey),
        key: privateKeyFrom(key.privateKeyPem),
        url: `ws://127.0.0.1:${port}/host/connect`,
      });
      const unserved = yield* Effect.forkScoped(
        dialForever(options(fresh.port), servedHost(hostIdOf(key.publicKey)), {
          detachedMs: 60_000,
        }),
      );
      yield* Effect.sleep("1 second");
      expect(fresh.dials()).toBeGreaterThanOrEqual(3);
      yield* Fiber.interrupt(unserved);

      // Served (its hello answered), then refused: two seconds, as before.
      const refusing = yield* mainGram(undefined, 4001, 2);
      const served = yield* Effect.forkScoped(
        dialForever(options(refusing.port), servedHost(hostIdOf(key.publicKey)), {
          detachedMs: 60_000,
        }),
      );
      yield* Effect.sleep("1 second");
      expect(refusing.dials()).toBe(1);
      yield* Fiber.interrupt(served);
    }).pipe(Effect.scoped, Effect.provide(WorktreesLive.pipe(Layer.provideMerge(ProcLive)))),
  );
});
