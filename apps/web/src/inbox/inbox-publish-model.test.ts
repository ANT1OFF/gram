import type { PendingRequest, RequestId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { publishesBranch } from "./inbox-publish-model";

const bash = (command: string): PendingRequest => ({
  kind: "approval",
  id: "r-1" as RequestId,
  toolName: "Bash",
  displayName: "Bash",
  input: { command },
  suggestions: [],
});

describe("publishesBranch", () => {
  it("is a push or a pull request opened, however the command is put together", () => {
    for (const command of [
      "git push -u origin feat/mail-trigger",
      "git -C ../web push",
      "bun run test && git push",
      "gh pr create --fill",
    ]) {
      expect(publishesBranch(bash(command)), command).toBe(true);
    }
  });

  it("is not a command that only reads or merges", () => {
    for (const command of [
      "git status",
      "git log --grep push",
      "gh pr view 12",
      "gh pr merge 12",
    ]) {
      expect(publishesBranch(bash(command)), command).toBe(false);
    }
  });
});
