# Send work to a hosted workspace, and move a workspace there

Follows [Lend this Mac to a hosted workspace](../hosted-device/brief.md), which drew signing in
under Settings → Hosted and hosted workspaces in the sidebar. This mock draws the two things a
person does with a server once signed in.

## Problem

A person plans work in Gram on their own machine and wants the long part done elsewhere: on a
hosted server that keeps working when the laptop is closed. Today a worker can only go to a machine
this Gram controls, which stops being watched when this Gram sleeps. And a workspace that outgrew
the laptop can't be taken to a server: the export exists on the server side with nothing in the
app that calls it.

## Who and where

A person signed in to a hosted server (Settings → Hosted), in the desktop app:

- New task, under Where it runs, and the orchestrator's `spawn_worker`.
- Wherever threads are listed: sidebar, Workers tab, Board, Inbox.
- A workspace's menu, **Move to a server…**, and the Hosted page.

## Must show

- Sending: the hosted workspace in the Machine menu beside this Mac and joined machines; what
  it means in one line; the three checks before sending (the server reaches the repository, the
  base branch is pushed, uncommitted changes stay here) and the blocked case.
- The sent worker: told apart at a glance, its state, pull request and question as for any worker;
  that it runs under the server's rules; what shows when this app is signed out.
- Moving: what goes and what stays, each repository ready or not on the server, running workers,
  the autonomy the server allows, and the workspace afterwards (archived here, a link there).
  Bring back, and Copy settings and memory, as the two neighbours of Move.

## Out of scope

- Signing in, the lending of this Mac, and the hosted view of a workspace: the earlier mock.
- The server's own screens.
- Live two-way sync: a workspace has one home at a time.

## Open questions

- Assumed: a sent worker is a thread of the hosted workspace, run and governed there, and reports
  to the orchestrator that sent it (decided 13 November 2026).
- Assumed: the orchestrator may send work to a server only when the workspace's settings allow it;
  off by default.
- Assumed: a sent worker lands in the server's workspace that covers its repository.
- Assumed: after a move the local workspace is archived, never deleted.
