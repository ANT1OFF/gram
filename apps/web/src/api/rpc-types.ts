import type { GramRpcs } from "@gram/contracts";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";

type Rpcs = RpcGroup.Rpcs<typeof GramRpcs>;

/** An RPC's tag, e.g. `"terminal.open"`. */
type RpcTag = Rpcs["_tag"];

/**
 * What an RPC takes, from its contract, for an `Api` method that passes it straight through rather
 * than a hand-copied interface that can drift from it.
 */
export type RpcPayload<Tag extends RpcTag> = Rpc.PayloadConstructor<Rpc.ExtractTag<Rpcs, Tag>>;
