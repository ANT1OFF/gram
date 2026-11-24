import type { PendingRequest, RequestId, ThreadStatus } from "@gram/contracts";

/**
 * What a thread in `status` waits on: the request an asking status (`needsApproval`, `needsInput`)
 * says it awaits, and nothing for any other. An asking status alone is a turn going on
 * (`groupedStatus`), so a fixture that means "it asks" carries the request too.
 */
export const awaited = (status: ThreadStatus): PendingRequest[] =>
  status === "needsApproval"
    ? [
        {
          kind: "approval",
          id: "r-1" as RequestId,
          toolName: "Bash",
          displayName: "Bash",
          input: { command: "ls" },
          suggestions: [],
        },
      ]
    : status === "needsInput"
      ? [
          {
            kind: "question",
            id: "r-1" as RequestId,
            questions: [{ question: "Which?", header: "Pick", multiSelect: false, options: [] }],
          },
        ]
      : [];
