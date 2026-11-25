import { fieldsOf, FolderListing, HostFolderChecked } from "@gram/contracts";
import * as Schema from "effect/Schema";
import { run, type RpcContext } from "../rpc-client";
import { serverUrl } from "../server-base";
import type { FilesApi } from "./types";
import { withOriginKey } from "../origin-key";

const decodeListing = Schema.decodeUnknownSync(FolderListing);
const decodeChecked = Schema.decodeUnknownSync(HostFolderChecked);

const machineFolders = async <A>(
  decode: (value: unknown) => A,
  path: string,
  body: object,
): Promise<A> => {
  const response = await fetch(
    serverUrl(path),
    withOriginKey({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const value: unknown = await response.json().catch(() => undefined);
  if (response.ok) return decode(value);
  const error = typeof value === "object" && value !== null ? value : {};
  const message = fieldsOf(error).get("message");
  throw Object.assign(
    new Error(typeof message === "string" ? message : "Couldn't read that machine's folders."),
    error,
  );
};

/** `FilesApi` over the RPC client. */
export const filesRpc = ({ client }: RpcContext): FilesApi => ({
  browse: (path, limit) =>
    run(client["fs.browse"](limit === undefined ? { path } : { path, limit })),
  browseOn: (hostId, path, limit) =>
    machineFolders(decodeListing, "/machines/folders/browse", {
      id: hostId,
      path,
      ...(limit === undefined ? {} : { limit }),
    }),
  checkFolderOn: (hostId, path) =>
    machineFolders(decodeChecked, "/machines/folders/check", { id: hostId, path }),
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
