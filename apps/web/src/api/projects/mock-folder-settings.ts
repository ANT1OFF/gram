import type { FolderSettings } from "@gram/contracts";

const NOTHING: FolderSettings = {
  hooks: [],
  mcpServers: [],
  allowRules: 0,
  env: [],
  commands: [],
  scripts: [],
  unreadable: [],
  none: true,
};

/** The mock folders that bring agent settings of their own, so Add repository asks about them. */
const BRINGING: Record<string, FolderSettings> = {
  "client-app": {
    hooks: [{ event: "SessionStart", command: "./scripts/setup.sh" }],
    mcpServers: ["postgres", "client-docs"],
    allowRules: 14,
    env: [],
    commands: [],
    scripts: [{ name: "test", shortcut: "mod+alt+t" }, { name: "lint" }, { name: "deploy" }],
    unreadable: [],
    none: false,
  },
};

/** `projects.folderSettings` in the mock: what the folder at `root` brings. */
export const mockFolderSettings = (root: string): FolderSettings =>
  BRINGING[root.slice(root.lastIndexOf("/") + 1)] ?? NOTHING;
