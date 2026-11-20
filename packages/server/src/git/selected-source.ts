// A user-approved selection of a check's source: the manifest that names the complete candidate
// tree, and the verification of what was materialized from it. Omitted paths are never opened.
import type { ProjectLocalCheck } from "@gram/contracts";
import { realPathSync } from "@gram/git";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
} from "node:fs";
import * as nodePath from "node:path";

/** A user-approved selection enumerates the complete candidate tree; omitted bytes are never read. */
export interface SelectedSource {
  path: string;
  mode: string;
  oid: string;
  selected: boolean;
}
function protectedSourceName(path: string): boolean {
  const parts = path.toLowerCase().split("/");
  const name = parts.at(-1)!;
  return (
    parts.some((part) =>
      [".ssh", ".aws", ".gnupg", "secret-manifest", "credential-store", "credentials"].includes(
        part,
      ),
    ) ||
    name.startsWith(".env") ||
    name.includes(".env.") ||
    /(?:private[_.-]?key|credential|password|mnemonic|seed[_.-]?phrase|keystore|api[_.-]?(?:key|token)|access[_.-]?token|refresh[_.-]?token)/i.test(
      name,
    ) ||
    (name.includes("wallet") && /\.(?:json|toml|yaml|yml|ini|db)$/.test(name)) ||
    /\.(?:env|key|pem|p12|pfx|jks|keystore)$/.test(name) ||
    /^(?:id_rsa|id_ed25519|id_ecdsa)/.test(name) ||
    ["secrets.json", "secrets.toml", ".npmrc", ".pypirc", ".netrc", ".git-credentials"].includes(
      name,
    )
  );
}
/** Verify materialized bytes and modes without opening any omitted path. */
export function verifySelectedWorktree(
  root: string,
  selection: ReadonlyArray<SelectedSource>,
): void {
  const expected = new Map(selection.filter((row) => row.selected).map((row) => [row.path, row]));
  const directories = new Set<string>();
  for (const path of expected.keys()) {
    const parts = path.split("/");
    for (let end = 1; end < parts.length; end++) directories.add(parts.slice(0, end).join("/"));
  }
  const seen = new Set<string>();
  const visit = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      if (!prefix && name === ".git") continue;
      const relative = prefix ? `${prefix}/${name}` : name;
      const path = nodePath.join(dir, name);
      const metadata = lstatSync(path);
      if (metadata.isDirectory()) {
        if (!directories.has(relative)) throw new Error("unexpected selected worktree directory");
        visit(path, relative);
        continue;
      }
      const row = expected.get(relative);
      if (row === undefined || !metadata.isFile() || metadata.isSymbolicLink())
        throw new Error("unexpected selected worktree path");
      const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const before = fstatSync(fd);
        const mode = (before.mode & 0o111) !== 0 ? "100755" : "100644";
        if (
          !before.isFile() ||
          mode !== row.mode ||
          before.dev !== metadata.dev ||
          before.ino !== metadata.ino
        )
          throw new Error("selected worktree mode differs");
        const hash = createHash("sha1").update(`blob ${before.size}\0`);
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let bytes = 0;
        for (;;) {
          const count = readSync(fd, buffer, 0, buffer.length, null);
          if (count === 0) break;
          bytes += count;
          hash.update(buffer.subarray(0, count));
        }
        const after = fstatSync(fd);
        if (
          bytes !== before.size ||
          hash.digest("hex") !== row.oid ||
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs
        )
          throw new Error("selected worktree bytes differ");
      } finally {
        closeSync(fd);
      }
      seen.add(relative);
    }
  };
  visit(root, "");
  if (seen.size !== expected.size) throw new Error("selected worktree membership differs");
}

export function selectedSourceManifest(
  preparation: NonNullable<ProjectLocalCheck["preparation"]>,
  head: string,
  base: string,
  tree?: string,
): { tree: string; entries: Array<SelectedSource> } {
  const path = preparation.manifest;
  if (process.platform !== "linux") throw new Error("selected-source preparation requires Linux");
  if (
    !nodePath.isAbsolute(path) ||
    nodePath.normalize(path) !== path ||
    realPathSync(path) !== path ||
    protectedSourceName(path)
  )
    throw new Error("unsafe selected-source manifest path");
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > 8 * 1024 * 1024 || before.size <= 0)
      throw new Error("invalid selected-source manifest");
    const raw = readFileSync(fd);
    const after = fstatSync(fd);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      createHash("sha256").update(raw).digest("hex") !== preparation.sha256
    )
      throw new Error("selected-source manifest identity differs");
    const doc: unknown = JSON.parse(raw.toString("utf8"));
    if (typeof doc !== "object" || doc === null || Array.isArray(doc))
      throw new Error("invalid selected-source document");
    const v = doc as Record<string, unknown>;
    if (
      Object.keys(v).toSorted().join(",") !== "base,entries,head,schema,tree" ||
      v.schema !== "gram.selected-source/v1" ||
      v.head !== head ||
      v.base !== base ||
      typeof v.tree !== "string" ||
      !/^[a-f0-9]{40}$/.test(v.tree) ||
      (tree !== undefined && v.tree !== tree) ||
      !Array.isArray(v.entries) ||
      v.entries.length === 0 ||
      v.entries.length > 100_000
    )
      throw new Error("selected-source candidate identity differs");
    const rows: Array<SelectedSource> = [];
    const seen = new Set<string>();
    for (const item of v.entries as Array<unknown>) {
      if (typeof item !== "object" || item === null || Array.isArray(item))
        throw new Error("invalid selected-source entry");
      const row = item as Record<string, unknown>;
      if (
        Object.keys(row).toSorted().join(",") !== "mode,oid,path,selected" ||
        typeof row.path !== "string" ||
        !row.path ||
        row.path.startsWith("/") ||
        /[^\x20-\x7e]|\\/.test(row.path) ||
        row.path
          .split("/")
          .some(
            (part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git",
          ) ||
        seen.has(row.path) ||
        typeof row.mode !== "string" ||
        !["100644", "100755", "120000"].includes(row.mode) ||
        typeof row.oid !== "string" ||
        !/^[a-f0-9]{40}$/.test(row.oid) ||
        typeof row.selected !== "boolean" ||
        (!row.selected && row.path.split("/").at(-1) === ".gitattributes") ||
        (row.selected && (row.mode === "120000" || protectedSourceName(row.path)))
      )
        throw new Error("unsafe selected-source entry");
      seen.add(row.path);
      rows.push(row as unknown as SelectedSource);
    }
    if (
      !rows.some((row) => row.selected) ||
      rows.filter((row) => !row.selected).length > 4096 ||
      rows.some((row, index) => index > 0 && rows[index - 1]!.path >= row.path)
    )
      throw new Error("invalid selected-source bounds or order");
    const canonical = JSON.stringify({
      schema: "gram.selected-source/v1",
      head,
      base,
      tree: v.tree,
      entries: rows.map((row) => ({
        path: row.path,
        mode: row.mode,
        oid: row.oid,
        selected: row.selected,
      })),
    });
    if (raw.toString("utf8") !== canonical)
      throw new Error("noncanonical selected-source manifest");
    return { tree: v.tree as string, entries: rows };
  } finally {
    closeSync(fd);
  }
}
