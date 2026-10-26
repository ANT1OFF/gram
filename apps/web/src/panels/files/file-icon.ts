import {
  File,
  FileArchive,
  FileBraces,
  FileCode,
  FileCog,
  FileImage,
  FileKey,
  FileLock,
  FileSpreadsheet,
  FileSymlink,
  FileTerminal,
  FileText,
  FileType,
  Folder,
  FolderOpen,
  GitBranch,
  type LucideIcon,
} from "lucide-react";

export interface FileIcon {
  readonly icon: LucideIcon;
  /** A theme text colour; the muted one for files with nothing to tell apart. */
  readonly tone: string;
}

const MUTED = "text-muted-foreground";

const byExtension: ReadonlyArray<readonly [readonly string[], FileIcon]> = [
  [["md", "mdx", "markdown", "txt", "rst", "adoc"], { icon: FileText, tone: "text-info" }],
  [["json", "jsonc", "json5"], { icon: FileBraces, tone: "text-warning" }],
  [
    [
      "ts",
      "tsx",
      "mts",
      "cts",
      "js",
      "jsx",
      "mjs",
      "cjs",
      "py",
      "rs",
      "go",
      "swift",
      "kt",
      "java",
      "rb",
      "c",
      "h",
      "cc",
      "cpp",
      "hpp",
      "cs",
      "php",
      "vue",
      "svelte",
      "zig",
      "lua",
      "dart",
      "scala",
    ],
    { icon: FileCode, tone: "text-info" },
  ],
  [
    ["css", "scss", "sass", "less", "html", "htm", "xml", "svg"],
    { icon: FileCode, tone: "text-merged" },
  ],
  [
    ["sh", "bash", "zsh", "fish", "ps1", "bat", "cmd"],
    { icon: FileTerminal, tone: "text-success" },
  ],
  [["yaml", "yml", "toml", "ini", "cfg", "conf", "properties"], { icon: FileCog, tone: MUTED }],
  [["lock", "lockb"], { icon: FileLock, tone: MUTED }],
  [
    ["png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp", "heic"],
    { icon: FileImage, tone: "text-merged" },
  ],
  [["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar"], { icon: FileArchive, tone: MUTED }],
  [["csv", "tsv", "xlsx", "xls", "ods"], { icon: FileSpreadsheet, tone: "text-success" }],
  [["ttf", "otf", "woff", "woff2"], { icon: FileType, tone: MUTED }],
  [["pem", "key", "crt", "p12"], { icon: FileKey, tone: "text-warning" }],
];

const extensions = new Map(
  byExtension.flatMap(([names, icon]) => names.map((name) => [name, icon] as const)),
);

const LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml"]);

/**
 * The icon and colour a file tree row shows for `name`: by what the file is (git metadata, a
 * lockfile, an env file, a dotfile's config) before its extension.
 */
export function fileIcon(
  name: string,
  kind: "file" | "dir" | "symlink" | (string & {}),
  expanded = false,
): FileIcon {
  if (kind === "dir") return { icon: expanded ? FolderOpen : Folder, tone: MUTED };
  if (kind === "symlink") return { icon: FileSymlink, tone: MUTED };
  const lower = name.toLowerCase();
  if (lower.startsWith(".git")) return { icon: GitBranch, tone: "text-danger-text" };
  if (LOCKFILES.has(lower)) return { icon: FileLock, tone: MUTED };
  if (lower === ".env" || lower.startsWith(".env.")) return { icon: FileKey, tone: "text-warning" };
  const dot = lower.lastIndexOf(".");
  const extension = dot > 0 ? lower.slice(dot + 1) : undefined;
  const known = extension === undefined ? undefined : extensions.get(extension);
  if (known) return known;
  // `.npmrc`, `.editorconfig`, `.node-version`: a dotfile with no other extension is config.
  if (dot === 0) return { icon: FileCog, tone: MUTED };
  return { icon: File, tone: MUTED };
}
