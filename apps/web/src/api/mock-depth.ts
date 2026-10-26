import type { AgentSessionSummary, KeybindingOverrides, KeybindingsState } from "@gram/contracts";

import { MOCK_HOME } from "./mock-fs";

const HOUR = 3_600_000;

/** Past Claude sessions per project root, as `sessions.list` returns them. */
export function mockSessions(
  projectRoot: string,
  agent: string,
  now = Date.now(),
): AgentSessionSummary[] {
  if (projectRoot !== "/Users/dev/code/api") return [];
  if (agent !== "claude") return [];
  return [
    {
      agentSessionId: "0b7c2a4e-1111-4c1a-9f00-000000000001",
      title: "Speed up the flaky retry suite",
      firstPrompt: "The retry tests take 40 s, make them fast.",
      updatedAt: now - 2 * HOUR,
      gitBranch: "fix/retry-speed",
      cwd: projectRoot,
    },
    {
      agentSessionId: "0b7c2a4e-2222-4c1a-9f00-000000000002",
      title: "Add request tracing",
      updatedAt: now - 26 * HOUR,
      gitBranch: "main",
      cwd: projectRoot,
    },
  ];
}

const STORAGE_KEY = "gram.mock.keybindings";

/** The e2e mock build seeds and keeps overrides in sessionStorage, so specs can start customised. */
const persistence = (): Storage | undefined =>
  import.meta.env["VITE_API"] === "mock" && typeof sessionStorage !== "undefined"
    ? sessionStorage
    : undefined;

/** In-memory `keybindings.get` / `.set` for MockApi. */
export function createMockKeybindings() {
  const storage = persistence();
  const path = `${MOCK_HOME}/Library/Application Support/Gram/keybindings.json`;
  const saved = storage?.getItem(STORAGE_KEY);
  let bindings: KeybindingOverrides = saved ? (JSON.parse(saved) as KeybindingOverrides) : {};
  const state = (): KeybindingsState => ({ path, bindings, problems: [] });
  return {
    get: state,
    set: (next: KeybindingOverrides) => {
      bindings = { ...next };
      storage?.setItem(STORAGE_KEY, JSON.stringify(bindings));
      return state();
    },
  };
}
