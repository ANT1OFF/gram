import type { UpdateSource } from "@gram/contracts";

import { UPDATE_REPO } from "./config.ts";

/**
 * Where this install's updater reads releases, for what Settings says about it. A Developer ID
 * signed macOS install's Electron updater reads `UPDATE_REPO` anonymously; the `gh` updater
 * (Windows) reads it through the user's own `gh` login.
 */
export function updateSource(updater: "native" | "gh"): UpdateSource {
  return { repo: UPDATE_REPO, visibility: updater === "native" ? "public" : "private" };
}
