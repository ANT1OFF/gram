import { describe, expect, it } from "vitest";
import type { OutwardGate } from "./host.ts";
import { gateAsks, gateLevel, isOutwardCommand, outwardKind, type OutwardKind } from "./outward.ts";

const OUTWARD: ReadonlyArray<readonly [string, string, OutwardKind]> = [
  ["a plain push", "git push", "publish"],
  ["a push with arguments", "git push -u origin HEAD:refs/heads/main", "publish"],
  ["a forced push", "git push --force-with-lease origin feature", "irreversible"],
  ["a dry run, which still asks", "git push --dry-run", "publish"],
  ["-C before the verb", "git -C ../other push origin main", "publish"],
  ["-c before the verb", "git -c push.default=current push", "publish"],
  [
    "several global options",
    "git --no-pager -C x -c a=b --git-dir=.git --work-tree . push",
    "publish",
  ],
  ["--git-dir as two words", "git --git-dir /r/.git push", "publish"],
  ["an absolute path", "/usr/bin/git push", "publish"],
  ["a relative path", "./bin/git push", "publish"],
  ["git.exe", "C:/Git/bin/git.exe push", "publish"],
  ["subtree push", "git subtree push --prefix=docs origin gh-pages", "publish"],
  ["subtree push, options first", "git subtree -P docs push origin gh-pages", "publish"],
  ["an env prefix", "FOO=1 git push", "publish"],
  ["several env prefixes, one quoted", 'GIT_SSH_COMMAND="ssh -i key" BAR=2 git push', "publish"],
  ["command", "command git push", "publish"],
  ["command -p", "command -p git push", "publish"],
  ["exec", "exec git push", "publish"],
  ["sudo", "sudo git push", "publish"],
  ["sudo with a user", "sudo -u deploy git push", "publish"],
  ["time", "time git push", "publish"],
  ["nohup in the background", "nohup git push &", "publish"],
  ["env", "env -i HOME=/tmp git push", "publish"],
  ["nice", "nice -n 10 git push", "publish"],
  ["timeout", "timeout 60 git push", "publish"],
  ["timeout with a signal", "timeout -s KILL 60 git push", "publish"],
  ["xargs", "echo origin | xargs git push", "publish"],
  ["stacked wrappers", "sudo env FOO=1 nohup git push", "publish"],
  ["after &&", "git commit -m wip && git push", "publish"],
  ["after && without spaces", "git add .&&git push", "publish"],
  ["after ||", "make test || git push", "publish"],
  ["after ;", "cd repo; git push", "publish"],
  ["after ; without a space", "cd repo;git push", "publish"],
  ["after |", "yes | git push", "publish"],
  ["before |", "git push 2>&1 | tee push.log", "publish"],
  ["after &", "sleep 1 & git push", "publish"],
  ["after a newline", "git add .\ngit commit -m x\ngit push", "publish"],
  ["after a CRLF newline", "git add .\r\ngit push\r\n", "publish"],
  ["a line continuation", "git \\\n  push origin main", "publish"],
  ["a subshell", "(cd ../repo && git push)", "publish"],
  ["a brace group", "{ git push; }", "publish"],
  ["command substitution", "echo $(git push)", "publish"],
  ["command substitution in double quotes", 'echo "result: $(git push 2>&1)"', "publish"],
  ["an assignment from a substitution", "OUT=$(git push 2>&1)", "publish"],
  ["nested substitution", 'echo "$(echo "$(git push)")"', "publish"],
  ["backticks", "echo `git push`", "publish"],
  ["process substitution", "diff <(git push) /dev/null", "publish"],
  ["an if condition", "if git push; then echo ok; fi", "publish"],
  ["a negated condition", "if ! git push; then exit 1; fi", "publish"],
  ["a loop body", "for r in a b; do git push $r; done", "publish"],
  ["a quoted binary", '"git" push', "publish"],
  ["a quoted verb", "git 'push'", "publish"],
  ["redirects around it", "git push >/dev/null 2>&1", "publish"],
  ["a redirect before it", "2>/dev/null git push", "publish"],
  ["after a comment line", "# publish\ngit push", "publish"],
  ["sh -c", 'sh -c "git push"', "publish"],
  ["bash -lc", "bash -lc 'cd x && git push'", "publish"],
  ["eval", 'eval "git push"', "publish"],
  ["a heredoc fed to a shell", "bash <<'EOF'\ngit push\nEOF", "publish"],
  ["a substitution in an unquoted heredoc", "cat <<EOF\n$(git push)\nEOF", "publish"],
  ["a command after a heredoc", "cat <<'EOF' > notes.md\nnotes\nEOF\ngit push", "publish"],
  ["a heredoc with no terminator, read as commands", "cat <<'EOF'\ngit push", "publish"],
  ["gh pr create", 'gh pr create --title "x" --body "y"', "publish"],
  ["gh pr new", "gh pr new --fill", "publish"],
  ["gh pr merge", "gh pr merge 12 --squash", "irreversible"],
  ["gh pr close", "gh pr close 12", "irreversible"],
  ["gh release create", "gh release create v1.0.0 --notes x", "irreversible"],
  ["gh workflow run", "gh workflow run beta.yml", "irreversible"],
  ["gh repo delete", "gh repo delete EXAMPLE/x --yes", "irreversible"],
  ["gh -R before the group", "gh -R ANT1OFF/gram pr create", "publish"],
  ["gh --repo between group and verb", "gh pr --repo ANT1OFF/gram merge 3", "irreversible"],
  ["gh --repo= before the group", "gh --repo=ANT1OFF/gram pr close 3", "irreversible"],
  ["gh -R after the verb", "gh pr create -R ANT1OFF/gram --fill", "publish"],
  [
    "gh by path behind an env prefix",
    "GH_TOKEN=x /opt/homebrew/bin/gh pr merge --auto",
    "irreversible",
  ],
  ["gh after a chain", "git commit -m x && gh pr create --fill", "publish"],
  [
    "the usual commit-then-push",
    "git commit -m \"$(cat <<'EOF'\nfix: a thing\n\nCo-Authored-By: x\nEOF\n)\" && git push",
    "publish",
  ],
];

/** Pushes that rewrite or delete what the remote holds, and lines whose worst command can't be undone. */
const IRREVERSIBLE: ReadonlyArray<readonly [string, string]> = [
  ["--force", "git push --force"],
  ["--force after the refspec", "git push origin feature --force"],
  ["-f", "git push -f origin feature"],
  ["-f in a cluster", "git push -uf origin feature"],
  ["-f before -o in a cluster", "git push -fo ci.skip"],
  ["--force-with-lease with a value", "git push --force-with-lease=feature:abc123 origin feature"],
  ["--force-if-includes", "git push --force-with-lease --force-if-includes"],
  ["an abbreviated --force", "git push --forc"],
  ["--delete", "git push origin --delete feature"],
  ["-d", "git push -d origin feature"],
  ["an abbreviated --delete", "git push --del origin feature"],
  ["--mirror", "git push --mirror backup"],
  ["--prune", "git push --prune origin 'refs/heads/*'"],
  ["a + refspec", "git push origin +feature"],
  ["a + refspec with a destination", "git push origin +HEAD:refs/heads/feature"],
  ["a quoted + refspec", 'git push origin "+feature"'],
  ["a + refspec after --", "git push origin -- +feature"],
  ["a deleting refspec", "git push origin :feature"],
  ["a deleting refspec for a tag", "git push origin :refs/tags/v1.0.0"],
  ["a deleting refspec among others", "git push origin main :old"],
  ["a force behind git -C", "git -C ../other push --force origin main"],
  ["a + refspec behind git -C and -c", "git -C ../other -c a=b push origin +main"],
  ["a force after &&", "git commit --amend --no-edit && git push -f"],
  ["a delete after ;", "git branch -D old; git push origin :old"],
  ["a force in bash -c", "bash -c 'git push --force'"],
  ["a + refspec in bash -lc", 'bash -lc "cd x && git push origin +main"'],
  ["a force in eval", "eval 'git push -f'"],
  ["a force in a substitution", 'echo "$(git push --force 2>&1)"'],
  ["a force in a heredoc fed to a shell", "bash <<'EOF'\ngit push --force\nEOF"],
  ["a force behind wrappers", "sudo env FOO=1 timeout 60 git push -f"],
  ["a forced subtree push", "git subtree push --prefix=docs origin +gh-pages"],
  ["a push, then a merge", "git push && gh pr merge 3 --squash"],
  ["a merge, then a push", "gh pr merge 3 --squash; git push"],
  ["a new PR, then a release", "gh pr create --fill && gh release create v1"],
  ["gh release new", "gh release new v1.0.0"],
];

/** Pushes that only add to the remote, however much they look like the ones above. */
const PUBLISH: ReadonlyArray<readonly [string, string]> = [
  ["a + in a quoted commit message", 'git commit -m "+ add a thing" && git push origin main'],
  ["a + word in a commit message", "git commit -m '+1' -m ':fix' && git push"],
  ["a bare colon, which pushes matching branches", "git push origin :"],
  ["--no-force", "git push --no-force origin main"],
  ["--follow-tags", "git push --follow-tags"],
  ["--dry-run, --porcelain and --progress", "git push --dry-run --porcelain --progress"],
  ["--tags", "git push --tags"],
  ["-u, -n, -q and -v", "git push -u -nqv origin feature"],
  ["a push option spelling f and d", "git push -o fd.skip origin main"],
  ["a push option spelling f and d, clustered", "git push -ofd origin main"],
  ["a src:dst refspec", "git push origin HEAD:refs/heads/feature"],
  ["a branch with a + inside it", "git push origin a+b"],
  ["a force on another verb", "git fetch --force && git push"],
  ["a force-delete of a local branch", "git branch -D old && git push"],
  ["-f to another command", "rm -f x; git push"],
  [
    "a refspec from a substitution, which can't be read",
    'git push origin "$(git branch --show-current)"',
  ],
  ["a subtree push with --debug", "git subtree push -d --prefix=docs origin gh-pages"],
  ["a force echoed after a push", 'git push && echo "--force +x :y"'],
];

const INWARD: ReadonlyArray<readonly [string, string]> = [
  ["nothing", ""],
  ["whitespace", "  \n "],
  ["git status", "git status"],
  ["git stash push", "git stash push -m wip"],
  ["git config push.default", "git config push.default current"],
  ["-c push.default on another verb", "git -c push.default=current status"],
  ["a commit message saying push, double-quoted", 'git commit -m "push it"'],
  ["a commit message saying git push, single-quoted", "git commit -m 'git push later'"],
  ["a commit message with a separator in it", 'git commit -m "wip; git push next"'],
  ["an escaped quote in the message", 'git commit -m "say \\"; git push \\""'],
  ["a branch called push", "git checkout push"],
  ["git log --grep", "git log --grep push"],
  ["git remote get-url --push", "git remote get-url --push origin"],
  ["git fetch and pull", "git fetch origin && git pull --rebase"],
  ["echo", "echo git push"],
  ["echo of a quoted line", 'echo "git push && gh pr create"'],
  ["grep for it", 'grep -rn "git push" docs'],
  ["rg for it behind a pipe", 'cat a.sh | rg "gh pr merge"'],
  ["a comment", "# git push"],
  ["a trailing comment", "git status # git push"],
  ["one quoted word", "'git push'"],
  ["a split across lines without a continuation", "git\npush"],
  ["a substituted binary", "$(which git) status"],
  ["a file called push", "cat push"],
  ["a redirect target called push", "git status > push"],
  ["another binary ending in git", "legit push"],
  ["a directory called git", "git/run push"],
  ["a quoted heredoc body", "cat <<'EOF' > notes.md\ngit push origin main\n(gh pr create)\nEOF"],
  ["an unquoted heredoc body without a substitution", "cat <<EOF\ngit push\nEOF"],
  ["a tab-stripped heredoc body", "cat <<-'EOF'\n\tgit push\n\tEOF\necho done"],
  [
    "a commit message in a heredoc naming the commands",
    "git commit -m \"$(cat <<'EOF'\nfix(agents): ask before push\n\ngit push now asks; (gh pr create) too.\nEOF\n)\"",
  ],
  ["a here-string", "cat <<< 'git push'"],
  ["sh -c of something else", 'sh -c "git status"'],
  ["a shell running a file", "bash push.sh"],
  ["gh pr view", "gh pr view 12 --json state"],
  ["gh pr list", "gh pr list --head feature"],
  ["gh pr checks and ready", "gh pr checks 3 && gh pr ready 3"],
  ["gh pr edit", "gh pr edit 3 --add-reviewer x"],
  ["gh pr comment mentioning merge", 'gh pr comment 3 --body "please merge"'],
  ["gh release view", "gh release view v1"],
  ["gh workflow list", "gh workflow list"],
  ["gh run list", "gh run list --workflow beta.yml"],
  ["gh repo view", "gh repo view EXAMPLE/x"],
  ["gh issue create and close", "gh issue create --title x && gh issue close 3"],
  ["gh api, which the gate can't see", "gh api repos/o/r/pulls -f title=x"],
  ["git send-pack, which the gate can't see", "git send-pack origin main"],
  ["an alias, which the gate can't see", "git p"],
];

describe("outwardKind", () => {
  it.each(OUTWARD)("asks for %s", (_, command, kind) => {
    expect(outwardKind(command)).toBe(kind);
    expect(isOutwardCommand(command)).toBe(true);
  });

  it.each(INWARD)("lets %s through", (_, command) => {
    expect(outwardKind(command)).toBeUndefined();
    expect(isOutwardCommand(command)).toBe(false);
  });

  it.each(IRREVERSIBLE)("can't take back %s", (_, command) => {
    expect(outwardKind(command)).toBe("irreversible");
  });

  it.each(PUBLISH)("only publishes with %s", (_, command) => {
    expect(outwardKind(command)).toBe("publish");
  });

  it("asks at every level for a line nested too deeply to read", () => {
    expect(outwardKind("$(".repeat(200_000))).toBe("irreversible");
    expect(isOutwardCommand("$(".repeat(200_000))).toBe(true);
  });

  it("reads a long command line in linear time", () => {
    const long = `${"echo ok && ".repeat(50_000)}git push`;
    expect(outwardKind(long)).toBe("publish");
  });
});

describe("gateLevel", () => {
  it("reads the boolean as the older spelling", () => {
    expect(gateLevel(true)).toBe("all");
    expect(gateLevel("all")).toBe("all");
    expect(gateLevel("irreversible")).toBe("irreversible");
    expect(gateLevel(false)).toBeUndefined();
    expect(gateLevel(undefined)).toBeUndefined();
  });
});

describe("gateAsks", () => {
  const CASES: ReadonlyArray<readonly [OutwardGate | undefined, OutwardKind | undefined, boolean]> =
    [
      ["all", "publish", true],
      ["all", "irreversible", true],
      ["all", undefined, false],
      ["irreversible", "publish", false],
      ["irreversible", "irreversible", true],
      ["irreversible", undefined, false],
      [undefined, "publish", false],
      [undefined, "irreversible", false],
      [undefined, undefined, false],
    ];

  it.each(CASES)("at %s, for %s: %s", (level, kind, asks) => {
    expect(gateAsks(level, kind)).toBe(asks);
  });
});
