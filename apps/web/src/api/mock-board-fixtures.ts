import type { DiffFile, PendingRequest, RequestId, ThreadId } from "@gram/contracts";

import { seedMockBranch } from "./mock-git";
import type { MockScenes } from "./mock-orchestration";

const added = (path: string, lines: readonly string[]): DiffFile => ({
  path,
  status: "added",
  additions: lines.length,
  deletions: 0,
  binary: false,
  tooLarge: false,
  patch: [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join("\n"),
});

const TRIGGER_FORM_FILES: readonly DiffFile[] = [
  added("src/triggers/mail-form.tsx", [
    'import { postMailTrigger } from "../api/triggers";',
    "",
    "export function MailTriggerForm() {",
    "  const submit = (form: FormData) =>",
    '    postMailTrigger({ to: String(form.get("to")), template: String(form.get("template")) });',
    "  return <form action={submit}>…</form>;",
    "}",
  ]),
  {
    path: "src/api/triggers.ts",
    status: "modified",
    additions: 3,
    deletions: 0,
    binary: false,
    tooLarge: false,
    patch: [
      "@@ -1,1 +1,4 @@",
      ' export const TRIGGERS = "/triggers";',
      "+",
      "+export const postMailTrigger = (body: { to: string; template: string }) =>",
      '+  fetch(`${TRIGGERS}/mail`, { method: "POST", body: JSON.stringify(body) });',
    ].join("\n"),
  },
];

const TRIGGER_DOCS_FILES: readonly DiffFile[] = [
  added("docs/triggers/mail.md", [
    "# Mail triggers",
    "",
    "POST /triggers/mail with `to` and `template` sends one mail; the answer is 202 with its id.",
  ]),
];

const RATE_LIMIT_FILES: readonly DiffFile[] = [
  added("src/triggers/limit.ts", [
    "export const MAIL_TRIGGERS_PER_MINUTE = 60;",
    "",
    "export const overLimit = (sent: number) => sent >= MAIL_TRIGGERS_PER_MINUTE;",
  ]),
];

const FILES = [TRIGGER_FORM_FILES, TRIGGER_DOCS_FILES, RATE_LIMIT_FILES] as const;

/**
 * The Board mock's workers that ask to push, in order (the form, the docs, the rate limit), each
 * with its change committed on its branch and not pushed: its Diff is its branch against main.
 */
export function seedCommittedBranches(
  { host, project }: Pick<MockScenes, "host" | "project">,
  threadIds: readonly ThreadId[],
): void {
  threadIds.forEach((threadId, index) => {
    const worker = host.threads().find((thread) => thread.id === threadId);
    if (worker === undefined) return;
    const branch = worker.checkout?.branch ?? "feat/mail-trigger";
    host.setGit(worker.id, {
      repo: true,
      branch,
      worktree: true,
      head: "c3a9e1f07b5d2c4e6a8b0d2f4a6c8e0b2d4f6a8c",
      changesToken: `mock-${worker.id}-1`,
      changedFiles: 0,
      base: "origin/main",
      behindBase: 0,
      aheadBase: 2,
      conflicts: false,
      origin: `example/${project(worker.projectId).name}`,
    });
    seedMockBranch(worker.id, branch, FILES[index] ?? []);
  });
}

/** The setup guide's worker asks which installer the guide keeps. */
export const setupGuideQuestion = (threadId: ThreadId): PendingRequest => ({
  kind: "question",
  id: `r-question-${threadId}` as RequestId,
  toolUseId: `toolu_question_${threadId}`,
  questions: [
    {
      question: "The setup guide covers both pip and uv. Keep both, or uv only?",
      header: "Installer",
      multiSelect: false,
      options: [
        { label: "uv only", description: "What the repo's own scripts use." },
        { label: "Keep both", description: "Longer, but nobody is left out." },
      ],
    },
  ],
});
