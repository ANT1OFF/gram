import type { GramUIMessage } from "@gram/contracts";
import { describe, expect, it } from "vitest";
import { postedIn, sameText, shellCommands } from "./posted-comments.ts";

let calls = 0;
const call = (toolName: string, input: unknown, output: unknown = ""): GramUIMessage =>
  ({
    id: `m${++calls}`,
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolName,
        toolCallId: `c${calls}`,
        state: "output-available",
        input,
        output,
      },
    ],
  }) as unknown as GramUIMessage;

const bash = (command: string, output = "") => call("Bash", { command }, output);

describe("shellCommands", () => {
  it("splits commands and resolves quotes and escapes", () => {
    expect(
      shellCommands(`git add -A && gh pr comment 12 --body "say \\"hi\\" \\$5" ; echo 'a b'`),
    ).toEqual([
      { words: ["git", "add", "-A"] },
      { words: ["gh", "pr", "comment", "12", "--body", 'say "hi" $5'] },
      { words: ["echo", "a b"] },
    ]);
    expect(shellCommands("gh pr comment 1 -b $'one\\ntwo'")[0]!.words.at(-1)).toBe("one\ntwo");
  });

  it("keeps a heredoc with the command it feeds", () => {
    expect(
      shellCommands("gh pr comment 3 --body-file - <<'EOF'\nline one\n(two\nEOF\necho done"),
    ).toEqual([
      { words: ["gh", "pr", "comment", "3", "--body-file", "-"], stdin: "line one\n(two" },
      { words: ["echo", "done"] },
    ]);
  });
});

describe("postedIn", () => {
  it("reads the bodies gh comment, review and api calls sent, however they were passed", () => {
    const posted = postedIn([
      bash('gh pr comment 12 --body "Fixed in abc1234."'),
      bash("gh pr review 12 --comment -b 'Looks fine to me'"),
      bash(
        `gh pr comment 12 --body "$(cat <<'EOF'\nPushed a fix (see below).\n\nDetails here.\nEOF\n)"`,
      ),
      call("Write", { file_path: "/tmp/body.md", content: "From a file." }),
      bash("gh pr comment 12 --body-file /tmp/body.md"),
      bash("gh api repos/o/r/issues/12/comments -f body='Via the API'"),
      bash("bash -lc \"gh pr comment 12 -b 'Codex ran this'\""),
      call("mcp__gram__pr_reply_to_thread", {
        reviewThreadId: "T",
        body: "Fixed in def5678: done.",
      }),
    ]);
    expect([...posted.bodies].toSorted()).toEqual(
      [
        "Fixed in abc1234.",
        "Looks fine to me",
        "Pushed a fix (see below). Details here.",
        "From a file.",
        "Via the API",
        "Codex ran this",
        "Fixed in def5678: done.",
      ].toSorted(),
    );
  });

  it("keeps the links gh printed, which name the comment exactly", () => {
    const posted = postedIn([
      bash(
        'gh pr comment 12 --body "Pushed $(git rev-parse --short HEAD)"',
        "https://github.com/acme/web/pull/12#issuecomment-99\n",
      ),
    ]);
    expect(posted.urls.has("https://github.com/acme/web/pull/12#issuecomment-99")).toBe(true);
  });

  it("finds no body in commands that merely mention the words", () => {
    const posted = postedIn([
      bash("git fetch origin && git rebase origin/main && bun run test"),
      bash("echo ok; go test ./...; kill -STOP 1"),
      call("Write", { file_path: "/repo/a.ts", content: "// Stop.\nexport const ok = 1;" }),
    ]);
    expect(posted.bodies.size).toBe(0);
    for (const short of ["Stop.", "ok", "rebase", "go", "test"])
      expect(posted.bodies.has(sameText(short))).toBe(false);
  });
});
