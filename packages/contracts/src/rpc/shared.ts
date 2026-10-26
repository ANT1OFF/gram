import * as Schema from "effect/Schema";
import { NotImplemented } from "../errors.ts";
import { ThreadId } from "../ids.ts";

/**
 * An RPC's error union, always ending in `NotImplemented` so handlers can land one at a time.
 * Chosen over a group-wide `RpcMiddleware` error, which would make every server and test layer
 * provide a middleware implementation just to widen the error type.
 */
export const errors = <const E extends ReadonlyArray<Schema.Constraint>>(...members: E) =>
  Schema.Union([...members, NotImplemented]);

/** A count or a size that has to be at least one. */
export const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

/** The payload of an RPC about one thread. */
export const threadRef = { threadId: ThreadId };
