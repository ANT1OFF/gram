# Moving one thread to another Gram, and back

[Mock](mocks/hosted-move-a-thread/handoff.md) · Follows the workspace move
(`packages/contracts/src/workspace-transfer.ts`)

Status: proposed, 18 November 2026. Behind the hosted features setting (`embeddingOn`), like the
workspace move.

A workspace move takes a whole workspace and leaves the agents' sessions and worktrees behind. This
moves **one thread with its live parts**, so it carries on where it stopped on a Gram it is signed
in to, and comes back the same way. A thread has one home at a time: the side it left keeps a
read-only copy.

## What goes

| Part                                                 | How                                                                                                                                                                                                   |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The conversation and its turns                       | In the bundle, scrubbed as the workspace bundle's are (`scrubbed`, tools censored by key)                                                                                                             |
| Where the agent got to                               | A handoff note, written by the leaving agent as a switch's is (`Handoff`, note mode `outgoing`). The new side opens a fresh session with it, as Continue in does. No agent's own session file travels |
| Its edits, tracked and untracked, gitignore honoured | The hidden ref `refs/gram/wip/<thread>`, kept and pushed by the host it ran on (`host.stop.keep`). The bundle names the ref and the commit; the branch is never touched                               |
| Its branch                                           | Pushed as it is; the bundle names it                                                                                                                                                                  |
| Model and agent                                      | Named, so the receiving Gram can say what changes before it starts                                                                                                                                    |

Never in a bundle: sign-ins, keys, ignored files, this machine's hooks and MCP servers, terminals,
approvals in flight. Anything that looks like a key in messages or the note goes as `[removed]`;
files in the edits that look like they hold one are named on the review so the person can rotate it.

## Steps

1. **Check** (`thread.transfer.check`): the thread exists here and is not archived; whether a turn
   runs; its repository's shareable remote; files among the edits that look like a key; the tools
   from this machine its conversation used. Changes nothing.
2. **Export** (`thread.transfer.export`): waits for the turn to end, or stops it when asked. The
   agent writes its handoff note in a last short turn; a thread whose agent can't (a limit, a
   failure) goes with the conversation alone, said so in the note. The host keeps the edits on the
   hidden ref and pushes it. Answers the bundle. Nothing here changes yet.
3. **Import** on the other Gram (`thread.transfer.import`): a thread with the conversation, marked
   as brought in (`transferredFrom`), placed by that Gram's own rules on a machine of its own. The
   host makes its folder from the remote and puts the edits back from the named ref and commit
   (`host.stop.restore`, which gains an optional `ref` checked with `isWipRefOf`, since the ref was
   written under another thread id or namespace). The first message is the handoff.
4. **Settle** (`thread.transfer.settle`) back here, once the other side answers: the thread here
   becomes read-only and archived, with `transferredTo` naming where it went. A move that fails
   before this changes nothing here, and the pushed ref is dropped (`host.stop.drop`).

Bringing a thread back is the same four steps in the other direction. Before the edits land, a
folder here that changed since is put aside on a branch of its own.

## Who decides

- The receiving Gram takes a bundle only through a call made for a person, as a
  [person's thread started in repositories](../EMBEDDING.md#a-persons-thread-started-in-repositories)
  is, so whoever runs it decides whether a thread may come in, and its own rules (models, autonomy,
  audit) apply from the import on. A bundle is untrusted input there: the conversation is text, the
  note goes inside the handoff's fence, and nothing in it sets a setting or a permission.
- The sending Gram decides nothing for the other side. It shows what the other side's check says.

## Build order

1. Bundle and the four calls, Gram to Gram, with a test that moves a thread between two servers
   and back over the host protocol's fake.
2. The shell's calls to a server signed in to (`hostedDevice.moveThread`), and the dialog.
3. Bringing back.
