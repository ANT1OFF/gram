import { createHmac, randomBytes } from "node:crypto";
import * as Effect from "effect/Effect";
import type { SqlClient } from "../platform/unstable.ts";
import { machineAccountScope } from "../runtime/limit-wait.ts";

/** Gram's own privacy state, separate from app settings and every provider credential. */
const STATE_KEY = "usage-account-hmac-v1";
const keyedScope = (key: Buffer) => (machine: string, login: string) =>
  machineAccountScope(machine, createHmac("sha256", key).update(login).digest("hex"));

/** A runtime composed without persistent usage state still never exposes a global fingerprint. */
export const ephemeralAccountScope = () => keyedScope(randomBytes(32));

/** Only install-keyed pseudonyms leave the control plane for clients or persisted limit state. */
export const makeAccountScope = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO settings (key, value) VALUES (${STATE_KEY}, ${randomBytes(32).toString("hex")})
      ON CONFLICT(key) DO NOTHING`;
    const [row] = yield* sql<{
      value: string;
    }>`SELECT value FROM settings WHERE key = ${STATE_KEY}`;
    if (row === undefined || !/^[a-f0-9]{64}$/.test(row.value))
      return yield* Effect.die(new Error("Account scope privacy state is invalid."));
    const key = Buffer.from(row.value, "hex");
    return keyedScope(key);
  }).pipe(
    Effect.catch(() => Effect.die(new Error("Could not initialize account scope privacy state."))),
  );
