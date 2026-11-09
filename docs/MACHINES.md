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
   release; the join stands. Settings → Machines offers this as **Update** (see
   [Updating a machine](#updating-a-machine)).

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
| `gram-host leave`                                  | Stop the service and forget the join and its key  |

## When a machine is offline

Settings → Machines says why on hover over a machine's state, with the fix where there is one, and
the Machine picker on a new thread says the same on hover over an offline machine. The main Gram
keeps each machine's last reason since it started, in memory only:

| It says                                 | Because                                                                      | Fix                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------- |
| It hasn't dialled in since Gram started | Nothing reached this Gram from it                                            | `gram-host status` there                                    |
| Access over Tailscale is off            | No machine can dial in                                                       | Turn it on in Phone access                                  |
| Clock is 3 min ahead (or behind)        | A dial it signed was more than two minutes off this machine's clock          | Fix the time there                                          |
| A dial wasn't signed by its key         | A dial named it with a signature its key didn't make, or for another address | Remove it, `gram-host leave` there, and add it again        |
| It dialled in but didn't answer         | It never said hello, in time or as itself                                    | Rerun the installer there                                   |
| Connection lost at 14:03                | Its connection closed; it dials again by itself                              | If it stays offline, check Tailscale and `gram-host status` |
| This Gram's tailnet address changed     | Access over Tailscale moved to another address, which it doesn't dial        | `gram-host leave` there, and add it again                   |
| Needs update (1.16.0 → 1.17.0)          | Its host speaks another protocol, or doesn't serve what this Gram needs      | **Update**                                                  |

Only a clock its own key signed is taken as its clock. A bad signature can come from anyone on
your tailnet who knows the machine's id, so it is only ever shown. Nothing from a dial (its
signature, nonce or key) reaches the page, and the listing stays local-app only.

## Updating a machine

Each host says which release it runs when it dials in (from the release after 1.16.0; earlier ones say nothing).
What has to match is the **host protocol**, not the release: every release since joined machines
arrived (1.14.0 to 1.16.0 and this one) speaks protocol 2 with the same messages, so a 1.15.0 host
works with a 1.16.0 main Gram. A call added in a later release fails on its own on an older host, with an
unknown-request error, and the rest keeps working. Only a host on another protocol, or one that
doesn't serve everything this Gram needs, is refused; Settings → Machines then shows **Needs
update** with both releases instead of offline. A host on another release that works shows online,
and its hover says which release it runs.

**Update** (the up-arrow icon, "Update <machine> to <release>" on hover) appears on every
confirmed machine that runs an earlier release than this Gram, and only when this Gram is a release
(a Gram run from source has none to move it to). **Update all** appears beside Add a machine when
more than one is behind. How an update goes shows on the machine's row.

### Over its own connection

A host from the release after 1.16.0 on updates itself over the connection it already has, with no
shell there. It advertises an `update` capability; Update asks it for this Gram's release, and only
that one:

1. **It waits until the machine is idle**: no turn running or waiting on you, no background task,
   no terminal running a command (a thread's shell with a job in the foreground, or an open sign-in
   shell), no clone in flight. The row says what it is waiting for ("Updates to 1.17.0 once cachyos
   is idle: 1 running turn."), and Gram asks again every 30 seconds.
2. **It downloads that release from Gram's own GitHub releases** (macOS on Apple silicon, Linux on
   x64), the same files the installer uses. The address is fixed in gram-host; the main Gram names
   only the release number, never a URL, and the host takes only a release newer than its own.
3. **It checks the download against the release's `SHA256SUMS.txt`** before anything in it runs. A
   download that doesn't match is deleted and nothing is installed.
4. **It unpacks the app into a staging folder** beside the one it runs, tests that its gram-host
   starts (`gram-host --help`), and only then moves it into place, in `apps/<release>`. The app it
   runs now stays.
5. **It hands its service to the new app.** A supervisor, run from the current app outside the
   service (a transient `systemd-run --user` unit on Linux, a one-off launchd job on a Mac), moves
   the service and restarts it. The plan is kept in `update.json` in the host's folder, owner-only.
6. **The new host dials in.** Once its hello has passed, the main Gram asks it how its update went,
   which confirms it. The supervisor then removes the previous app and points `~/.local/bin/gram-host`
   at the new one. If the new host doesn't dial in and pass its hello within two minutes, the
   supervisor moves the service back to the previous app, removes the new one, and the row says it
   rolled back and why.

Nothing there is cut off: the host restarts only while nothing runs, and it checks again just
before it hands over, since a download takes minutes. A machine that got busy meanwhile keeps the
unpacked app and hands over once it is idle, without downloading again.

**Automatic updates.** When this Gram moves to a new release, each joined machine that can update
itself updates to it on its own, once it is idle. A machine that rolled back or failed on that
release isn't tried again on its own; its Update tries it again. This is on by default: turn off
**Update machines automatically** under Settings → Machines to update only when you choose.
Agents can't change it with `settings_propose`.

### By the installer

A host from 1.16.0 or earlier can't update itself, so Update reruns the installer, which brings it
to a release that can:

- For a machine Gram added over SSH, it runs that install again over the same `[user@]host`, with
  no join link. The installer moves the service to this Gram's release and keeps the join; it never
  joins a machine that hasn't, and Gram counts the update done only when the machine prints the
  fingerprint of the one you chose. Gram records where it installed each machine over SSH in
  `remote-access/machines.json` (the host, never a key or password), including a machine added by
  the command that you later add over SSH again.
- For any other machine, it shows the command to run there, with no link in it:

  ```sh
  curl -fsSL https://<device>.<tailnet>.ts.net/host/install | sh
  ```

  On a machine still joined, that moves the service and keeps the join, so there is nothing to
  confirm again. If it says the machine hasn't joined (someone ran `gram-host leave` there), remove
  it here and add it again with a fresh link.

A gram-host run by hand (`gram-host run` in a terminal) rather than as its service doesn't update
itself either: rerun the installer there.

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
  that hasn't been confirmed.
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
  address, closes every joined machine's connection; the machines stay joined and dial in again
  once it is back. Up to 16 machines can be joined.

The listing (`POST /machines/list`), join link, confirm, remove, update and sign-in check
endpoints answer only the local app, never a paired phone or a joined machine, with the same Origin
rules as phone access settings.
