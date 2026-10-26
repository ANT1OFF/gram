import { run, type RpcContext } from "../rpc-client";
import type { FilesApi } from "./types";

/** `FilesApi` over the RPC client. */
export const filesRpc = ({ client }: RpcContext): FilesApi => ({
  browse: (path, limit) =>
    run(client["fs.browse"](limit === undefined ? { path } : { path, limit })),
  fsList: (path, options = {}) => run(client["fs.list"]({ path, ...options })),
  fsFile: (path, options = {}) => run(client["fs.file"]({ path, ...options })),
  fsSearch: (threadId, query, options = {}) =>
    run(client["fs.search"]({ threadId, query, ...options })),
  fsFiles: (target) => run(client["fs.files"](target)),
  fsResolve: (threadId, paths) => run(client["fs.resolve"]({ threadId, paths })),
  previewFile: (threadId, path) => run(client["fs.preview"]({ threadId, path })),
  fsImage: (path, options = {}) => run(client["fs.image"]({ path, ...options })),
  openInEditor: (path, options = {}) => run(client["editor.open"]({ path, ...options })),
  revealPath: (path, options = {}) => run(client["fs.reveal"]({ path, ...options })),
  listOutputs: (workspaceId, options = {}) =>
    run(client["workspace.outputs"]({ workspaceId, ...options })),
});
