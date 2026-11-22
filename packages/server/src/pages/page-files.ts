import {
  InvalidState,
  pagePolicyHeaders,
  PAGES_ORIGIN_MESSAGE,
  PAGES_SEGMENT,
} from "@gram/contracts";
import { realPath } from "@gram/git";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import {
  emptyPreviewFolders,
  fileListener,
  grantFolder,
  handleFileRequest,
  type FileListenerRules,
} from "../preview/files.ts";

/** How many pinned versions keep a live token; opening another forgets the least recently opened. */
export const PAGE_FOLDERS_KEPT = 64;

/**
 * The headers of every answer from the listener at `origin`: the pages' policy
 * (`pagePolicyHeaders`), and what lets the page's opaque-origin documents load its own files. A
 * module script or a font loads in CORS mode, so those are allowed to that origin (`null`) only.
 */
export const pageHeaders =
  (origin: string): FileListenerRules["headers"] =>
  (requestOrigin) => ({
    ...pagePolicyHeaders(origin),
    "cache-control": "no-store",
    "cross-origin-resource-policy": "cross-origin",
    "cross-origin-opener-policy": "same-origin",
    ...(requestOrigin === "null" ? { "access-control-allow-origin": "null" } : {}),
  });

export interface PageFilesShape {
  /** The listener's origin, `http://127.0.0.1:<port>`, which the shell's `gram-pages` session loads. */
  readonly origin: string;
  /**
   * The URL of `entry` in `folder`, a pinned version's resolved folder in Gram's state: the same
   * token for as long as the folder keeps one. `InvalidState` for a folder that isn't one.
   */
  urlFor(folder: string, entry: string): Effect.Effect<string, InvalidState>;
}

/** The page listener: on its own loopback port, started with the server, closed with it. */
export class PageFiles extends Context.Service<PageFiles, PageFilesShape>()(
  "@gram/server/PageFiles",
) {
  static readonly layer: Layer.Layer<PageFiles> = Layer.effect(
    PageFiles,
    Effect.gen(function* () {
      const folders = emptyPreviewFolders();
      let origin = "";
      const port = yield* fileListener(
        handleFileRequest(folders, {
          segment: PAGES_SEGMENT,
          headers: (requestOrigin) => pageHeaders(origin)(requestOrigin),
        }),
      );
      origin = `http://127.0.0.1:${port}`;
      (process as { parentPort?: { postMessage(message: unknown): void } }).parentPort?.postMessage(
        { type: PAGES_ORIGIN_MESSAGE, origin },
      );
      return PageFiles.of({
        origin,
        urlFor: (folder, entry) =>
          Effect.tryPromise({
            try: async () => {
              if (!isAbsolute(folder) || (await realPath(folder)) !== folder) {
                throw new Error("not a resolved folder");
              }
              if (!(await stat(folder)).isDirectory()) throw new Error("not a folder");
              const token = await grantFolder(folders, folder, PAGE_FOLDERS_KEPT);
              const path = entry.split("/").map(encodeURIComponent).join("/");
              return `${origin}/${PAGES_SEGMENT}/${token}/${path}`;
            },
            catch: () => new InvalidState({ message: "That page's files can't be served" }),
          }),
      });
    }),
  );
}
