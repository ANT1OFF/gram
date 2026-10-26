// The fonts shell module's main half: the installed font families, for the font fields
// (`listFonts`). Listed by each platform's own tool, once per run.

import { win32 } from "node:path";

import { Channels } from "../../channels.ts";
import type { ShellIpc } from "../ipc.ts";
import { boundedRun, type RunCommand } from "../run.ts";

// `system_profiler` takes a few seconds and its JSON runs to megabytes on a well-stocked Mac.
const runCommand = boundedRun({ timeoutMs: 20_000, maxOutputBytes: 64 * 1024 * 1024 });

const uniqueSorted = (names: readonly unknown[]): string[] =>
  [
    ...new Set(
      names
        .filter((name): name is string => typeof name === "string")
        .map((name) => name.trim())
        // Dot-prefixed families (`.SF NS`) are macOS-private and can't be referenced from CSS.
        .filter((name) => name !== "" && !name.startsWith(".")),
    ),
  ].toSorted((a, b) => a.localeCompare(b));

/** Family names from `system_profiler SPFontsDataType -json`. */
export function parseMacFonts(json: string): string[] {
  const data = JSON.parse(json) as {
    SPFontsDataType?: ReadonlyArray<{ typefaces?: ReadonlyArray<{ family?: unknown }> }>;
  };
  return uniqueSorted(
    (data.SPFontsDataType ?? []).flatMap((font) => (font.typefaces ?? []).map((t) => t.family)),
  );
}

/** One family per line; fc-list separates localized names with commas, so the first one wins. */
export function parseLineFonts(output: string): string[] {
  return uniqueSorted(output.split(/\r?\n/).map((line) => line.split(",")[0]));
}

const WINDOWS_SCRIPT =
  // Redirected, Windows PowerShell writes the OEM code page, which garbles non-ASCII family names.
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8; " +
  "Add-Type -AssemblyName System.Drawing; " +
  "(New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }";

/** Windows PowerShell by full path, so no other `powershell.exe` on PATH or in the cwd runs. */
export const windowsPowerShell = (env: NodeJS.ProcessEnv): string =>
  win32.join(
    env["SystemRoot"] ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );

/** The installed families for `platform`; empty when the platform's lister fails. */
export async function listInstalledFonts(
  platform: NodeJS.Platform,
  run: RunCommand = runCommand,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  try {
    if (platform === "darwin") {
      return parseMacFonts(await run("system_profiler", ["SPFontsDataType", "-json"]));
    }
    if (platform === "win32") {
      return parseLineFonts(
        await run(windowsPowerShell(env), [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          WINDOWS_SCRIPT,
        ]),
      );
    }
    return parseLineFonts(await run("fc-list", [":", "family"]));
  } catch {
    return [];
  }
}

let cached: Promise<string[]> | undefined;

/** Listed once per app run, on first request; `system_profiler` takes a few seconds. */
export const installedFonts = (): Promise<string[]> =>
  (cached ??= listInstalledFonts(process.platform));

/** Serves `listFonts`. */
export function installFonts(ipc: ShellIpc): void {
  ipc.handle(Channels.listFonts, () => installedFonts());
}
