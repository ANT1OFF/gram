// A project's scripts (`.gram/scripts.json` in its folder) and what its `package.json` and
// Makefile suggest. Reading and saving the file runs nothing; a script runs only when the user
// clicks it or presses its key, through `terminal.open`'s `script`, which no agent tool sends.

import {
  LOCKFILE_NAMES,
  parseScriptsFile,
  type ProjectId,
  type ProjectScript,
  type ProjectScripts,
  SCRIPTS_FILE,
  scriptsFileText,
  scriptSuggestions,
  validateScripts,
} from "@gram/contracts";
import { isInside, realPath } from "@gram/git";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import type { ShellCommand } from "../terminal/shell.ts";

/** Why scripts can't be read, saved or run; its message is the user's to read. */
export class ScriptsError extends Error {}

/** The most bytes read from the scripts file, `package.json` or a Makefile. */
const READ_MAX = 512 * 1024;

const readText = async (path: string): Promise<string | undefined> => {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > READ_MAX) return undefined;
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
};

const MAKEFILES = ["GNUmakefile", "makefile", "Makefile"];

/** The scripts saved in `root`, and what else the project offers to add. */
export async function readProjectScripts(
  root: string,
  projectId: ProjectId,
): Promise<ProjectScripts> {
  const text = await readText(join(root, SCRIPTS_FILE));
  const parsed = text === undefined ? { scripts: [] } : parseScriptsFile(text);
  const scripts = "scripts" in parsed ? parsed.scripts : [];
  const lockfiles: string[] = [];
  for (const file of LOCKFILE_NAMES) {
    if ((await lstat(join(root, file)).catch(() => undefined))?.isFile() === true)
      lockfiles.push(file);
  }
  let makefile: string | undefined;
  for (const file of MAKEFILES) {
    makefile = await readText(join(root, file));
    if (makefile !== undefined) break;
  }
  return {
    projectId,
    file: SCRIPTS_FILE,
    scripts,
    suggestions: scriptSuggestions(
      { packageJson: await readText(join(root, "package.json")), makefile, files: lockfiles },
      scripts,
    ),
    ...("error" in parsed ? { problem: parsed.error } : {}),
  };
}

/**
 * Writes `scripts` to `root`'s scripts file, through a temporary file so a reader never sees half
 * of it. `.gram` and the file must be inside `root`: a link leading out of it is refused.
 */
export async function saveProjectScripts(
  root: string,
  projectId: ProjectId,
  scripts: readonly ProjectScript[],
): Promise<ProjectScripts> {
  const checked = validateScripts(scripts);
  if ("error" in checked) throw new ScriptsError(checked.error);
  const realRoot = await realPath(root).catch(() => {
    throw new ScriptsError(`The project's folder ${root} isn't there.`);
  });
  const target = join(realRoot, SCRIPTS_FILE);
  const folder = dirname(target);
  await mkdir(folder, { recursive: true }).catch((error: unknown) => {
    throw new ScriptsError(`Can't make ${dirname(SCRIPTS_FILE)}: ${String(error)}`);
  });
  const realFolder = await realPath(folder);
  if (!isInside(realRoot, realFolder))
    throw new ScriptsError(`${dirname(SCRIPTS_FILE)} leads outside the project.`);
  const existing = await lstat(target).catch(() => undefined);
  if (existing !== undefined && !existing.isFile())
    throw new ScriptsError(`${SCRIPTS_FILE} isn't a plain file, so Gram leaves it alone.`);
  const temporary = join(realFolder, `.${basename(target)}.${process.pid}.tmp`);
  try {
    await writeFile(temporary, scriptsFileText(checked.scripts), { encoding: "utf8", flag: "wx" });
    await rename(temporary, join(realFolder, basename(target)));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw new ScriptsError(`Can't save ${SCRIPTS_FILE}: ${String(error)}`);
  }
  return readProjectScripts(realRoot, projectId);
}

/** What a run of a script needs: its command, and the folder inside the checkout it runs in. */
export interface ScriptRun {
  readonly name: string;
  readonly command: string;
  readonly cwd: string;
}

/**
 * The script `name` from the project's own folder (`root`), to run in `checkout`: the thread's
 * worktree, or the project's folder itself. Its `cwd` must resolve inside the checkout.
 */
export async function resolveScriptRun(
  root: string,
  checkout: string,
  name: string,
): Promise<ScriptRun> {
  const text = await readText(join(root, SCRIPTS_FILE));
  if (text === undefined) throw new ScriptsError(`This project has no ${SCRIPTS_FILE}.`);
  const parsed = parseScriptsFile(text);
  if ("error" in parsed) throw new ScriptsError(parsed.error);
  const script = parsed.scripts.find((each) => each.name === name);
  if (script === undefined) throw new ScriptsError(`There is no script named ${name}.`);
  const realCheckout = await realPath(checkout).catch(() => {
    throw new ScriptsError(`The thread's folder ${checkout} isn't there.`);
  });
  const cwd = await realPath(resolve(realCheckout, script.cwd ?? ".")).catch(() => {
    throw new ScriptsError(`The folder ${script.cwd} isn't in this checkout.`);
  });
  if (!isInside(realCheckout, cwd))
    throw new ScriptsError(`The folder ${script.cwd} leads outside the checkout.`);
  return { name: script.name, command: script.command, cwd };
}

/**
 * The shell's arguments to run `command` once and exit with its status: `-c` after the login flag
 * for a POSIX shell, `-Command` for PowerShell, `/d /s /c` for cmd.
 */
export function scriptShellArgs(
  shell: ShellCommand,
  command: string,
  platform: NodeJS.Platform,
): readonly string[] {
  if (platform !== "win32") return [...shell.args.filter((arg) => arg !== "-i"), "-c", command];
  const name = basename(shell.file.replaceAll("\\", "/")).toLowerCase();
  if (name === "powershell.exe" || name === "pwsh.exe" || name === "powershell" || name === "pwsh")
    return ["-NoLogo", "-Command", command];
  if (name === "cmd.exe" || name === "cmd") return ["/d", "/s", "/c", command];
  return [...shell.args.filter((arg) => arg !== "-i"), "-c", command];
}
