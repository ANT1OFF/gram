import type {
  ApprovalRequest,
  PendingRequest,
  RequestId,
  ThreadId,
  WorkspaceId,
} from "@gram/contracts";
import { NOTICE_CUT_LINE, noticeBodyFits } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { askOf, memoryAskOf, type Ask } from "@/orchestration/ask-model";
import { groupInbox, type InboxEntry } from "@/orchestration/inbox-model";

import {
  askFingerprint,
  askScope,
  awayAsk,
  awayAskId,
  checkAwayAction,
  mergesPr,
  templateTitle,
} from "@/orchestration/ask-actions";

import { buildNotice } from "./away-notice";

const W = "w-1" as WorkspaceId;
const ORCH = "t-orch" as ThreadId;

const approval = (id: string, input: Record<string, unknown>, more = {}): ApprovalRequest => ({
  kind: "approval",
  id: id as RequestId,
  toolName: "Bash",
  displayName: "Bash",
  input,
  suggestions: [],
  ...more,
});

const entry = (id: string, request: PendingRequest): InboxEntry => ({
  threadId: id as ThreadId,
  title: `Worker ${id}`,
  feature: "mail-trigger",
  request,
});

const askFor = (...entries: InboxEntry[]): Ask => askOf(groupInbox(entries)[0]!);

const notice = (ask: Ask, more: { title?: string; actions?: boolean } = {}) =>
  buildNotice({
    ask,
    workspaceId: W,
    workspaceName: "agent-platform",
    orchestratorThreadId: ORCH,
    actions: more.actions ?? true,
    title: more.title,
  });

const PUSH = "git push -u origin feat/mail-trigger";

const all = (asks: Ask[]) => [
  { workspaceId: W, name: "agent-platform", orchestratorThreadId: ORCH, asks },
];

describe("an ask's notification", () => {
  it("shows the exact command under a template title, with one Allow for the group", () => {
    const ask = askFor(
      entry("a", approval("r-a", { command: PUSH })),
      entry("b", approval("r-b", { command: PUSH })),
      entry("c", approval("r-c", { command: PUSH })),
    );
    const n = notice(ask);
    expect(n.title).toBe("Allow git push × 3?");
    expect(n.subtitle).toBe("agent-platform · mail-trigger · Worker a and 2 more");
    expect(n.body).toBe(PUSH);
    expect(n.button).toEqual({ label: "Allow 3", option: 0 });
    expect(ask.options[0]!.action).toEqual({ kind: "group", decision: "allow" });
    expect(n.openThreadId).toBe(ORCH);
    expect(n.id).toBe(awayAskId(askScope(ask, W)));
  });

  it("shows the extras an Allow covers, and refuses one the stack cut short", () => {
    const timed = notice(
      askFor(entry("a", approval("r-a", { command: "npm test", timeout: 120000 }))),
    );
    expect(timed.body).toBe("npm test\ntimeout: 120000");
    expect(timed.button).toEqual({ label: "Allow", option: 0 });
    const long = notice(
      askFor(entry("a", approval("r-a", { command: "npm test", env: "x".repeat(200) }))),
    );
    expect(long.button).toBeUndefined();
    expect(long.body.endsWith(NOTICE_CUT_LINE)).toBe(true);
  });

  it("offers Open only, and says so, when the command would be cut", () => {
    const command = `${PUSH} && npm run release -- --tag next --dry-run=false`;
    const n = notice(askFor(entry("a", approval("r-a", { command }))));
    expect(noticeBodyFits(command)).toBe(false);
    expect(n.button).toBeUndefined();
    expect(n.body).toBe(`${command.slice(0, 37)}…\n${NOTICE_CUT_LINE}`);
  });

  it("offers Open only for a command with characters that reorder it", () => {
    const n = notice(askFor(entry("a", approval("r-a", { command: "echo ok‮; rm -rf ~" }))));
    expect(n.button).toBeUndefined();
    expect(n.body).toContain(NOTICE_CUT_LINE);
    expect(n.body).not.toContain("‮");
  });

  it("offers Open only with actions off", () => {
    const n = notice(askFor(entry("a", approval("r-a", { command: PUSH }))), { actions: false });
    expect(n.body).toBe(PUSH);
    expect(n.button).toBeUndefined();
  });

  it("labels a merge Merge, through the same Allow", () => {
    const ask = askFor(entry("a", approval("r-a", { command: "gh pr merge 91 --squash" })));
    const n = notice(ask);
    expect(n.title).toBe("Merge a pull request?");
    expect(n.button).toEqual({ label: "Merge", option: 0 });
    expect(ask.options[0]!.action).toEqual({ kind: "group", decision: "allow" });
    const tool = approval(
      "r-m",
      { method: "squash" },
      {
        toolName: "mcp__gram__merge_when_ready",
        displayName: "merge_when_ready",
        description: "Merge api#212 (squash) once fresh CI passes",
      },
    );
    expect(mergesPr(tool)).toBe(true);
    const merge = notice(askFor(entry("a", tool)));
    // Its description and its call don't fit a banner together: Open only.
    expect(merge.body.endsWith(NOTICE_CUT_LINE)).toBe(true);
    expect(merge.button).toBeUndefined();
    expect(mergesPr({ ...tool, input: { enabled: false } })).toBe(false);
  });

  it("opens a question, a plan and the orchestrator's question, never answers them", () => {
    const question: PendingRequest = {
      kind: "question",
      id: "r-q" as RequestId,
      questions: [
        {
          question: "Keep both, or uv only?",
          header: "Installer",
          multiSelect: false,
          options: [{ label: "uv only", description: "" }],
        },
      ],
    };
    const q = notice(askFor(entry("q", question)));
    expect(q.title).toBe("A worker asks");
    expect(q.body).toBe("Keep both, or uv only?");
    expect(q.button).toBeUndefined();
    const memory = notice(
      memoryAskOf(W, { id: "Q1", text: "Ship the form first?", detail: undefined, open: true }),
    );
    expect(memory.title).toBe("The orchestrator asks");
    expect(memory.button).toBeUndefined();
  });

  it("takes the helper's title, never in place of the command", () => {
    const n = notice(askFor(entry("a", approval("r-a", { command: PUSH }))), {
      title: "A worker wants to push",
    });
    expect(n.title).toBe("A worker wants to push");
    expect(n.body).toBe(PUSH);
  });

  it("uses the template with helpers off", () => {
    const ask = askFor(entry("a", approval("r-a", { command: PUSH })));
    expect(notice(ask).title).toBe(templateTitle(ask));
    expect(templateTitle(ask)).toBe("Allow git push?");
    expect(
      templateTitle(
        askFor(entry("a", approval("r-a", { file_path: "/x" }, { displayName: "Edit" }))),
      ),
    ).toBe("Allow Edit?");
  });

  it("fingerprints the very requests and inputs shown", () => {
    const one = askFor(entry("a", approval("r-a", { command: PUSH })));
    const changed = askFor(entry("a", approval("r-a", { command: `${PUSH} --force` })));
    expect(askFingerprint(one)).toBe(
      askFingerprint(askFor(entry("a", approval("r-a", { command: PUSH })))),
    );
    expect(askFingerprint(one)).not.toBe(askFingerprint(changed));
    expect(awayAskId("r-a")).toMatch(/^ask-[0-9a-f]{16}$/);
  });
  it("answers an action only for the very ask shown, still whole and still waiting", () => {
    const ask = askFor(
      entry("a", approval("r-a", { command: PUSH })),
      entry("b", approval("r-b", { command: PUSH })),
    );
    const shown = notice(ask);
    expect(checkAwayAction(all([ask]), shown)).toMatchObject({
      ask,
      done: "Allowed 2",
      action: { kind: "group", decision: "allow" },
    });
    // Answered or hidden: gone from the list.
    expect(checkAwayAction(all([]), shown)).toBeUndefined();
    // The same key with other input.
    const changed = askFor(
      entry("a", approval("r-a", { command: `${PUSH} --force` })),
      entry("b", approval("r-b", { command: PUSH })),
    );
    expect(checkAwayAction(all([changed]), shown)).toBeUndefined();
    // Shown Open only: nothing to answer.
    expect(checkAwayAction(all([ask]), notice(ask, { actions: false }))).toBeUndefined();
    // A forged button for another option (Deny) is refused.
    expect(
      checkAwayAction(all([ask]), { ...shown, button: { label: "Allow 2", option: 1 } }),
    ).toBeUndefined();
  });
  it("checks the raw input, before any normalizing: a tab, a newline or a bidi mark offers Open", () => {
    // The stack shows this extra as `/tmp/a b`; the input holds a tab.
    const tab = askFor(entry("a", approval("r-a", { command: "ls", cwd: "/tmp/a\tb" })));
    expect(tab.extras[0]!.value).toBe("/tmp/a b");
    expect(awayAsk(tab, true)).toMatchObject({ whole: false });
    expect(awayAsk(tab, true).button).toBeUndefined();
    expect(notice(tab).body.endsWith(NOTICE_CUT_LINE)).toBe(true);
    // A newline would read as a command and an extra.
    const two = askFor(entry("a", approval("r-a", { command: "echo ok\nrm -rf ~" })));
    expect(awayAsk(two, true).button).toBeUndefined();
    const bidi = askFor(entry("a", approval("r-a", { command: "ls", note: "a\u202eb" })));
    expect(awayAsk(bidi, true).button).toBeUndefined();
    // Faithful as typed: kept, with its Allow.
    const plain = askFor(entry("a", approval("r-a", { command: "ls", cwd: "/tmp/a b" })));
    expect(awayAsk(plain, true)).toEqual({
      text: "ls\ncwd: /tmp/a b",
      whole: true,
      button: { label: "Allow", option: 0 },
    });
  });

  it("offers Merge on a merge tool only with the server's description of the resolved call", () => {
    const bare = approval(
      "r-m",
      {},
      { toolName: "mcp__gram__merge_when_ready", displayName: "merge_when_ready" },
    );
    const open = notice(askFor(entry("a", bare)));
    expect(open.button).toBeUndefined();
    expect(open.body.endsWith(NOTICE_CUT_LINE)).toBe(true);
    const described = notice(
      askFor(entry("a", { ...bare, description: "Merge api#212 (squash)" })),
    );
    expect(described.body).toBe("Merge api#212 (squash)\nmerge_when_ready {}");
    expect(described.button).toEqual({ label: "Merge", option: 0 });
    const hidden = notice(
      askFor(entry("a", { ...bare, description: "Merge api#212 \u202e(squash)" })),
    );
    expect(hidden.button).toBeUndefined();
  });

  it("tells apart the same request id in another thread or workspace", () => {
    const here = askFor(entry("a", approval("1", { command: PUSH })));
    const otherThread = askFor(entry("b", approval("1", { command: PUSH })));
    expect(here.key).toBe(otherThread.key);
    const shown = notice(here);
    expect(shown.id).toBe(awayAskId(askScope(here, W)));
    expect(shown.id).not.toBe(awayAskId(askScope(otherThread, W)));
    expect(shown.id).not.toBe(awayAskId(askScope(here, "w-2" as WorkspaceId)));
    expect(checkAwayAction(all([otherThread]), shown)).toBeUndefined();
    expect(
      checkAwayAction(
        [
          {
            workspaceId: "w-2" as WorkspaceId,
            name: "billing",
            orchestratorThreadId: ORCH,
            asks: [here],
          },
        ],
        shown,
      ),
    ).toBeUndefined();
    expect(checkAwayAction(all([here]), shown)).toBeDefined();
  });
});
