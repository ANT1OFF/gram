import { run, type RpcContext } from "../rpc-client";
import type { PeopleApi } from "./types";

/** `PeopleApi` over the RPC client. */
export const peopleRpc = ({ client }: RpcContext): PeopleApi => ({
  peopleNames: (ids) => run(client["people.names"]({ ids: [...ids] })),
});
