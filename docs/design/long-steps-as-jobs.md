# Long machine steps as jobs, and budgets that nest

Status: building, 19 November 2026. Behind the hosted features setting (`embeddingOn`), like the
`/machines/stop/*` routes it adds to ([Machines](../MACHINES.md)).

An embedder that runs Gram's machines asks Gram to ready a machine to stop
(`/machines/stop/prepare`) and to resume one (`/machines/stop/resume`). Today each is one HTTP call
held open until the step ends. The step can take minutes: a resume clones and restores each
folder, and a prepare commits and pushes each thread's work. Its caller often gives up first. The
step then runs on where no one sees it, or the caller asks again and a second run starts on top
of the first.

The rule this note sets: **a caller never holds one call open for longer than its own deadline,
and its deadline is always longer than the budget of the step it waits on.** Long steps become
jobs, which a caller starts and then polls.

## The job contract

A job is a resume or a prepare of one machine. Every route is local only and is a `POST` with an
`Origin` and a JSON body, as the other `/machines/*` routes are.

- `POST /machines/stop/resume/start` takes `{ id, remote?, kept?, key? }`, the resume's body plus
  a key. `POST /machines/stop/prepare/start` takes `{ id, force?, remote?, key? }`. Each answers
  `202 { job, joined }` at once.
- `POST /machines/jobs/get` takes `{ job, seen?, waitMs? }` and answers `{ job }`. With `waitMs`
  (25 000 at most), it waits until the job's `version` is past `seen`, then answers. That covers
  an event: a caller can wait for a change without polling fast. An unknown id answers `404`.

A job reads:

```json
{
  "id": "job_…",
  "kind": "resume",
  "machine": "m-1",
  "key": "…",
  "state": "running",
  "version": 7,
  "createdAt": 1763540000000,
  "startedAt": 1763540000020,
  "progressAt": 1763540041000,
  "budgetMs": 1260000,
  "progress": { "done": 3, "total": 12 },
  "folders": [{ "threadId": "t-1", "cwd": "/…", "state": "restored" }],
  "result": {},
  "error": { "status": 409, "message": "…" }
}
```

- `state` is `queued`, `running`, `done` or `failed`. A machine runs one job at a time. A job
  started while another runs on the same machine waits in `queued`, and its budget starts once it
  runs.
- `folders` holds a resume's folders. Each is `queued`, `running`, `restored`, `there`, `missing`
  or `refused`, with a `note` when the machine gave one.
- `result` holds the answer the synchronous route gives, once the job is `done`. `error` holds the
  status and message that route would fail with (`409` when the machine is away, `502` when it
  refused), once the job has `failed`.
- `budgetMs` is the longest the job goes without progress once it runs. Past that it fails by
  itself, as if cut off: a cut-off resume leaves the machine owed, and a cut-off prepare takes the
  stop back. Progress is the job starting, and each folder it starts or is done with. So a
  resume's budget applies one folder at a time, however many folders it has: a resume of fifty
  folders, each a large clone, never reads as stalled while one of them is under way. Each folder
  says when it was started and done with (`startedAt`, `endedAt`).

**No double run.** At most one job of a kind runs per machine. A start that names the `key` of a
job still kept (running, or ended within the last 15 minutes) gets that job back, `joined: true`.
A start while a job of its kind and machine is queued or running also gets that job, whatever its
key or body. So a caller that retries after losing an answer joins the run it started, and never
starts a second one on top of it.

**After a restart of Gram** no job is known, and a poll answers `404`. The caller starts the step
again. A resume is safe to run again: the machine's restore record is durable (`StopMarks`,
[Machines](../MACHINES.md)). It knows which folders are confirmed back, so those aren't put back
twice, and which a resume set out to put back and didn't finish, so the host checks those. A
prepare run again asks the host to keep work that is already at the remote, which it answers as
caught up.

**The synchronous routes stay**, as thin wrappers, until embedders have moved. `/machines/stop/resume`
starts or joins the machine's resume job and answers once it ends. A caller that goes away leaves
the job running, so its retry joins it. `/machines/stop/prepare` starts or joins the prepare job
the same way, but a caller that started the job and goes away cuts it off, as before. Its stop is
then taken back, so no machine holds a stop that its caller will never follow up.

The steady state is that no call waits longer than about 25 seconds.

## Budgets

The table is the single list of how long each long step may take, and who waits on it.
`packages/server/src/host/budgets.ts` holds the numbers, and its test checks that each caller's
deadline is longer than the budget of the step it waits on.

| Step                                                 | Budget                                                                       | Who waits on it                                  | Their deadline                                                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Restore one folder on the host (`host.stop.restore`) | 20 min, counted from when Gram asks                                          | A resume, for that folder                        | The same 20 min. Gram asks one folder at a time, because the host restores one at a time                         |
| Ready the host to stop (`host.stop.prepare`)         | 10 min, which includes waiting for the host's lock                           | A prepare job                                    | 10 min, plus 15 s for shared folders and 30 s to take the stop back: an 11-minute job                            |
| Keep one thread's work (`host.stop.keep`)            | 10 min                                                                       | The work-in-progress keeper, inside Gram         | None beyond the call. It is not a job, because no one outside Gram waits on it                                   |
| A step on the host, holding its lock                 | 1 min less than Gram's call: 9 min (keep, prepare), 19 (restore), 2 (drop)   | Gram's call for it                               | The call's deadline: the host answers, and lets go of its lock, a minute before it                               |
| Resume job                                           | Progress at least every 21 min: a folder's 20, plus 1. A reopen takes 2 min. | An embedder, and sessions waiting on the machine | An embedder polls, and gives up after more than 21 min with no progress. Sessions give up after 25 min with none |
| Prepare job                                          | 11 min in all                                                                | An embedder about to stop the machine            | More than 11 min, polled. The embedder's own stop step must allow for this                                       |
| A session waiting for a machine                      | 5 min for the machine to be started and dial in                              | A person's message                               | Once the machine is back and its resume is making progress, the wait goes on for as long as the resume does      |
| A host about to go (SIGTERM)                         | Up to 35 s, held by the host                                                 | The host's process                               | The host's grace period: 60 s leaves room                                                                        |
| `POST /machines/jobs/get` with `waitMs`              | `waitMs`, 25 s at most                                                       | An embedder's call                               | Longer than `waitMs`. Its own periodic pass should poll with `waitMs: 0` and never wait on a job                 |

**The host's lock.** A host does one keep, prepare, restore or drop at a time. Gram used to send a
machine's restores four at a time. The host queued them, and each queued folder's 20 minutes ran
while it waited. A slow first folder could then make the rest read as "didn't answer" while the
host went on with them where no one saw. Gram now sends them one at a time, so each folder's
budget is its own. A keep or a prepare can still queue behind one other step, and its 10 minutes
cover that wait. Steps on the host take seconds; the budgets are ceilings.

**A step's own budget on the host.** Every git command a host runs has its own time limit (a push
2 minutes, for example). A step runs many of them, one folder after another, so a step as a whole
could still hold the lock long after Gram had stopped waiting for it. Each step the host holds its
lock for (keep, prepare, restore, drop) is therefore held to a budget of its own, one minute less
than Gram's deadline for the call: 9 minutes for a keep or a prepare, 19 for a restore, 2 for a
drop. Past it the host stops the step, its commands with it, answers that it was stopped, and the
next step takes the lock. Gram then hears the answer before its own deadline, and a prepare it
hears this of takes its stop back.

## What an embedder does

- Start a job and keep its `id`. Its periodic pass never awaits a step. A later pass polls with
  `waitMs: 0` and acts on `done` or `failed`.
- Name a `key` that is stable for the step: the machine and the generation of the start it
  follows, for example. A retry then joins the job rather than starting another.
- Give up on a resume only when `progressAt` has not moved for longer than its `budgetMs`. Give up
  on a prepare only after more than its `budgetMs`. Gram ends the job by itself at its budget,
  so an embedder that waits longer always sees the end.
- On a `404` from a poll, Gram has restarted: start again, with the same key.
- On a `404` from a start, its hosted features are off. A Gram older than this answers a
  service's call on the new paths `403` ("forbidden: not for a service"). On either, fall back to
  the synchronous route, with its deadline longer than the step's budget.

## Left out

- **Jobs that outlive a restart.** The resume's durable record already makes a second run safe.
- **The keeper's keep as a job.** It runs inside Gram, which waits on it within its call.
- **Cancelling a job.** `POST /machines/stop/cancel` takes a stop back as before. A resume is
  cut off only by its budget, or by the machine leaving.
