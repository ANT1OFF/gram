import type { LaunchSpec } from "../platform/opener.ts";

const OPEN_COMMANDS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "open",
  win32: "explorer.exe",
};

/** Opens `path` in the OS file manager: `open`, `explorer.exe` or `xdg-open`. */
export const openFolderCommand = (path: string, platform: NodeJS.Platform): LaunchSpec => ({
  file: OPEN_COMMANDS[platform] ?? "xdg-open",
  args: [path],
  window: true,
});
