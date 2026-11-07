import { run, type RpcContext } from "../rpc-client";
import type { DocsApi } from "./types";

/** `DocsApi` over the RPC client. */
export const docsRpc = ({ client }: RpcContext): DocsApi => ({
  listDocs: (workspaceId) => run(client["docs.list"]({ workspaceId })),
  readDoc: (workspaceId, id) => run(client["docs.read"]({ workspaceId, id })),
  saveDoc: (workspaceId, id, content, revision) =>
    run(client["docs.save"]({ workspaceId, id, content, revision })),
});
