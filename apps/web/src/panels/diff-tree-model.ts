import type { DiffFile } from "@gram/contracts";

interface DiffTreeDir {
  kind: "dir";
  /** One folder, or a chain of single-child folders shown as one (`src/panels`). */
  name: string;
  path: string;
  children: DiffTreeNode[];
}

interface DiffTreeFile {
  kind: "file";
  name: string;
  file: DiffFile;
}

export type DiffTreeNode = DiffTreeDir | DiffTreeFile;

const byName = (a: DiffTreeNode, b: DiffTreeNode) =>
  Number(b.kind === "dir") - Number(a.kind === "dir") ||
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

/** The changed files as folders, folders first, with each chain of lone subfolders compacted into one. */
export function buildDiffTree(files: readonly DiffFile[]): DiffTreeNode[] {
  const root: DiffTreeDir = { kind: "dir", name: "", path: "", children: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    const name = parts.pop()!;
    let dir = root;
    for (const part of parts) {
      const path = dir.path === "" ? part : `${dir.path}/${part}`;
      let next = dir.children.find(
        (child): child is DiffTreeDir => child.kind === "dir" && child.path === path,
      );
      if (!next) {
        next = { kind: "dir", name: part, path, children: [] };
        dir.children.push(next);
      }
      dir = next;
    }
    dir.children.push({ kind: "file", name, file });
  }
  const finish = (node: DiffTreeNode): DiffTreeNode => {
    if (node.kind === "file") return node;
    let dir = node;
    let only = dir.children[0];
    while (dir.children.length === 1 && only?.kind === "dir") {
      dir = { ...only, name: `${dir.name}/${only.name}` };
      only = dir.children[0];
    }
    return { ...dir, children: dir.children.map(finish).toSorted(byName) };
  };
  return root.children.map(finish).toSorted(byName);
}

/** The files in the order the tree shows them, top to bottom. */
export function treeOrder(nodes: readonly DiffTreeNode[]): DiffFile[] {
  return nodes.flatMap((node) => (node.kind === "file" ? [node.file] : treeOrder(node.children)));
}
