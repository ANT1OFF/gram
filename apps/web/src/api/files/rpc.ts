import { run, type RpcContext } from "../rpc-client";
import { serverUrl } from "../server-base";
import type { FilesApi } from "./types";

/**
 * A joined machine's folders, over the local-only `/machines/*` routes rather than the RPC socket a
 * paired phone shares: a phone never lists or checks another machine's folders. A refusal comes
 * back as the contract's error (`_tag`, `message`), as `folderProblem` reads it.
 */
const machineFolders = async <A>(path: string, body: object): Promise<A> => {
  const response = await fetch(serverUrl(path), {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const value: unknown = await response.json().catch(() => undefined);
  if (response.ok) return value as A;
  const error =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  throw Object.assign(
    new Error(
      typeof error["message"] === "string"
        ? error["message"]
        : "Couldn't read that machine's folders.",
    ),
    error,
  );
};

/** `FilesApi` over the RPC client. */
export const filesRpc = ({ client }: RpcContext): FilesApi => ({
  browse: (path, limit) =>
    run(client["fs.browse"](limit === undefined ? { path } : { path, limit })),
  browseOn: (hostId, path, limit) =>
    machineFolders("/machines/folders/browse", {
      id: hostId,
      path,
      ...(limit === undefined ? {} : { limit }),
    }),
  checkFolderOn: (hostId, path) => machineFolders("/machines/folders/check", { id: hostId, path }),
  fsList: (path, options = {}) => run(client["fs.list"]({ path, ...options })),
  fsFile: (path, options = {}) => run(client["fs.file"]({ path, ...options })),
  fsSearch: (threadId, query, options = {}) =>
    run(client["fs.search"]({ threadId, query, ...options })),
  fsFiles: (target) => run(client["fs.files"](target)),
  projectVocabulary: (threadId) => run(client["fs.vocabulary"]({ threadId })),
  fsResolve: (threadId, paths) => run(client["fs.resolve"]({ threadId, paths })),
  previewFile: (threadId, path) => run(client["fs.preview"]({ threadId, path })),
  fsImage: (path, options = {}) => run(client["fs.image"]({ path, ...options })),
  openInEditor: (path, options = {}) => run(client["editor.open"]({ path, ...options })),
  revealPath: (path, options = {}) => run(client["fs.reveal"]({ path, ...options })),
  listOutputs: (workspaceId, options = {}) =>
    run(client["workspace.outputs"]({ workspaceId, ...options })),
});
