import type { ToolAudience } from "@gram/agents";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Gram's playbooks: how its tools fit together for one job, read on demand with `read_playbook`
 * rather than carried in every tool description. Each is a reviewed markdown file in
 * `docs/orchestration/playbooks/`, shipped beside the server bundle (`playbooks/`, emitted by the
 * desktop server build). The tools keep their purpose, rules, effects and approvals; a playbook
 * holds the examples and recipes.
 */
export interface Playbook {
  readonly name: string;
  /** The file under `docs/orchestration/playbooks/`. */
  readonly file: string;
  /** The roles it is for; `read_playbook` offers it to no other. */
  readonly audience: ReadonlyArray<Exclude<ToolAudience, "dream">>;
}

export const PLAYBOOKS: ReadonlyArray<Playbook> = [
  {
    name: "deliver-a-pull-request",
    file: "deliver-a-pull-request.md",
    audience: ["plain", "worker", "orchestrator"],
  },
  {
    name: "coordinate-workers-and-wakes",
    file: "coordinate-workers-and-wakes.md",
    audience: ["worker", "orchestrator"],
  },
  {
    name: "mock-first",
    file: "mock-first.md",
    audience: ["worker", "orchestrator"],
  },
];

const besideBundleThenRepoDocs = (): ReadonlyArray<string> => {
  const here = dirname(fileURLToPath(import.meta.url));
  return [join(here, "playbooks"), join(here, "../../../../docs/orchestration/playbooks")];
};

/** A playbook's text, from the first folder that has it. */
export const playbookText = async (playbook: Playbook): Promise<string> => {
  let missing: unknown;
  for (const folder of besideBundleThenRepoDocs()) {
    try {
      return await readFile(join(folder, playbook.file), "utf8");
    } catch (error) {
      missing = error;
    }
  }
  throw missing;
};
