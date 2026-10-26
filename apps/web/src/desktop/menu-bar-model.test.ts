import type { ApprovalRequest, RequestId, ThreadId, WorkspaceId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { askFingerprint, askScope, checkAwayAction } from "@/orchestration/ask-actions";
import { askOf } from "@/orchestration/ask-model";
import type { WorkspaceAsks } from "@/orchestration/ask-stack";
import { groupInbox, type InboxEntry } from "@/orchestration/inbox-model";

import { shownIn, trayAskToken, trayMenuOf } from "./menu-bar-model";

const approval = (id: string, input: Record<string, unknown>): ApprovalRequest => ({
  kind: "approval",
  id: id as RequestId,
  toolName: "Bash",
  displayName: "Bash",
  input,
  suggestions: [],
});

const entry = (threadId: string, request: InboxEntry["request"]): InboxEntry => ({
  threadId: threadId as ThreadId,
  title: `Title of ${threadId}`,
  feature: "mail",
  request,
});

const group = (...entries: InboxEntry[]) => askOf(groupInbox(entries)[0]!);

const workspace = (asks: WorkspaceAsks["asks"]): WorkspaceAsks => ({
  workspaceId: "w1" as WorkspaceId,
  name: "agent-platform",
  orchestratorThreadId: "orch" as ThreadId,
  asks,
});

const PUSH = "git push -u origin feat/mail-trigger";

describe("the menu bar's menu", () => {
  it("allows equal pushes under the exact command, once for all of them", () => {
    const ask = group(
      entry("a", approval("r-a", { command: PUSH })),
      entry("b", approval("r-b", { command: PUSH })),
      entry("c", approval("r-c", { command: PUSH })),
    );
    const built = trayMenuOf([workspace([ask])], []);
    const [shown] = built.menu.asks;
    expect(shown).toMatchObject({
      title: "Allow git push × 3?",
      context: "agent-platform · mail · Title of a and 2 more",
      lines: [PUSH],
      answer: "Allow 3",
    });
    expect(shown!.id).toBe(trayAskToken(askScope(ask, "w1" as WorkspaceId), askFingerprint(ask)));
    expect(built.asks.get(shown!.id)).toMatchObject({
      workspaceId: "w1",
      askKey: ask.key,
      fingerprint: askFingerprint(ask),
      button: { label: "Allow 3", option: 0 },
      // Open goes to the orchestrator's stack, as a notification's does.
      openThreadId: "orch",
    });
  });

  it("names a merge Merge, and shows its extras as lines of their own", () => {
    const ask = group(entry("a", approval("r-m", { command: "gh pr merge 91 --squash" })));
    expect(trayMenuOf([workspace([ask])], []).menu.asks[0]).toMatchObject({
      title: "Merge a pull request?",
      lines: ["gh pr merge 91 --squash"],
      answer: "Merge",
    });
    const withExtras = group(
      entry("b", approval("r-x", { command: "uv run pytest", timeout: 60_000 })),
    );
    const [shown] = trayMenuOf([workspace([withExtras])], []).menu.asks;
    expect(shown!.lines).toEqual(["uv run pytest", "timeout: 60000"]);
    expect(shown!.answer).toBe("Allow");
  });

  it("offers Open only when the command can't be shown whole", () => {
    const long = `git push origin ${"x".repeat(120)}`;
    const hidden = "git push origin main‮";
    for (const command of [long, hidden]) {
      const ask = group(entry("a", approval(`r-${command.length}`, { command })));
      const [shown] = trayMenuOf([workspace([ask])], []).menu.asks;
      expect(shown!.answer).toBeUndefined();
      expect(trayMenuOf([workspace([ask])], []).asks.get(shown!.id)?.button).toBeUndefined();
    }
  });

  it("offers Open only for a question or a plan", () => {
    const question = group(
      entry("q", {
        kind: "question",
        id: "r-q" as RequestId,
        questions: [
          {
            question: "Keep both?",
            header: "Installer",
            multiSelect: false,
            options: [{ label: "Yes", description: "" }],
          },
        ],
      }),
    );
    expect(trayMenuOf([workspace([question])], []).menu.asks[0]).toMatchObject({
      title: "A worker asks",
      lines: ["Keep both?"],
    });
    expect(trayMenuOf([workspace([question])], []).menu.asks[0]!.answer).toBeUndefined();
  });

  it("lists eight asks and counts the rest, with each workspace's status", () => {
    const asks = Array.from({ length: 10 }, (_, i) =>
      group(entry(`t${i}`, approval(`r${i}`, { command: `git push origin b${i}` }))),
    );
    const built = trayMenuOf([workspace(asks)], []);
    expect(built.menu.asks).toHaveLength(8);
    expect(built.menu.more).toBe(2);
    expect(built.menu.workspaces).toEqual([
      {
        id: expect.stringMatching(/^ws-[0-9a-f]{16}$/),
        name: "agent-platform",
        busy: 0,
        asks: 10,
        failed: 0,
      },
    ]);
  });

  it("says whether every workspace is paused, for Pause all or Resume all, only with workspaces", () => {
    expect(trayMenuOf([workspace([])], [], false).menu.allPaused).toBe(false);
    expect(trayMenuOf([workspace([])], [], true).menu.allPaused).toBe(true);
    expect(trayMenuOf([workspace([])], []).menu).not.toHaveProperty("allPaused");
    expect(trayMenuOf([], [], false).menu).not.toHaveProperty("allPaused");
  });
});

describe("an Allow picked in the menu", () => {
  const ask = group(entry("a", approval("r-a", { command: PUSH })));
  const built = trayMenuOf([workspace([ask])], []);
  const shown = built.asks.get(built.menu.asks[0]!.id)!;

  it("takes the very ask that was shown", () => {
    expect(checkAwayAction([workspace([ask])], shown)).toMatchObject({
      ask,
      done: "Allowed",
      action: { kind: "group", decision: "allow" },
    });
  });

  it("sends nothing once the ask is gone or has another member", () => {
    expect(checkAwayAction([workspace([])], shown)).toBeUndefined();
    const grown = group(
      entry("a", approval("r-a", { command: PUSH })),
      entry("b", approval("r-b", { command: PUSH })),
    );
    expect(checkAwayAction([workspace([grown])], shown)).toBeUndefined();
  });
});

describe("a pick from an older menu", () => {
  it("finds only what that menu showed, never a request changed under the same id", () => {
    const before = group(entry("t", approval("0", { command: "npm test" })));
    const after = group(entry("t", approval("0", { command: "rm -rf build" })));
    const first = trayMenuOf([workspace([before])], []);
    const second = trayMenuOf([workspace([after])], []);
    const oldId = first.menu.asks[0]!.id;
    expect(second.menu.asks[0]!.id).not.toBe(oldId);
    // Newest first, but the old token is only in the old menu: its own record, which no longer
    // matches what waits.
    const shown = shownIn([first, second], "asks", oldId)!;
    expect(shown.fingerprint).toBe(askFingerprint(before));
    expect(checkAwayAction([workspace([after])], shown)).toBeUndefined();
    expect(shownIn([second], "asks", oldId)).toBeUndefined();
  });
});
