# Lend this Mac to a hosted workspace

The protocol, the trust model and the threat model behind this mock are in
[the design note](../../personal-device.md). The mock draws what a person sees.

## Problem

A workspace that runs on a hosted Gram server needs nobody's computer to be on. But while someone
is working in the desktop app, a thread there sometimes needs one thing from their own machine: run
a local command, read a local file. Today there is no way to sign in to a hosted server from the
app at all, and no way for a hosted thread to reach back.

Reaching back is the cloud asking to run things on a person's machine, so the screens have to make
three things obvious: what is lent and to whom, exactly what is about to run, and that nothing
runs without them.

## Who and where

A person with the hosted-features setting on, in the desktop app:

- Settings → **Hosted**, to sign in to a server and see its workspaces.
- A hosted workspace's page under Hosted, to lend this Mac and pick folders.
- A thread in a hosted workspace, where a command waits for them.
- The **ask**: a window of its own, drawn by the app and not by the workspace's view.

## Must show

- Signing in: the server's address, the hand-off to the system browser, confirming a new server,
  the signed-in state with its workspaces.
- Hosted workspaces beside local ones in the sidebar, told apart at a glance.
- Lend this Mac: off, on with folders, a folder Gram refuses (`~/.ssh`, the home folder), the
  organisation allowing reading only, the organisation turning devices off, and Resume lending
  after a restart.
- What the folder list does and doesn't limit, said where folders are picked.
- The ask: the server, workspace, thread, who started the turn, the folder, the whole command,
  the agent's reason marked as the agent's; a look-closely warning; a command with hidden
  characters; more asks waiting.
- The thread's side: waiting for you on this Mac, ran with output, you didn't allow it, this Mac
  went offline, and a turn started by someone else being refused.
- That this Mac is being lent, wherever the person is in the app, with Stop lending.
- Activity on this Mac: the local record of what was asked and how it was answered.

## Out of scope

- The hosted server's own pages (its sign-in page, its device list for admins).
- Moving a local workspace to a hosted server, and pushing a Claude or Codex sign-in to one.
- Whole agent sessions on a lent machine; this version runs single commands and reads files.
- Phone layout: lending happens in the desktop app only.

## Open questions

Defaults picked; each is an open decision in the design note.

- Lending turns off when Gram quits, and the next launch offers Resume lending. Default: yes.
- The only rules that skip the ask are reads inside a lent folder, and one exact command for one
  thread until Gram closes. Default: yes.
- Only the thread the person writes to can use their Mac, not workers it spawns. Default: yes.
- The ask is a separate small window rather than a card in the thread. Default: yes; the thread
  shows a row that says a command is waiting, with no button that allows it.
