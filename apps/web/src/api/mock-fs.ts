import {
  isCredentialFolder,
  type FolderAccessDenial,
  type FolderListing,
  type HostFolderChecked,
  type Project,
  type ProjectId,
} from "@gram/contracts";

export const MOCK_HOME = "/Users/dev";
export const MOCK_FOLDER_LIMIT = 500;

interface Node {
  kind: "dir" | "file";
  children?: Record<string, Node>;
  git?: boolean;
  denied?: boolean;
}

const file: Node = { kind: "file" };
const dir = (children: Record<string, Node> = {}, extra: Partial<Node> = {}): Node => ({
  kind: "dir",
  children,
  ...extra,
});
const repo = (children: Record<string, Node> = {}) =>
  dir({ ".git": dir(), "README.md": file, ...children }, { git: true });

const TREE = dir({
  Users: dir({
    dev: dir({
      ".config": dir(),
      Desktop: dir(),
      Downloads: dir({ "installer.dmg": file }),
      Documents: dir({
        Private: dir({}, { denied: true }),
        code: dir({
          "client-app": repo(),
          infra: repo(),
          sandbox: dir({ "notes.md": file }),
          "graph-tools": dir(),
          gram: repo({ next: dir({ apps: dir(), packages: dir() }) }),
          "README.md": file,
        }),
      }),
      code: dir({ api: repo(), docs: repo(), "example-device-apps": repo(), web: repo() }),
    }),
  }),
});

/** A joined machine's home in the mock, a Linux one's. */
export const MOCK_MACHINE_HOME = "/home/dev";
/** Its Gram Host's own folder, which a one-off thread never runs in. */
const MOCK_MACHINE_HOST_HOME = `${MOCK_MACHINE_HOME}/.config/gram-host`;

/** Every joined machine's disk in the mock: one synthetic Linux home. */
const MACHINE_TREE = dir({
  home: dir({
    dev: dir({
      ".ssh": dir({ id_ed25519: file }),
      ".config": dir({ "gram-host": dir({ repos: dir() }), nvim: dir() }),
      Downloads: dir(),
      scratch: dir({ "notes.md": file }),
      code: dir({ dotfiles: repo(), homelab: repo(), sandbox: dir() }),
    }),
  }),
  srv: dir({ media: dir() }),
});

/** A folder tree and its home: this Mac's, or a joined machine's. */
interface MockDisk {
  readonly tree: Node;
  readonly home: string;
}

const MAC: MockDisk = { tree: TREE, home: MOCK_HOME };
const MACHINE: MockDisk = { tree: MACHINE_TREE, home: MOCK_MACHINE_HOME };

/** Shaped like the contract's `NotFound` for a missing folder. */
export class MockNotFound extends Error {
  readonly _tag = "NotFound";
  readonly entity = "project";
  readonly id: string;

  constructor(id: string) {
    super(`Folder not found: ${id}`);
    this.id = id;
  }
}

/** Shaped like the contract's `InvalidState`. */
export class MockInvalidState extends Error {
  readonly _tag = "InvalidState";
  readonly access: FolderAccessDenial | undefined;
  readonly folderMissing: { readonly path: string } | undefined;

  constructor(
    message: string,
    access?: FolderAccessDenial,
    folderMissing?: { readonly path: string },
  ) {
    super(message);
    this.access = access;
    this.folderMissing = folderMissing;
  }
}

const segments = (path: string) => path.split("/").filter(Boolean);
const parentOf = (path: string) => `/${segments(path).slice(0, -1).join("/")}`;
const join = (parent: string, name: string) => (parent === "/" ? `/${name}` : `${parent}/${name}`);

/** Expands `~`, resolves `.` / `..` and trailing slashes; relative paths start at home. */
export function resolveMockPath(path: string, home: string = MOCK_HOME): string {
  const trimmed = path.trim();
  const expanded =
    trimmed === "~" || trimmed.startsWith("~/")
      ? home + trimmed.slice(1)
      : trimmed.startsWith("/")
        ? trimmed
        : `${home}/${trimmed}`;
  const out: string[] = [];
  for (const segment of segments(expanded)) {
    if (segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return `/${out.join("/")}`;
}

function lookup(path: string, tree: Node = TREE): Node | undefined {
  let node: Node | undefined = tree;
  for (const segment of segments(path)) node = node?.children?.[segment];
  return node;
}

/** An existing, readable folder for `input`, rejecting as the server's `resolveFolder` does. */
export function resolveMockFolder(input: string, disk: MockDisk = MAC): string {
  const path = resolveMockPath(input, disk.home);
  const node = lookup(path, disk.tree);
  if (!node) throw new MockNotFound(path);
  if (node.kind !== "dir") throw new MockInvalidState(`Not a folder: ${path}`);
  if (node.denied) {
    throw new MockInvalidState(
      `Gram can't read ${path}. Allow it in System Settings → Privacy & Security → Files & Folders.`,
      { path, code: "EPERM" },
    );
  }
  return path;
}

/**
 * `fs.browse`: a path ending in `/` (or `~`) lists that folder; otherwise its last segment filters
 * the parent by case-insensitive prefix. Folders only; dotfolders only for a `.` prefix.
 */
export function browseMockFs(
  input: string,
  limit = MOCK_FOLDER_LIMIT,
  disk: MockDisk = MAC,
): FolderListing {
  const trimmed = input.trim() === "" ? "~/" : input.trim();
  const listWhole = trimmed === "~" || trimmed.endsWith("/");
  const expanded = resolveMockPath(trimmed, disk.home);
  const folder = resolveMockFolder(listWhole ? expanded : parentOf(expanded), disk);
  const prefix = listWhole ? "" : (segments(expanded).at(-1) ?? "");
  const lowered = prefix.toLowerCase();
  const matches = Object.entries(lookup(folder, disk.tree)?.children ?? {})
    .filter(
      ([name, node]) => node.kind === "dir" && (!name.startsWith(".") || prefix.startsWith(".")),
    )
    .filter(([name]) => name.toLowerCase().startsWith(lowered))
    .toSorted(([a], [b]) => a.localeCompare(b));
  return {
    path: folder,
    ...(folder === "/" ? {} : { parent: parentOf(folder) }),
    ...(lookup(folder, disk.tree)?.git === true ? { git: "repository" as const } : {}),
    entries: matches
      .slice(0, limit)
      .map(([name, node]) => ({ name, path: join(folder, name), isGitRepo: node.git === true })),
    truncated: matches.length > limit,
  };
}

/** Why a joined machine's host hides `path` from its picker, as `hiddenFolder` does there. */
const machineHidden = (path: string): string | undefined =>
  isCredentialFolder(path)
    ? `Gram doesn't run a chat in ${path}: it holds keys or credentials.`
    : path === MOCK_MACHINE_HOST_HOME || path.startsWith(`${MOCK_MACHINE_HOST_HOME}/`)
      ? `Gram doesn't run a chat in ${path}: it is Gram Host's own folder.`
      : undefined;

/** `fs.browse` with a joined machine's `hostId`: its host's listing, refusals and all. */
export function browseMockMachine(input: string, limit = MOCK_FOLDER_LIMIT): FolderListing {
  const listing = browseMockFs(input, limit, MACHINE);
  const hidden = machineHidden(listing.path);
  if (hidden !== undefined) throw new MockInvalidState(hidden);
  return {
    ...listing,
    entries: listing.entries.filter((entry) => machineHidden(entry.path) === undefined),
  };
}

/** `fs.checkFolder`: whether a one-off thread may run in `input` on the joined machine. */
export function checkMockMachineFolder(input: string): HostFolderChecked {
  const path = resolveMockPath(input, MOCK_MACHINE_HOME);
  if (path === "/") throw new MockInvalidState("Gram doesn't run a chat in the whole filesystem.");
  const hidden = machineHidden(path);
  if (hidden !== undefined) throw new MockInvalidState(hidden);
  resolveMockFolder(path, MACHINE);
  return lookup(path, MACHINE_TREE)?.git === true ? { path, branch: "main" } : { path };
}

/** Puts a fresh repository at `path`, as a clone would; its parent folders are made as needed. */
export function addMockRepo(path: string): void {
  let node = TREE;
  for (const segment of segments(path)) {
    node.children ??= {};
    node = node.children[segment] ??= dir();
  }
  Object.assign(node, repo());
}

/** Whether anything is at `path`. */
export const mockPathExists = (path: string): boolean =>
  lookup(resolveMockPath(path)) !== undefined;

/** Whether a mock folder is a git repo. */
export const isMockRepo = (path: string): boolean => lookup(resolveMockPath(path))?.git === true;

/** The repositories directly in a mock folder, as `projects.repositories` scans one. */
export function mockReposIn(folder: string): string[] {
  const path = resolveMockPath(folder);
  return Object.entries(lookup(path)?.children ?? {})
    .filter(([, node]) => node.git === true)
    .map(([name]) => join(path, name));
}

/** A project record for a folder opened for the first time. */
export function mockProject(root: string, id: string): Project {
  return {
    id: id as ProjectId,
    root,
    name: segments(root).at(-1) ?? root,
    ...(lookup(root)?.git ? { repoRoot: root } : {}),
    bookmarked: false,
    lastOpenedAt: Date.now(),
  };
}
