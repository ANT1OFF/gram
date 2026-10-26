import { describe, expect, it } from "vitest";
import { touchesRemote } from "./remote-commands.ts";

describe("touchesRemote", () => {
  it("spots a push and the gh commands that change a PR", () => {
    for (const command of [
      "git push",
      "git push -u origin feat/x",
      "git -C ../other push --force-with-lease",
      "pnpm check && git push",
      'gh pr create --title "Fix" --body-file -',
      "gh pr merge 12 --squash",
      "gh pr comment 12 --body '/agent review'",
      "gh run rerun 77 --failed",
    ]) {
      expect(touchesRemote("Bash", { command }), command).toBe(true);
    }
  });

  it("reads argv-style input, and other agents' names for a shell", () => {
    expect(touchesRemote("shell", { command: ["bash", "-lc", "git push"] })).toBe(true);
    expect(touchesRemote("exec_command", { cmd: "gh pr ready 4" })).toBe(true);
  });

  it("ignores reads, local git, and the same words outside a shell", () => {
    for (const command of [
      "git status",
      "git pushd",
      "git stash push",
      "git -C ../other stash push",
      "gh pr view 12",
      "gh pr list",
      "git fetch",
    ]) {
      expect(touchesRemote("Bash", { command }), command).toBe(false);
    }
    expect(touchesRemote("Write", { file_path: "NOTES.md", content: "then run git push" })).toBe(
      false,
    );
    expect(touchesRemote("Bash", undefined)).toBe(false);
  });
});
