# Move a thread to a server, and bring it back

Follows [Send work to a hosted workspace, and move a workspace there](../hosted-send-and-move/brief.md),
which moves a whole workspace and leaves agent sessions and worktrees behind. This mock moves **one
thread with its live parts**, so the conversation carries on where it stopped, in either direction.

## Problem

A person is mid-way through a coding thread on their laptop and wants it to keep going on the
server while the laptop is closed, then later pick it up on the laptop again. Today they can only
start over there, or move the whole workspace and lose the agent's session and uncommitted edits.

## Who and where

A person signed in to a server (Settings → Hosted), in the desktop app:

- A local thread's "…" menu: **Move to a server…**, beside Continue in Codex and Fork.
- A hosted thread's "…" menu: **Bring back to this Mac…**.
- A sent worker in a local orchestrator's workers list, when it waits on an approval.

## Must show

- Move up, review: what goes (the conversation, the agent's session, its edits as of now kept on
  the hidden ref, its branch) and what stays (sign-ins, this Mac's agent settings, hooks and MCP
  servers, terminals). Checks: the server reaches the repository; a running turn; whose model
  account it runs on afterwards and whether the model changes; anything in the conversation that
  looks like a secret, left out of what goes.
- Move up, moving and moved: the thread here archived as moved, never deleted; one home at a time.
- Bring back, review: what comes, the account it runs on here, and that the organisation's audit
  records it. The case where the organisation doesn't allow bringing work back.
- A sent worker waiting on an approval: shown here, decided only on the server.

## Out of scope

- Signing in, lending this Mac, sending a task, moving a whole workspace: earlier mocks.
- The server's own screens.
- Model calls on the organisation's account from this Mac.

## Open questions

- Assumed: the verbs are Move and Bring back, the same as a workspace's, in the thread's menu.
- Assumed: a moved worker becomes a sent worker and keeps reporting to the orchestrator here.
- Assumed: a running turn finishes first; "Stop and move" is the alternative.
- Assumed: a secret-looking line is replaced by `[removed]` in what goes, by default, and shown.
- Assumed: bringing work back is the organisation's choice, off unless it allows it.
