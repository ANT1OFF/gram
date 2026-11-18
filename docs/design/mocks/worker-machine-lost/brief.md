# A worker whose machine was lost: brief

**Problem.** "A worker stopped. Can I resume without losing its changes?" A worker's machine went
away in the middle of a turn (its checks were running). The thread read as idle, the first restart
timed out, and when the machine came back the worker's folder was gone. The user couldn't tell
what had happened, what of the worker's edits survived, or how to carry on with the same worker.

**Who and where.** Whoever runs an orchestrator, on the worker's own thread (where they land from
the orchestrator's worker link or the Needs you list), and on the worker's row in the orchestrator.

**What it rests on (build, not drawn).** Today a thread's work in progress leaves the machine only
when the machine is readied to stop (`host.stop.prepare`, a hidden ref per thread). A machine
that is lost gets no such stop, so nothing is kept. The build keeps the hidden ref fresh while the
thread works: after each turn that changed files, and every few minutes during a long turn when
the folder is dirty. A lost machine then loses at most the last few minutes. The embedding app
tells Gram why a machine went (`lost`, not `idle`), so the thread says so.

**Must show.**
- What happened, in a sentence: the machine was lost at 08:14 while `bun run check` ran. Not idle.
- What was saved: the last save's time (08:12), the files changed (6), the commits on the branch
  (none yet), and that anything after 08:12 is lost. Each file can be opened as a diff.
- One action: Resume worker. It brings the machine back, puts the folder back as saved, and tells
  the same worker (same conversation) what happened, so it re-runs what was cut off.
- The states: lost (the action offered), resuming (machine starting, then folder being put back),
  resumed (the worker's turn going again), and nothing saved (the turn changed no files, or no
  save was made: the action still resumes, and says it starts from the branch).
- The worker's row in the orchestrator: "Machine lost · 6 files saved" with the same action.

**Out of scope.** Why a machine is lost (the platform's), sizes, the orchestrator's own recovery
(its folder is a clone it restores already), the other feedback items (project creation, models,
Start, model switch, autonomy summary, following a task to its PR).

**Open questions, with the defaults taken.**
- Resume as a fresh session or the same one? Default: the same conversation, with a note from
  Gram as the turn's first message; the agent's session is opened again on the restored folder.
- Should the save be visible before anything goes wrong ("Saved 08:12" in the thread's header)?
  Default: no, only in the recovery; a tweak shows it.
- Words: Gram's, generic ("machine"), never the platform's name.
