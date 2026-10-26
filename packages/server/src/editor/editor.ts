import * as fs from "node:fs";
import { dirname } from "node:path";

export interface EditorTarget {
  readonly path: string;
  readonly line?: number | undefined;
  /** A folder never gets a line. */
  readonly folder: boolean;
}

export interface EditorCommand {
  /** For the "Opening in …" toast. */
  readonly name: string;
  readonly bin: string;
  readonly args: ReadonlyArray<string>;
}

const lineArgs = (flag: string) => (target: EditorTarget) =>
  target.line !== undefined && !target.folder
    ? [flag, `${target.path}:${target.line}`]
    : [target.path];

/** Editors whose CLI can jump to a line, keyed by the command's base name. */
const PRESETS: Readonly<
  Record<string, { readonly name: string; readonly args: (target: EditorTarget) => string[] }>
> = {
  code: { name: "VS Code", args: lineArgs("-g") },
  cursor: { name: "Cursor", args: lineArgs("-g") },
  zed: {
    name: "Zed",
    args: (t) => [t.line !== undefined && !t.folder ? `${t.path}:${t.line}` : t.path],
  },
  idea: {
    name: "IntelliJ IDEA",
    args: (t) =>
      t.line !== undefined && !t.folder ? ["--line", String(t.line), t.path] : [t.path],
  },
};

const DEFAULT_EDITOR_COMMAND = "code";

/** Splits a command line on whitespace, keeping "double-quoted" parts together. */
export const splitCommand = (command: string): string[] =>
  [...command.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2]!);

const commandBase = (bin: string) =>
  (bin.split(/[\\/]/).at(-1) ?? bin).replace(/\.(cmd|exe|bat|sh)$/i, "").toLowerCase();

/**
 * The launch for `settings.editor.command`. A preset CLI (`code`, `cursor`, `zed`, `idea`, extra flags
 * ignored) addresses the line its own way. Anything else is a template: `{path}` and `{line}` are
 * substituted (`{line}` defaults to 1), and without `{path}` the path is appended.
 */
export function editorCommand(command: string | undefined, target: EditorTarget): EditorCommand {
  const parts = splitCommand(command?.trim() || DEFAULT_EDITOR_COMMAND);
  const bin = parts[0] ?? DEFAULT_EDITOR_COMMAND;
  const templated = parts.some((part) => part.includes("{path}") || part.includes("{line}"));
  const preset = PRESETS[commandBase(bin)];
  if (preset && !templated) return { name: preset.name, bin, args: preset.args(target) };
  const line = String(target.line ?? 1);
  const args = parts
    .slice(1)
    .map((part) => part.replaceAll("{path}", target.path).replaceAll("{line}", line));
  if (!parts.some((part) => part.includes("{path}"))) args.push(target.path);
  return { name: commandBase(bin), bin, args };
}

export interface RevealCommand extends EditorCommand {
  /** Pass `args` to the program as-is on Windows, as `explorer /select,"…"` needs. */
  readonly verbatim: boolean;
}

/** Shows `path` in the file manager: selected in Finder or Explorer, else its folder opened. */
export function revealCommand(
  path: string,
  folder: boolean,
  platform: NodeJS.Platform,
): RevealCommand {
  if (platform === "darwin") {
    return { name: "Finder", bin: "open", args: ["-R", path], verbatim: false };
  }
  if (platform === "win32") {
    return { name: "Explorer", bin: "explorer.exe", args: [`/select,"${path}"`], verbatim: true };
  }
  return {
    name: "file manager",
    bin: "xdg-open",
    args: [folder ? path : dirname(path)],
    verbatim: false,
  };
}

export interface ResolvedBin {
  readonly file: string;
  /** Windows `.cmd` shims only run through the shell. */
  readonly shell: boolean;
}

/**
 * On Windows an editor CLI is usually a `.cmd` shim (`code.cmd`), else an `.exe`; find it on PATH.
 * Elsewhere, and for anything already carrying a separator or extension, the name passes through.
 */
export function resolveEditorBin(
  bin: string,
  platform: NodeJS.Platform,
  pathValue: string,
  exists: (path: string) => boolean = fs.existsSync,
): ResolvedBin {
  if (platform !== "win32") return { file: bin, shell: false };
  if (/[\\/]/.test(bin) || /\.[A-Za-z0-9]+$/.test(bin)) {
    return { file: bin, shell: /\.(cmd|bat)$/i.test(bin) };
  }
  for (const dir of pathValue.split(";")) {
    if (dir === "") continue;
    const base = `${dir.replace(/[\\/]+$/, "")}\\${bin}`;
    if (exists(`${base}.cmd`)) return { file: `${base}.cmd`, shell: true };
    if (exists(`${base}.exe`)) return { file: `${base}.exe`, shell: false };
  }
  return { file: `${bin}.cmd`, shell: true };
}
