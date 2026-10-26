# Worker questions

[Up: design notes](../../DESIGN.md)

A worker that needs a decision asks its own question. Its orchestrator triages it first.
It answers the question itself only when the brief, a standing decision or memory already
settles it. Otherwise the question goes to the user as the worker wrote it, with at most
one line of context from the orchestrator. The user's answer goes straight to the worker,
and the orchestrator gets a copy.

Approval requests, permission prompts, plan approvals and a harness's own blocking ask
(`AskUserQuestion`, a pending request) are handled separately.

## Lifecycle

```text
ask_question ──► triage ──answer_worker(questionId, source)──► answered (by orchestrator)
                   │
                   ├─forward_question(id, context?)──► forwarded ──user answers──► answered (by you)
                   ├─10 min with no triage ──────────► forwarded      └─user dismisses─► dismissed
                   └─workspace or feature paused ────► forwarded
```

- **Ask.** A worker calls `ask_question` with its question, optional `context`, 2–4
  `options`, `multiSelect`, and `recommended`. With options, `recommended` names one of
  them. Without options, it is a short free-text recommendation. Options can carry an
  `image` and a `preview`, and the question a `mock`, to show a mock's directions as
  pictures. The call returns at once
  with the question's id (`WQ7`). The worker carries on, or ends its turn if it can't
  move without the answer. Gram also files a `question` report with the worker's words.
  That puts the worker in the ledger's existing `question` state and wakes the
  orchestrator.
- **Triage.** Each digest lists the questions in triage in a `Worker questions to
  triage` block. The block repeats the rule and the time each question forwards itself.
  The worker's words sit inside `<worker-question>` blocks, which the digest marks as
  data, as it does `<worker-report>`. The orchestrator then does one of two things:
  - `answer_worker` with `questionId`, `answer` and a required `source` that names the
    brief, the standing decision or the memory entry that settles it. The question is
    recorded as "answered by orchestrator: <source>".
  - `forward_question` with `questionId` and an optional `context`. The context is one
    line of at most 200 characters: a recommendation, or which other workers it affects.
    A newline is refused.
- **Self-forward.** If nobody triages it within **10 minutes**, the question forwards
  itself with no context line. This matches `REQUEST_PENDING_WAKE_MS`, the existing wait
  before a worker's waiting request becomes the orchestrator's business. An idle
  orchestrator gets the digest within seconds, so 10 minutes leaves room for one that is
  mid-turn to finish and read it. It also caps the user's extra wait behind a busy,
  limit-waiting or errored orchestrator. A paused workspace or a paused feature wakes no
  orchestrator, so the question forwards at once.
- **The user answers** wherever the question shows: the Board's Waiting on you band, the
  overview's "N needs you" pill (which counts it and opens the band), or an away
  notification (Open only, like the orchestrator's own questions). The card shows the
  worker's words exactly, the worker's recommendation, and the orchestrator's line if
  there is one. The user picks an option or writes free text, or dismisses the question,
  optionally with a reason.
- **Delivery.** An answer or a dismissal goes to the worker as a server notice
  (`sendNotice`, key `question:<id>`). It is steered into a running turn at the next tool
  boundary, or queued and sent when the worker is idle. It is not counted as the user
  typing into the worker, so it doesn't put a user hold on the worker. A user's closure
  is persisted before notification and stays closed if notification fails. Archived
  workers stay archived; delivery guards are unchanged. The stored `delivered` field
  records successful notice handling and is absent when no handling was recorded.
- **The copy.** The orchestrator's next digest lists every question closed by the user
  since the last acknowledged digest. It names who closed it and when, the answer or the
  dismissal reason, and a prompt: record the decision, in memory or in the standing
  decisions if the user's wording makes it a ruling, and pass it on to any other worker
  it affects. The digest distinguishes recorded worker notification from closure alone.
  A copy is acknowledged with the digest that
  carried it, like due wakes, so the 10-note cap can't drop it.

## Refusals

- `answer_worker` and `forward_question` are orchestrator tools. A worker calling either
  is refused (`no_authority`). No tool lets a worker answer a question, its own or
  another worker's.
- An orchestrator can answer or forward only its own workers' questions
  (`not_your_worker`), and only while they are in triage. Once a question is forwarded,
  `answer_worker` is refused (`forwarded`): it is the user's now.
- Both tools are refused while the workspace or the feature is paused, and for a worker
  the user holds (`user_intervened`). In that case the question is the user's anyway.
- An orchestrator cannot change a closed question. Repeated or concurrent user replies
  to a question already closed by the user return the first saved decision, without
  overwriting it or notifying the worker twice. A user reply to a question already
  answered by the orchestrator is refused.
- A worker with no orchestrator listening gets `asked: false` and is told to carry on, as
  `report` does.

Unlike `answer_worker` on a pending request, which only `full` autonomy allows, triage
works at every autonomy level. A worker's `ask_question` is addressed to its orchestrator
first, so a settled answer from the orchestrator takes nothing from the user.

## Model and storage

The questions are stored in the workspace's orchestration outbox (`questions`, with
`questionSeq` for ids). The server is the authority there. A forged line in a memory file
can't redirect an answer, and the triage deadline, the stage and the copy owed survive a
restart. A restart re-arms every triage timer, and one that is overdue forwards at once.
A new orchestrator in the slot inherits the questions, as it inherits held briefs. Closed
questions are kept for history, at most 50 per workspace, newest first.

Shared shapes are in `packages/contracts/src/worker-questions.ts`. `WorkerQuestion` is the
record. The ledger carries the workspace's questions (`OrchestratorLedger.questions`). The
digest carries the triage list and the copies (`OrchestrationDigest.questions`).

`ask_user` (orchestrator to user) keeps `questions.md` as its store, with its own Answer
flow. The two share the question card in `question-entry.tsx`, from one view model
(`QuestionCard`). A worker question adds who asked, the orchestrator's line and
Dismiss.

## History

Every change (asked, forwarded, answered, dismissed) is emitted as a `worker-question`
data part, keyed by the question's id. The worker's transcript therefore shows one card
that moves through its states: who answered and when, in 24-hour time. The orchestrator's
transcript gets the same card for the answers it gave. The feature card on the Board lists
the feature's questions with the same facts.

## Routing

Delivery to the user is the ledger: every surface reads the ledger's forwarded questions, and
every answer is one call, `workerQuestion.answer` or `workerQuestion.dismiss`, keyed by
workspace and question id.
