import {
  checkoutRoots,
  effectiveCheckout,
  isCredentialPath,
  previewFileKind,
  type FsPreview,
  type ThreadId,
} from "@gram/contracts";

import {
  expandMockHome,
  listMockFileNames,
  listMockFiles,
  readMockFile,
  readMockImage,
  resolveInCheckout,
  resolveMockFileRefs,
  searchMockFiles,
} from "../mock-files";
import { browseMockFs } from "../mock-fs";
import { mockOutputImage, mockOutputText, pageMockOutputs } from "../mock-outputs";
import type { MockWorld } from "../mock-world";
import type { FilesApi } from "./types";

/** What the e2e specs read back through `window.gramMock`. */
export interface FilesMockControls {
  /** What "Open in editor" asked for; the mock never launches anything. */
  readonly editorOpens: { path: string; line?: number; threadId?: ThreadId }[];
  readonly reveals: { path: string; threadId?: ThreadId }[];
  /**
   * Where an HTML file previews from, by its path, as the server's preview listener would serve it;
   * a spec points one at a page it serves. A file not listed gets an address nothing answers.
   */
  readonly previewUrls: Record<string, string>;
  /**
   * Files a spec put in a checkout, by absolute path, read through the same scoping as the fixture
   * tree: a mock's real screenshots (`base64`) and its `mock.json` (`text`).
   */
  readonly checkoutFiles: Record<
    string,
    { readonly mediaType?: string; readonly base64?: string; readonly text?: string }
  >;
  /**
   * Dev and e2e hook: puts `files`, by name, in `folder` of `threadId`'s checkout, as a worker's
   * mock leaves them there; returns the folder's absolute path.
   */
  simulateCheckoutFiles(
    threadId: ThreadId,
    folder: string,
    files: FilesMockControls["checkoutFiles"],
  ): string;
}

/** What a thread's Write calls put in `path`, as `simulateWrittenFile` left it; latest wins. */
const writtenBy = (
  messages: readonly { readonly parts: readonly unknown[] }[],
  path: string,
): string | undefined => {
  let content: string | undefined;
  for (const message of messages) {
    for (const part of message.parts) {
      if (typeof part !== "object" || part === null) continue;
      if (Reflect.get(part, "type") !== "tool-Write") continue;
      const input: unknown = Reflect.get(part, "input");
      if (typeof input !== "object" || input === null) continue;
      if (Reflect.get(input, "file_path") !== path) continue;
      const written: unknown = Reflect.get(input, "content");
      content = typeof written === "string" ? written : "";
    }
  }
  return content;
};

/** The server's `InvalidState`, as a rejection. */
const invalid = (message: string) => Object.assign(new Error(message), { _tag: "InvalidState" });

/** `FilesApi` over the mock's fixture tree, scoped to threads' checkouts as the server scopes it. */
export function createFilesMock(world: MockWorld): FilesApi & FilesMockControls {
  const editorOpens: FilesMockControls["editorOpens"] = [];
  const reveals: FilesMockControls["reveals"] = [];
  const previewUrls: FilesMockControls["previewUrls"] = {};
  const checkoutFiles: FilesMockControls["checkoutFiles"] = {};
  const thread = (threadId: ThreadId) => world.summary(threadId).thread;
  const threadPath = (path: string, threadId: ThreadId | undefined) =>
    threadId ? resolveInCheckout(path, thread(threadId).checkout.path) : path;
  /**
   * Whether `threadId`'s messages name `path`, in their text or a finished Write, as the server
   * checks before reading outside.
   */
  const mentioned = (threadId: ThreadId, path: string) => {
    const forms = [path, expandMockHome(path), path.replace(/^\/Users\/dev(?=\/)/, "~")];
    return (
      world
        .messages(threadId)
        .some((message) =>
          message.parts.some(
            (part) => part.type === "text" && forms.some((form) => part.text.includes(form)),
          ),
        ) || writtenBy(world.messages(threadId), expandMockHome(path)) !== undefined
    );
  };
  /** Whether `path` is absolute and in none of `threadId`'s checkouts. */
  const outsideCheckouts = (path: string, threadId: ThreadId) => {
    const expanded = expandMockHome(path);
    return (
      expanded.startsWith("/") &&
      ![thread(threadId).checkout.path, ...checkoutRoots(thread(threadId))].some((root) =>
        expanded.startsWith(`${root}/`),
      )
    );
  };
  /**
   * As the server scopes `fs.file` and `fs.image`: a relative path in the first root (for an image
   * the thread's own checkout), an absolute one in whichever root holds it, and one in none only
   * when the thread's messages name it and it's no credential file.
   */
  const rootedPath = (path: string, threadId: ThreadId | undefined, image = false) => {
    if (threadId === undefined) throw invalid("Open a file from a thread to preview it");
    const expanded = expandMockHome(path);
    if (outsideCheckouts(path, threadId)) {
      if (!mentioned(threadId, path)) {
        throw invalid(`${path} is outside this thread's folder and not in its messages`);
      }
      if (isCredentialPath(expanded)) {
        throw invalid(`Gram doesn't preview files that may hold credentials: ${expanded}`);
      }
      return expanded;
    }
    const { checkout } = thread(threadId);
    const roots = [
      ...new Set([...(image ? [checkout.path] : []), ...checkoutRoots(thread(threadId))]),
    ];
    const root = roots.find((candidate) => path.startsWith(`${candidate}/`)) ?? roots[0]!;
    return resolveInCheckout(path, root);
  };

  return {
    editorOpens,
    reveals,
    previewUrls,
    checkoutFiles,
    simulateCheckoutFiles: (threadId, folder, files) => {
      const base = resolveInCheckout(folder, effectiveCheckout(thread(threadId)).path);
      for (const [name, file] of Object.entries(files)) checkoutFiles[`${base}/${name}`] = file;
      return base;
    },
    browse: async (path, limit) => {
      await world.delay(20);
      return browseMockFs(path, limit);
    },
    fsList: async (path, options = {}) => {
      await world.delay(20);
      return listMockFiles(threadPath(path, options.threadId), options);
    },
    fsFile: async (path, options = {}) => {
      await world.delay(20);
      // A document the Files view lists, as the thread "wrote" it.
      const made = mockOutputText(world, options.threadId, path);
      if (made !== undefined) {
        return { path, size: made.length, binary: false, tooLarge: false, content: made };
      }
      const target = rootedPath(path, options.threadId);
      const placed = checkoutFiles[target]?.text;
      if (placed !== undefined) {
        return {
          path: target,
          size: placed.length,
          binary: false,
          tooLarge: false,
          content: placed,
        };
      }
      // A file the agent wrote outside the fixture tree reads as it wrote it, as on disk.
      const written =
        options.threadId === undefined
          ? undefined
          : writtenBy(world.messages(options.threadId), target);
      if (written !== undefined && outsideCheckouts(target, options.threadId!)) {
        return {
          path: target,
          size: written.length,
          binary: false,
          tooLarge: false,
          content: written,
        };
      }
      return readMockFile(target, options);
    },
    fsResolve: async (threadId, paths) => {
      await world.delay(20);
      return resolveMockFileRefs(paths, checkoutRoots(thread(threadId)), (path) =>
        mentioned(threadId, path),
      );
    },
    fsSearch: async (threadId, query, options = {}) => {
      await world.delay(30);
      return searchMockFiles(thread(threadId).checkout.path, query, options);
    },
    fsFiles: async (target) => {
      await world.delay(20);
      return listMockFileNames(
        "threadId" in target ? effectiveCheckout(thread(target.threadId)).path : target.path,
      );
    },
    previewFile: async (threadId, path): Promise<FsPreview> => {
      await world.delay(20);
      const kind = previewFileKind(path);
      if (kind === undefined) throw invalid(`${path} isn't Markdown or HTML`);
      const written = writtenBy(world.messages(threadId), path);
      // The server holds a file outside the thread's folders to a Write, not a mention.
      if (written === undefined && outsideCheckouts(path, threadId)) {
        throw invalid(`${path} is outside this thread's folders, and the thread didn't write it`);
      }
      const target = written === undefined ? rootedPath(path, threadId) : path;
      if (kind === "html") {
        const name = target.split("/").at(-1) ?? "index.html";
        return {
          kind,
          path: target,
          url: previewUrls[target] ?? `http://127.0.0.1:9/gram-preview-files/mock/${name}`,
        };
      }
      const content = written ?? readMockFile(target, {}).content;
      if (content === undefined) throw invalid(`${path} isn't text`);
      return { kind, path: target, content };
    },
    fsImage: async (path, options = {}) => {
      await world.delay(20);
      // A picture the Files view lists, drawn for the thread that "made" it.
      const made = mockOutputImage(world, options.threadId, path, "image");
      if (made !== undefined) return made;
      const target = rootedPath(path, options.threadId, true);
      const placed = checkoutFiles[target];
      if (placed?.base64 !== undefined) {
        return {
          path: target,
          mediaType: placed.mediaType ?? "image/png",
          size: Math.round((placed.base64.length * 3) / 4),
          tooLarge: false,
          base64: placed.base64,
        };
      }
      return readMockImage(target, options);
    },
    openInEditor: async (path, options = {}) => {
      await world.delay(10);
      editorOpens.push({ path, ...options });
      return { editor: "VS Code" };
    },
    revealPath: async (path, options = {}) => {
      await world.delay(10);
      reveals.push({ path, ...options });
      return { manager: "Finder" };
    },
    listOutputs: async (workspaceId, options = {}) => {
      await world.delay(30);
      return pageMockOutputs(world, workspaceId, options);
    },
  };
}
