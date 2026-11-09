import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { dialForever } from "./dial.ts";
import { generateHostKey, hostIdOf, privateKeyFrom } from "./machine-keys.ts";
import type { HostService } from "./protocol.ts";

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
      yield* Effect.sleep("600 millis");
      expect(counts.ended).toBeGreaterThanOrEqual(1);
      // Built afresh for the dial after it ended.
      expect(counts.built).toBeGreaterThanOrEqual(2);
      yield* Fiber.interrupt(fiber);
      expect(counts.built).toBe(counts.ended);
    }).pipe(Effect.scoped),
  );
});
