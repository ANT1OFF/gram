import type { GramUIMessage } from "@gram/contracts";
import { describe, expect, it } from "vitest";
import { postsIn, sameText, shellCommands, type Post } from "./posted-comments.ts";

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

const bodies = (posts: ReadonlyArray<Post>) =>
  posts.flatMap((post) => (post.body === undefined ? [] : [post.body]));

describe("postsIn", () => {
  it("reads the bodies gh comment, review and api calls sent, however they were passed", () => {
    const posts = postsIn([
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
    expect(bodies(posts).toSorted()).toEqual(
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

  it("names the PR each post went to, as its command gave it", () => {
    const targets = postsIn([
      bash("gh pr comment 12 -b one"),
      bash("gh pr comment '#13' --repo acme/web -b two"),
      bash("gh pr comment https://github.com/acme/api/pull/14 -b three"),
      bash("gh pr comment -b four"),
      bash("gh api repos/acme/web/issues/15/comments -f body=five"),
      bash("gh api repos/{owner}/{repo}/pulls/16/comments -f body=six"),
      bash("gh api -X POST repos/acme/web/pulls/comments/7/replies -f body=seven"),
      call("mcp__gram__pr_reply_to_thread", { reviewThreadId: "T", body: "eight" }),
    ]).map((post) => [post.body, post.pr]);
    expect(targets).toEqual([
      ["one", { number: 12 }],
      ["two", { repo: "acme/web", number: 13 }],
      ["three", { repo: "acme/api", number: 14 }],
      ["four", undefined],
      ["five", { repo: "acme/web", number: 15 }],
      ["six", { number: 16 }],
      ["seven", undefined],
      ["eight", undefined],
    ]);
  });

  it("keeps the links a posting call printed, which name its comment exactly", () => {
    const posts = postsIn([
      bash(
        'gh pr comment 12 --body "Pushed $(git rev-parse --short HEAD)"',
        "https://github.com/acme/web/pull/12#issuecomment-99\n",
      ),
    ]);
    expect(posts.flatMap((post) => post.urls)).toEqual([
      "https://github.com/acme/web/pull/12#issuecomment-99",
    ]);
  });

  it("drops a posting call's links when it also reads, or prints more links than it posted", () => {
    const users = "https://github.com/acme/web/pull/12#issuecomment-123";
    const own = "https://github.com/acme/web/pull/12#issuecomment-124";
    const urls = (command: string, output: string) =>
      postsIn([bash(command, output)]).flatMap((post) => post.urls);
    // A post chained with a read: the read printed the user's link.
    expect(
      urls(
        'gh pr comment 12 --body "Pushed the fix." && gh pr view 12 --json comments',
        `${own}\n{"comments":[{"url":"${users}"}]}`,
      ),
    ).toEqual([]);
    // A post beside a read that isn't gh: curl printed the user's link.
    expect(
      urls(
        'gh pr review 12 --comment --body "Reviewed." && curl -s https://api.github.com/repos/acme/web/issues/12/comments',
        users,
      ),
    ).toEqual([]);
    // One post, two comment links: which is its own can't be told.
    expect(urls('gh pr comment 12 -b "x" && cat notes.md', `${own}\n${users}`)).toEqual([]);
    // One post, its own link, and a link that names no comment.
    expect(
      urls('gh pr comment 12 -b "x"', `${own}\nhttps://github.com/acme/web/pull/new/feature`),
    ).toEqual([own]);
    // The body still counts when the links don't.
    expect(
      postsIn([bash('gh pr comment 12 --body "Pushed the fix." && gh pr view 12', users)]).map(
        (post) => post.body,
      ),
    ).toEqual(["Pushed the fix."]);
  });

  it("takes nothing from calls that only read comments, whatever links they print", () => {
    const listing = JSON.stringify({
      comments: [{ url: "https://github.com/acme/web/pull/12#issuecomment-123", body: "Hold off" }],
    });
    expect(
      postsIn([
        bash("gh pr view 12 --json comments", listing),
        bash("gh api repos/acme/web/issues/12/comments", listing),
        bash("gh api -X GET repos/acme/web/issues/12/comments -f per_page=100", listing),
        call("mcp__gram__pr_review_threads", {}, listing),
        call("WebFetch", { url: "https://github.com/acme/web/pull/12" }, listing),
      ]),
    ).toEqual([]);
  });

  it("finds no body in commands that merely mention the words", () => {
    const posts = postsIn([
      bash("git fetch origin && git rebase origin/main && bun run test"),
      bash("echo ok; go test ./...; kill -STOP 1"),
      call("Write", { file_path: "/repo/a.ts", content: "// Stop.\nexport const ok = 1;" }),
    ]);
    expect(posts).toEqual([]);
    for (const short of ["Stop.", "ok", "rebase", "go", "test"])
      expect(bodies(posts)).not.toContain(sameText(short));
  });
});
