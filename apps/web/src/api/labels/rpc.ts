import { run, type RpcContext } from "../rpc-client";
import type { LabelsApi } from "./types";

/** `LabelsApi` over the RPC client. */
export const labelsRpc = ({ client }: RpcContext): LabelsApi => ({
  labels: () => run(client["labels.list"](undefined)),
  upsertLabel: (label) => run(client["labels.upsert"]({ label })),
  removeLabel: (labelId) => run(client["labels.remove"]({ labelId })),
});
