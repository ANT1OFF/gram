# Other machines

[Up: remote access](REMOTE_ACCESS.md)

Another Mac or Linux machine can join your Gram and run its work: its checkouts, git, terminals,
ports and Claude sessions. The machine you already use keeps Gram's threads, decisions and
settings; the other machine runs `gram-host`, which dials it over Tailscale. The joined machine
opens no port of its own.

A machine can join, be confirmed and stay connected; Settings → Machines lists it. A new thread
in a new worktree can be placed on it, and its session, checkout, git state and terminals then run
there. The Workers tab tags each worker that runs on another machine. Its Files panel, turn
checkpoints, PR badge and port chips don't reach that machine yet.

## Start a thread on a machine

Once a machine is confirmed, **Machine** shows under Where it runs, beside the folder of a new
thread and beside the repository when New task starts a worker. It reads "This machine" until you
pick another. The menu marks a machine that is offline or whose Claude Code isn't signed in.

- Picking a joined machine makes the checkout a new worktree, made from that machine's own clone.
  Current checkout and Existing worktree are off while it is picked, since their folders are on
  this machine.
- A line under Where it runs says where the thread will run. When the machine is offline, lacks
  Claude Code or Git, or isn't signed in, the line says so, with **Check again** (and the sign-in
  icon when signing in is the fix), and Start waits until it can start there.
- A folded New task, one going back to the workspace the last task went to, names the machine in
  the line beside Start. Its Change opens the picker.
- You can also ask the orchestrator to put a worker there: `spawn_worker` takes the machine's name.
  The orchestrator itself always runs on this machine.

## What you need

- Tailscale on both machines, in the same tailnet, and access over Tailscale turned on in Gram on
  the main machine ([phone access](REMOTE_ACCESS.md)). **Add a machine** turns it on for you when
  it is off, or lists what Tailscale still needs on this computer. The joined machine dials the same
  `https://<device>.<tailnet>.ts.net` address a paired phone opens.
- Git on the new machine, and Claude Code signed in there for its sessions (see
  [Sign in on a machine](#sign-in-on-a-machine)). Nothing else: the join command uses the Gram app
  on that machine, or downloads this Gram's release (macOS on Apple silicon, Linux on x64) into the
  host's folder.

## Join a machine

1. On the main machine, open Settings → Machines and choose **Add a machine**. It shows one
   command, with a join link in it that lasts 15 minutes and works once.
2. On the new machine, run it in a terminal:

   ```sh
   curl -fsSL https://<device>.<tailnet>.ts.net/host/install | sh -s -- '<join link>'
   ```

   The installer comes from your own Gram over the tailnet. It uses the Gram app installed there
   (`/Applications/Gram.app`, `~/Applications/Gram.app`, or the .deb's `/opt/Gram`) when it is the
   main Gram's version; otherwise it downloads that release from GitHub, checks it against the
   release's `SHA256SUMS.txt`, and keeps it in `apps` in the host's folder on a Mac, or in
   `~/.local/share/gram-host/apps` on Linux. It writes a `gram-host` command to `~/.local/bin` (the
   app's own binary, run as Node), hands the link to `gram-host join` on stdin, and installs the
   background service. Run it again after the main Gram updates and it moves the service to the new
   release; the join stands.

   The link sits in that shell's history, and in the installer's arguments while it runs. It works
   once and only for 15 minutes, and a machine that joins with it still waits for you to confirm
   it, but if the install fails before it joins, make a new link rather than leave that one live.
   A Gram run from source has no release to download, so the other machine needs Gram installed.

   From a Gram checkout, `node packages/server/src/host/main.ts join` does the same: paste the link
   when it asks. `--name <name>` sets the name it joins with (its host name by default), and
   `--no-service` leaves out the background service.

3. It prints the machine's fingerprint. Once it joins, Settings → Machines lists it as waiting:
   choose **Confirm**, check the fingerprint matches, and choose **They match**. Until it is
   confirmed the main Gram refuses its dials, so a stolen link can't add a stranger's machine
   unnoticed.

The link carries its code in the fragment (`#code=…`), so it never reaches a server or proxy log.
Treat it as a password until it is used or expires.

## The background service

`gram-host join` installs `gram-host run` as a service of your user and starts it:

| Platform | Service                                                                  |
| -------- | ------------------------------------------------------------------------ |
| macOS    | launchd agent `~/Library/LaunchAgents/io.github.ant1off.gram.host.plist` |
| Linux    | systemd user unit `~/.config/systemd/user/gram-host.service`             |

It starts at login, restarts when it stops, and dials the main Gram again whenever the connection
ends, waiting longer each time up to 30 seconds. On Linux it runs only while you're logged in
unless you allow it to linger: `loginctl enable-linger "$USER"`. The macOS log is `host.log` in
the host's folder; on Linux use `journalctl --user -u gram-host`.

| Command                                            | What it does                                      |
| -------------------------------------------------- | ------------------------------------------------- |
| `gram-host run`                                    | Dial and serve in the foreground                  |
| `gram-host service install \| uninstall \| status` | Manage the service                                |
| `gram-host status`                                 | The main Gram it joined, its fingerprint, service |
| `gram-host leave [--no-service]`                   | Stop the service and forget the join and its key  |

## Sign in on a machine

A joined machine runs Claude Code on its own sign-in. While it is online, its host checks two things when it connects, and again when a listing finds the answer more than a minute old:

- **Its sign-in.** The host runs that machine's own `claude auth status --json`, through the same readiness check its sessions use. It tells this Gram only the result: signed in, not signed in, an API key, a third-party provider, or unknown. Unknown covers an older `gram-host` or a status it couldn't read.
- **Its tools.** It looks for `claude` and `git` in a non-interactive login shell (`$SHELL -lc 'command -v …'`) and reads their versions.

No command output, token or credential file leaves the machine.

- Settings → Machines lists the versions it found ("Claude Code 2.1.319 · Git 2.47.0"). When something is missing, the row says what, with the fix: "Claude Code isn't installed on <machine>, or isn't on its login shell's PATH.", or "Claude Code isn't signed in on <machine>. Run `claude /login` there."
- A machine that is signed out gets a sign-in icon on its row, "Sign in to Claude on <machine>" on hover. It opens a shell on that machine, inside Gram, in its home folder, with `claude /login` typed but not run.
  - Press Return to run it, open the link it prints to sign in in this computer's browser, and paste the code into the terminal if the page shows one.
  - When the shell ends or you close the terminal, Gram asks the machine again and the row updates.
  - The machine's Claude Code keeps the login there, as it does in its own terminal. Gram only types the command; it never reads, copies or relays what Claude Code stores.
- The Machine picker marks such a machine, and its line under Where it runs offers the same sign-in, in a dialog.
- A session that still can't start there names the machine, for example "Claude Code isn't logged in on <machine>. Run `claude /login` there, or choose Sign in under Settings → Machines." The main Gram's log records each failed start on a joined machine with the machine, the agent and the reason code.

## Its repositories

A worker placed on another machine works in a worktree of that machine's own clone of the
project's repository, never in a folder on this one. The host finds the repository by the
project's `origin` remote here and clones it the first time, then fetches it each time a worker
starts there. Clones go in `repos` in the host's folder, by host, owner and name
(`repos/github.com/acme/widgets`), or in `GRAM_HOST_REPOS` when it is set before `gram-host join`
or `gram-host service install`.

- Only `https://` and `ssh` remotes are cloned, never `file`, `ext` or `git://`, and never a URL
  with a password or token in it. The clone uses that machine's own git credentials (its SSH keys
  or credential helper), so the repository has to be reachable from there.
- A clone that fails or is stopped leaves nothing behind. A folder that is already there but isn't
  a clone of that remote is left alone, and the worker isn't started.
- A joined machine's terminals open with its own default shell on its own PATH.
- While the machine is offline its workers don't start and their folders aren't marked missing;
  nothing falls back to running on this machine.
- A message sent while the connection is down waits for the machine for up to two minutes, as its
  session does, and is handed to the agent once it dials in again; if the connection dropped before
  Gram heard back, Gram asks again under the same id and the host takes it only once. A machine
  that doesn't come back in time leaves the message at the top of the thread's queue, and the
  thread says it wasn't delivered.

## Add a machine over SSH

If this computer can already SSH to the other machine with a key, Settings → Machines → **Add a
machine** does it all from here: type `user@host` or pick a `Host` from `~/.ssh/config`, and choose
**Add over SSH**. Gram runs the installer above on that machine over your own `ssh`, with a fresh
join link inside the script on the session's stdin, so the link never reaches a command line or
shell history on either side. The script runs in your login shell there, so the service keeps the
PATH your terminal has (Homebrew, `~/.local/bin`).

- **Keys only.** It runs `ssh -o BatchMode=yes`: your keys and agent, and your SSH config's
  options for that host, never a password prompt. If `ssh <host>` asks for a password, set up a
  key first. The host must look like `[user@]host` or a config alias, never an option.
- **Confirmed for you.** The installer prints the new key's fingerprint into the session. Gram
  confirms the machine only when the one machine that joined during the install has that key,
  which is the same check you'd make by eye, over a channel only your own SSH could open.
  Otherwise it stays waiting for you to confirm it.
- **Still over Tailscale.** The other machine connects to this Gram over your tailnet like any
  joined machine, so it needs Tailscale signed in to the same tailnet; SSH is only how it gets
  installed.
- A first install downloads Gram there, which can take a few minutes, and one runs at a time. If
  it fails, the dialog shows the end of what the session printed, and makes a new link. If the
  machine joined with the printed key and only its service failed to start (a Mac with nobody
  signed in, say), it is still confirmed, and the dialog says what went wrong.

## How it is secured

- **Its own key.** Joining makes an Ed25519 key pair on the new machine. The private key stays in
  its folder (`~/Library/Application Support/Gram Host` on a Mac, `~/.config/gram-host` on Linux,
  or `GRAM_HOST_HOME`), owner-only. The main Gram keeps only the public key, in
  `remote-access/machines.json` in its data folder. The machine's id and fingerprint are both
  derived from that key.
- **Every dial is signed.** A dial carries the machine's id, the time, a fresh nonce and a
  signature over them and the main Gram's address. The main Gram refuses one that isn't signed by
  the machine's pinned key, is more than two minutes off, repeats a nonce, or comes from a machine
  that hasn't been confirmed. A confirmed machine's accepted nonces are kept in
  `remote-access/dial-nonces.json` through their two minutes, so a dial replayed after the main
  Gram restarts is refused too. Once a nonce is let go, no dial signed at or before its time is
  taken, so a clock set back can't bring it back either. Each write also sets the file's modified time
  to the latest time any run accepted a dial at, which a clock set back never lowers; the time is
  set on the new file before it replaces the old one, so a write that fails leaves the old one as
  it was. When the file's content can't be read, no dial signed before two minutes past that time
  (or past now, if later) is taken. When even its time can't be read, no dial is taken at all, and
  `/host/connect` answers 503 "dial history unreadable".

  That happens when the file or its `remote-access` folder can't be opened at all, as when its
  permissions changed. Recover by keeping the history: make the folder owner-only again
  (`chmod 700`, the file `chmod 600`) and leave the file as it is, or put back the latest copy of
  it. The next dial uses it, with no restart, and every dial it recorded stays refused. An older
  backup is a reset of the dials accepted after it was taken, so treat it as one.

  Reset the history (move the file aside, or restore an older copy) only as a last resort, and
  only once more than four minutes have passed since any joined machine last dialled in, with this
  machine's clock and the joined machines' clocks steady over that time. A dial signed up to two
  minutes ahead stays valid for two minutes after that, so a shorter wait lets captured dial
  headers be replayed once. That elapsed time can't be trusted if a clock was set back meanwhile.
  When in doubt, remove the machines in Settings → Machines and join them again instead: their old
  keys, and every dial signed with them, are then refused.

- **Not a browser.** The install, join and dial endpoints answer only requests addressed to the tailnet
  name (which Tailscale Serve forwards over loopback), and refuse any request with an `Origin`, so
  no web page can reach them. They take no browser cookie, and a browser's cookie grants nothing
  there. Without the join code or a joined machine's key they grant nothing either.
- **App tools over the tailnet.** A session on a joined machine reaches its thread's app tools at
  `/host/mcp` on the main Gram's tailnet address, with that thread's own token. It is let through
  only for a thread placed on a joined machine that is online now, and never with an `Origin`.
  Threads on this machine keep to the loopback endpoint.
- **Removing a machine** (Settings → Machines → Remove) forgets its key and closes its connection at
  once, including one still connecting. Turning access over Tailscale off, or onto another
  address, closes every joined machine's connection, including a dial let in just before and still
  connecting; the machines stay joined and dial in again once it is back. Up to 16 machines can be
  joined.
- **Leaving** (`gram-host leave`) forgets the join only once `launchctl` or `systemctl` stopped the
  background service or says it isn't loaded or running. When it can't stop it or say, the join
  and key stay, and it says the host may still be running, even when the service's file is gone.
  `gram-host leave --no-service`, for a machine that joined with `--no-service`, forgets them
  without asking.

The listing (`POST /machines/list`), join link, confirm, remove and sign-in check endpoints answer
only the local app, never a paired phone or a joined machine, with the same Origin rules as phone access settings.
