import { describe, expect, it } from "vitest";

import { decide } from "./guard-bash.mjs";

const blocked = (command, currentBranch = "feature") => decide(command, { currentBranch }).block;

describe("guard-bash", () => {
  it("refuses stopping processes by pattern", () => {
    for (const command of [
      "pkill -f vite",
      "sudo pkill -9 -f 'node .*dev'",
      "killall node",
      "kill $(pgrep -f vitest)",
      "pgrep -f playwright | xargs kill -9",
      "cd apps/web && pkill -f vite",
      "bash -c 'pkill -f vite'",
    ])
      expect(blocked(command), command).toBe(true);
    for (const command of [
      "kill 4242",
      "pgrep -f vite",
      'rg -n "pkill -f" docs',
      "bun run check:cancel",
    ])
      expect(blocked(command), command).toBe(false);
  });

  it("refuses a push that updates main or master", () => {
    for (const command of [
      "git push origin main",
      "git push --force origin main",
      "git push -f origin master",
      "git push origin HEAD:main",
      "git push origin +feature:refs/heads/main",
      "git push origin :main",
      "git -C ../other push origin main",
      "git push --all origin",
      "git add -A && git commit -m wip && git push origin main",
    ])
      expect(blocked(command), command).toBe(true);
    expect(blocked("git push", "main")).toBe(true);
    expect(blocked("git push origin HEAD", "master")).toBe(true);
  });

  it("lets a feature branch push through", () => {
    for (const command of [
      "git push -u origin claude/fix-main-menu",
      "git push --force-with-lease origin feature",
      "git push origin main:feature",
      "git push",
      "git push origin HEAD",
      'git commit -m "never git push origin main"',
      "git fetch origin main",
    ])
      expect(blocked(command), command).toBe(false);
  });
});
