# Other machines

[Up: remote access](REMOTE_ACCESS.md)

Another Mac or Linux machine can join your Gram and run its work: its checkouts, git, terminals,
ports and Claude Code, Codex and OpenCode sessions. The machine you already use keeps Gram's threads, decisions and
settings; the other machine runs `gram-host`, which dials it over Tailscale. The joined machine
opens no port of its own.

A machine can join, be confirmed and stay connected; Settings → Machines lists it. A one-off
chat can run in a folder there, its home by default, and a new thread in a new worktree can be
placed on it; its session, checkout, git state and terminals then run there. A thread that runs
on another machine says which wherever it is listed ([where a thread runs](#where-a-thread-runs)). Gram's own
[local check](#its-local-checks) of its pull request runs there too. Its Files panel, file
previews and attachments work on that machine ([its files](#its-files-and-attachments)); its turn
checkpoints, PR badge and port chips don't reach that machine yet.

A Gram that runs as a service can also take hosts that another system starts and registers by
key, over ordinary TLS with no Tailscale and nothing to confirm: see
[provisioned hosts](PROVISIONED_HOSTS.md).

Signed in to a hosted server that offers it (Settings → Machines → Hosted servers), an
orchestrator here can give a heavy worker a machine of its own from that server, through
`spawn_worker`'s `sandbox`. The machine joins this Gram as a worker host: it shows under Machines
while it runs, takes only the workers placed on it, and is released when their work is over. It
reaches this Gram through the hosted server, which the app dials, so nothing here listens for it.
See [the design](design/desktop-worker-machines.md).

## Start a thread on a machine

Once a machine is confirmed, **Machine** shows first under Where it runs on New → Chat. It reads
"This machine" until you pick another. The menu marks a machine that is offline or whose Claude
Code isn't signed in. New → Team hands the task to the workspace's orchestrator, which picks where
each of its workers runs.

- **A chat in a folder there.** Picking a joined machine puts the chat in its home folder (`~`
  there). The Folder chip beside it lists that machine's home and the folders its recent chats ran
  in, and **Another folder on <machine>…** opens a path field and a browser of its folders under
  More options. Type a path (`~/scratch`, `/srv/media`) or browse; every listing and check is that
  machine's own, done by its host, never this machine's disk.
- The line under Where it runs names the machine and the folder's real path before you start
  ("Runs on cachyos in /home/dev, as it is"). The thread's header shows the machine and the folder
  afterwards, with the whole path on hover.
- The chat runs in the folder as it is: no worktree is made. Outside a git repository there is no
  diff, pull request, checkpoint or local check, as for a chat in a plain folder on this machine.
- **A new worktree there.** The Folder chip's **New worktree on <machine>, from** lists the
  recent repositories on this machine: picking one makes a new worktree of the joined machine's own
  clone of its `origin` ([its repositories](#its-repositories)). Current checkout and Existing
  worktree are off while it is picked, since their folders are on this machine.
- When the machine is offline, lacks Claude Code or Git, or isn't signed in, the line says so, with
  **Check again** (and the sign-in icon when signing in is the fix), and Start waits until it can
  start there.
- You can also ask the orchestrator to put a worker there: `spawn_worker` takes the machine's name
  or id, in any case. `local` and `this machine` are reserved for this machine: naming either, like
  naming none, runs the worker here, and a machine can't join under either name. A blank or unknown
  name is refused, with the joined machines listed. The orchestrator itself always runs on this
  machine, and a worker always runs in a new worktree: only you pick a folder on a joined machine,
  one chat at a time.

### Where a thread runs

A thread on this machine carries no mark. One on another machine names it wherever the thread is
listed: its row in the sidebar, its header, the Workers tab, the Board, a feature's card in the
orchestrator's chat and the Inbox.

- **The mark** is a server glyph and the machine's name in muted words. Where a row's edge already
  has words of its own ("asks you", "checks"), the glyph stands alone and the name is on the row's
  hover.
- **A machine nothing reaches** takes the struck glyph and says "offline", or "needs update" for a
  host on an earlier protocol than this Gram's, in the text colour. It shows without a hover, and
  at once: the server sends every window the machines' states when one connects or drops, so
  nothing polls.
- **The hover** says the machine, whether it is a joined machine or a provisioned host, and its
  state ("online for 2 hours"); offline, also why and the fix, in the words Settings → Machines
  uses ([when a machine is offline](#when-a-machine-is-offline)). Two things only Settings says:
  why Tailscale is down on this computer (a mark says the connection was lost, and when), and the
  time of each refused dial after the first, since a badly signed dial can be repeated by anyone
  on the tailnet and is no news to every window.
- A thread whose machine was removed says "not joined".
- An orchestrator reads the same on `list_workers`: a worker's row has `machine`, its name and
  `online`, when it runs on another machine.

Every client is sent this much of a confirmed machine, a paired phone included: its name, whether a
person joined it or a control plane registered it, whether it is dialled in, and why not. The rest
of what Settings → Machines lists (fingerprint, sign-in, tools, SSH target, updates) stays the local
app's.

### Which folders a chat may use there

**The folder guard prevents mistakes; it doesn't isolate you from the agent.** A session on a
joined machine runs as that machine's user, with that user's permissions. From any folder,
including a worker's worktree, it can read whatever that user can read, `~/.ssh` included, through
its shell. Gram doesn't sandbox it, and the folder you pick doesn't change that. What the guard
does is keep you from starting a chat in, or browsing into, a folder that is plainly no place for
one.

What does hold:

- **Only the Gram app on this computer can list, check or start a chat in a folder on a joined
  machine.** It does so over the machine's own signed connection. A paired phone can still start
  chats in projects and worktrees as before, but it can't list another machine's folders, check
  them, or start a chat in one: the server refuses those from any connection but the app's own.
  Once such a chat exists, a paired phone can continue it, resume it or fork it, like any other
  thread: the phone works in the folder the app chose, but only the app can choose a chat's
  machine and folder.
- **You choose a folder outside the host's clones for one chat at a time.** Nothing an agent
  starts, a worker or a task chip, gets such a folder: workers always get a new worktree there, and
  a task chip from such a chat starts from New task instead. A fork of the chat stays in its
  folder.
- **A picked folder never owns anything.** A chat in a folder you picked never gets the ownership
  of a worker's worktree (full-auto merges, its pull request, the local check), even when that
  folder is inside one of the host's clones. That ownership comes only from the record Gram keeps
  of the worktrees it made.

The guard itself, on the joined machine's host:

- It refuses credential folders and anything in them (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`,
  `~/.docker`, `~/.config/gh`, `~/.config/gcloud`, keyrings and the like). It refuses the agents'
  login folders (`~/.claude`, `~/.codex`, and `CLAUDE_CONFIG_DIR` or `CODEX_HOME` where set) and
  Gram Host's own folder (`~/.config/gram-host` on Linux, `~/Library/Application Support/Gram
  Host` on a Mac, or `GRAM_HOST_HOME`) with its clones. It also refuses the whole filesystem (`/`).
- It compares real folders rather than how a path is written, so a link to one of those folders
  or another spelling of its name is refused too. When it can't read where one of those folders is
  (a permission or disk error), it refuses rather than guess.
- It runs when the folder browser lists a folder, when you pick a folder, and each time a session
  opens there. A worker's session in a worktree of the host's clones is let through.
- The browser lists folders only, never files, at most 500 of them, and gives up on a folder or
  mount that doesn't answer within a few seconds.
- A host from an older release doesn't list its folders. Update it before you pick a folder there.

A Gram started as a [headless control plane](DOCKER.md#a-headless-control-plane) has no "This
machine": every thread runs on a joined one, and one that names none goes on the machine that
joined first of those online.

## What you need

- Tailscale on both machines, in the same tailnet, and access over Tailscale turned on in Gram on
  the main machine ([phone access](REMOTE_ACCESS.md)). **Add a machine** turns it on for you when
  it is off, or lists what Tailscale still needs on this computer. The joined machine dials the same
  `https://<device>.<tailnet>.ts.net` address a paired phone opens.
- Git on the new machine, and Claude Code signed in there for its sessions: its own
  `claude /login` (see [Sign in on a machine](#sign-in-on-a-machine)), or a token from this machine
  ([below](#a-claude-token-from-this-machine)). For Codex sessions, Codex installed and signed in
  there too ([Codex on a machine](#codex-on-a-machine)). Nothing else: the join command uses the Gram app on
  that machine, or downloads this Gram's release (macOS on Apple silicon, Linux on x64) into the
  host's folder.

## Join a machine

1. On the main machine, open Settings → Machines and choose **Add a machine**. It shows one
   command, with a join link in it that lasts 15 minutes and works once.
2. On the new machine, run it in a terminal:

   ```sh
   curl -fsSL 'https://<device>.<tailnet>.ts.net/host/install' | sh -s -- '<join link>'
   ```

   The installer comes from your own Gram over the tailnet. It uses the Gram app installed there
   (`/Applications/Gram.app`, `~/Applications/Gram.app`, or the .deb's `/opt/Gram`) when it is the
   main Gram's version; otherwise it downloads that release from GitHub, checks it against the
   release's `SHA256SUMS.txt`, and keeps it in `apps` in the host's folder on a Mac, or in
   `~/.local/share/gram-host/apps` on Linux. It writes a `gram-host` command to `~/.local/bin` (the
   app's own binary, in host mode), hands the link to `gram-host join` on stdin, and installs the
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

## Update a joined machine

A joined machine from the release after 1.16.0 on updates itself to the main Gram's release over
its own connection, on its own once it is idle or when you choose Update (see
[Updating a machine](#updating-a-machine)). An older one needs its installer rerun once, which
brings it to a release that does. An existing join is kept and its background service moves to the
updated app; no new join link or confirmation is needed:

```sh
curl -fsSL 'https://<device>.<tailnet>.ts.net/host/install' | sh
```

The repository identity and explicit-base fixes run in that machine's host. Updating the main
Gram alone does not change an older joined host's repository behavior. Until it updates, that host
can still reuse a different repository origin or silently choose a default base.

## The background service

`gram-host join` installs `gram-host run` as a service of your user and starts it:

| Platform | Service                                                                  |
| -------- | ------------------------------------------------------------------------ |
| macOS    | launchd agent `~/Library/LaunchAgents/io.github.ant1off.gram.host.plist` |
| Linux    | systemd user unit `~/.config/systemd/user/gram-host.service`             |

It starts at login, restarts when it stops, and dials the main Gram again whenever the connection
ends, waiting longer each time up to 30 seconds. A connection the main Gram has sent nothing on for
20 seconds counts as ended too: the main Gram pings every 5 seconds, so a link that broke without
a word (its tailnet went down, a sleep) is dialled again rather than waited on. The main Gram
gives the host the same 20 seconds to answer, so a machine that stalls for a few seconds under
load (swapping, its disk saturated) stays connected; one that stays silent longer shows offline at
once, as its connection lost, and dials again by itself. Each "not connected; dialling again" line
in its log says why the last dial ended. On Linux it runs only while you're logged in
unless you allow it to linger: `loginctl enable-linger "$USER"`. The macOS log is `host.log` in
the host's folder; on Linux use `journalctl --user -u gram-host`. A `gram-host run` in a terminal
of its own, which `gram-host leave` doesn't stop, stops dialling within seconds of the leave, and
its sessions end with it.

| Command                                            | What it does                                      |
| -------------------------------------------------- | ------------------------------------------------- |
| `gram-host run`                                    | Dial and serve in the foreground                  |
| `gram-host service install \| uninstall \| status` | Manage the service                                |
| `gram-host status`                                 | The main Gram it joined, its fingerprint, service |
| `gram-host leave [--no-service]`                   | Stop the service and forget the join and its key  |
| `gram-host new-disk`                               | Take a disk Gram refuses back as the machine      |

This machine's own host can run the same way, kept running after Gram quits, when you turn that
on: see [agents after Gram quits](AGENTS_AND_FEATURES.md#agents-after-gram-quits).

## When a machine is offline

Settings → Machines says why on hover over a machine's state, with the fix where there is one, and
the Machine picker on a new thread says the same on hover over an offline machine. The main Gram
keeps each machine's last reason since it started, in memory only:

| It says                                 | Because                                                                      | Fix                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------- |
| It hasn't dialled in since Gram started | Nothing reached this Gram from it                                            | `gram-host status` there                                    |
| Access over Tailscale is off            | No machine can dial in                                                       | Turn it on in Phone access                                  |
| Tailscale is stopped on this Mac        | Access is on, but Tailscale here is stopped, signed out or missing           | Turn it on; Gram reconnects machines by itself              |
| Gram couldn't set up Tailscale Serve    | Access is on, but Serve refused Gram's listener                              | Phone access says why                                       |
| Clock is 3 min ahead (or behind)        | A dial it signed was more than two minutes off this machine's clock          | Fix the time there                                          |
| A dial wasn't signed by its key         | A dial named it with a signature its key didn't make, or for another address | Remove it, `gram-host leave` there, and add it again        |
| It dialled in but didn't answer         | It never said hello, in time or as itself                                    | Rerun the installer there                                   |
| Connection lost at 14:03                | Its connection closed; it dials again by itself                              | If it stays offline, check Tailscale and `gram-host status` |
| This Gram's tailnet address changed     | Access over Tailscale moved to another address, which it doesn't dial        | `gram-host leave` there, and add it again                   |
| Needs update (1.16.0 → 1.17.0)          | Its host speaks a protocol this Gram doesn't, or lacks what this Gram needs  | **Update**                                                  |

Only a clock its own key signed is taken as its clock. A bad signature can come from anyone on
your tailnet who knows the machine's id, so it is only ever shown. Nothing from a dial (its
signature, nonce or key) reaches the page, and the listing stays local-app only; a thread's mark
gets a machine's name and these reasons on every client ([where a thread runs](#where-a-thread-runs)).

## Updating a machine

Each host says which release it runs when it dials in (from the release after 1.16.0; earlier ones say nothing).
What has to match is the **host protocol**, not the release: every release since joined machines
arrived (1.14.0 on) speaks protocol 2, so a 1.15.0 host works with a 1.16.0 main Gram. Only a host
on a protocol this Gram doesn't talk to, or one that doesn't serve everything this Gram needs, is
refused; Settings → Machines then shows **Needs update** with both releases instead of offline. A
host on another release that works shows online, and its hover says which release it runs.

### Machines on different releases

Between releases the host protocol only grows. Updating Gram on one side never makes the other
side restart or update first: a joined machine on an earlier release stays connected and keeps its
running sessions, and so does a machine on a later release than the Gram it joined. Each side
works without what the other doesn't have yet:

- **A call added later** fails on its own on an older host, with an unknown-request error, and
  the rest keeps working.
- **A field added later** is optional. A build from before it ignores it when it arrives and
  leaves it out when it sends.
- **Something a host newly can do** is named in its hello, and Gram uses it only on a host that
  names it. A host without it loses that one thing: a host from 1.19.0 or earlier takes no thread
  started from a profile, for instance, and everything else runs there. Hosts name these in
  `features`, a list of plain names that a Gram from before one of them reads and ignores. The
  older `capabilities` list is closed, because Gram up to 1.19.0 refuses a hello with a
  capability it doesn't know.
- **What Gram needs of every host** (files, ports, worktrees, git, terminals, sessions, repos)
  never grows.

What may not happen between releases: a call or a field going away, a field becoming required, a
value changing its type or the values it takes. A test holds every change to that
(`packages/contracts/src/rpc/host-compat.test.ts`), comparing the protocol with a checked-in copy
of it as each release since 1.19.0 spoke it (`host-released/<release>.json`), in both directions,
since either side may be the older one, and a machine may be several releases behind. A change that really can't keep a released build working is a new protocol version,
decided on purpose; Gram then says which versions it still talks to, and only a host outside them
shows **Needs update**.

**Update** (the up-arrow icon, "Update <machine> to <release>" on hover) appears on every
confirmed machine that runs an earlier release than this Gram, and only when this Gram is a release
(a Gram run from source has none to move it to). **Update all** appears beside Add a machine when
more than one is behind. How an update goes shows on the machine's row.

### Over its own connection

A host from the release after 1.16.0 on updates itself over the connection it already has, with no
shell there. It advertises an `update` capability; Update asks it for this Gram's release, and only
that one:

1. **It waits until the machine is idle**: no turn running or waiting on you, no background task,
   no project check ([Its local checks](#its-local-checks)), no terminal running a command (a
   thread's shell with a job in the foreground, or an open sign-in shell), no clone in flight. The row says what it is waiting for ("Updates to 1.17.0 once cachyos
   is idle: 1 running turn."), and Gram asks again every 30 seconds.
2. **It downloads that release from Gram's own GitHub releases** (macOS on Apple silicon, Linux on
   x64), the same files the installer uses. The address is fixed in gram-host; the main Gram names
   only the release number, never a URL, and the host takes only a release newer than its own, in
   semver order (`1.17.0-rc.2` before `1.17.0-rc.10`, both before `1.17.0`).
3. **It checks the download against the release's `SHA256SUMS.txt`** before anything in it runs. A
   download that doesn't match is deleted and nothing is installed.
4. **It unpacks the app into a staging folder** beside the one it runs, tests that its gram-host
   starts (`gram-host --help`), and only then moves it into place, in `apps/<release>`. The app it
   runs now stays.
5. **It stops taking new work, and looks once more.** From here the host refuses to open a session
   or hand one a message, open or type into a terminal, clone, make a worktree or run a check
   ("This machine is updating Gram. Try again in a moment."), and work it took just before counts
   as running. If anything runs, it takes work again and waits; it keeps the unpacked app, so the
   next try doesn't download again.
6. **It hands its service to the new app.** A supervisor, run from the current app outside the
   service (a transient `systemd-run --user` unit on Linux, a one-off launchd job on a Mac), moves
   the service and restarts it. The plan is kept in `update.json` in the host's folder, owner-only,
   under an id of its own; one update runs at a time, and one supervisor, which acts only on its
   own plan. Its lock is a loopback port of the host's own, which the kernel lets only one process
   hold and frees the moment its holder ends: nothing is ever taken over. Each change of the plan's
   phase holds the port beside it the same way. The pair, between 20000 and 29999, comes from the
   host folder itself (its device and inode, whatever path leads to it), so two spellings of one
   folder share one lock. Both are checked before anything is downloaded or changed: if another
   program uses either port, the update is refused and names the port.
7. **The new host dials in.** It takes no work until its update is confirmed. Once its hello has
   passed, the main Gram asks it how its update went, which confirms it and lets it take work. The supervisor then removes the app the host ran before (no other) and points
   `~/.local/bin/gram-host` at the new one. If the new host doesn't dial in and pass its hello
   within two minutes, the supervisor moves the service back to the previous app, removes the new
   one, and the row says it rolled back and why. Confirming and giving up are decided one at a
   time: once the supervisor has given up, a late confirmation confirms nothing, and the new host,
   still closed to work, has taken none. If moving the service back fails too, both apps
   stay and the row says the update failed: rerun the installer there.

Nothing there is cut off: the host restarts only once nothing runs and nothing new can start.

**If the machine restarts mid-update.** A reboot takes the supervisor with it. When gram-host next
starts, it looks for an unfinished update: one confirmed is recorded as done; one never confirmed,
once its two minutes (and one more for the supervisor to start) have passed, gets a new supervisor
that only moves the service back. That needs the app the service runs then to start at all; it
passed its `--help` test before the switch, but if it can't start, the machine stays down until the
installer runs there.

**Automatic updates.** When this Gram moves to a new release, each joined machine that can update
itself updates to it on its own, once it is idle. A machine that rolled back or failed on that
release isn't tried again on its own; its Update tries it again. This is on by default: turn off
**Update machines automatically** under Settings → Machines to update only when you choose. The
switch is kept beside the machines (`remote-access/machine-updates.json`), not in Settings, so only
this computer's app changes it: not a paired phone, and not an agent. A switch file Gram can't read
as its own (a link, a folder it can't look into, one that isn't private) counts as off.

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
  curl -fsSL 'https://<device>.<tailnet>.ts.net/host/install' | sh
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

## Codex on a machine

A joined machine whose `gram-host` is this release or newer runs Codex sessions too, on that
machine's own `codex` and sign-in, the way it runs Claude Code. A thread or worker on Codex placed
there opens its app-server there; this Gram never starts Codex for it.

- **Its sign-in.** The host asks that machine's Codex, and tells this Gram only the result: a
  ChatGPT login, an API key (or a provider of the machine's own), not signed in, or unknown. It
  also says whether `codex` is on its login shell's PATH, and its version.
- **Its models.** The model picker, and a worker's tier on that machine, use what that machine's
  Codex lists. A headless Gram lists the Codex models of the machine a new thread would go on.
- **Its homes.** A session lives in a Codex home of that machine: the user's own (`~/.codex`, or
  the `CODEX_HOME` the host was started with), or, for a thread in a workspace that asks before a
  push, Gram's native gated home in the host's own folder, which links that machine's
  `auth.json` by path. Gram never reads or copies the login file; Codex keeps and refreshes it. A
  thread resumes in the home it started in.
- **Its lifecycle.** Permission modes, approvals, interrupts, restarts and resumes work as they do
  for a Codex thread on this machine. A restart waits there for the previous app-server to exit.
- **A gateway profile stays here.** A profile's key never leaves this Gram, so a session on a
  gateway profile doesn't run on a joined machine. A platform that starts a host for its own users
  and routes Codex through its own gateway gives the host process the environment Codex reads (a
  `CODEX_HOME` naming its provider, and that provider's key variable), as it does for Claude Code;
  that machine's Codex then runs on it. A thread that asks before a push runs on that provider
  too, in Gram's gated home with the same prompt rules, when the machine has no ChatGPT login:
  its configuration's `model_provider` names a provider it defines with
  `requires_openai_auth = false`, its credentials named only by the variables they are in
  (`env_key`, `env_http_headers`). The gated home keeps that one provider and holds no login
  file.
  A machine with a ChatGPT login keeps the ChatGPT gated home, whatever its configuration names.
- A machine with an older `gram-host` opens no Codex session: "Its gram-host is older than this
  Gram and doesn't run Codex sessions. Update Gram there (Settings → Machines), then try again."
- Not yet: switching a thread between Claude Code and Codex on a joined machine, and Codex memory
  updates there.

## OpenCode on a machine

A joined machine whose `gram-host` is this release or newer runs OpenCode sessions too, on that
machine's own `opencode` (`opencode serve`, one per host) and its own OpenCode config. A thread or
worker on OpenCode placed there opens there; this Gram never starts OpenCode for it.

- **What it runs on.** The providers and keys are the ones that machine's OpenCode config names;
  Gram writes none and reads none. An embedder that routes OpenCode through its own gateway writes
  that config on the machine before its host starts.
- **Its models.** The host reports whether `opencode` is on its login shell's PATH, its version, and
  the `provider/model` ids it lists. A headless Gram lists the OpenCode models of the machine a new
  thread would go on, and an orchestrator's OpenCode worker is refused on a machine whose OpenCode
  isn't installed or doesn't list the model.
- **Gateway profiles stay here.** A session through a gateway profile never opens on a machine,
  as for Codex.
- A machine with an older `gram-host` opens no OpenCode session: "Its gram-host is older than this
  Gram and doesn't run OpenCode sessions. Update Gram there (Settings → Machines), then try again."

## When it drops or restarts

A dropped connection that comes back within 2 minutes changes nothing: the host keeps its sessions
and terminals for 3 minutes without one, and each session picks up where it was.

When `gram-host` itself restarts (an update, a reboot, a crash or a service restart), its sessions
and shells end with it. Once the machine dials in again and no longer has a session a thread was
following, Gram resumes that thread's Claude conversation on the same machine, by its session id
and in the same worktree there:

- A turn the restart cut short carries on with a short note telling the agent the machine
  restarted. The transcript shows a quiet line, such as `cachyos restarted · continued the turn`.
  A tool call the restart cut off, such as a shell command still running, ends as interrupted by
  the restart, its result unknown; it isn't run again by itself.
- A thread with messages waiting in its queue sends them, and shows `resumed the session`.
- An idle thread just rests, and opens again on your next message.

Gram doesn't carry on by itself when the turn was waiting on you (an approval, a question or a
plan), when you had stopped it, or after it already did so 3 times for that thread in the last
hour. The turn then fails, saying the machine restarted and why it wasn't continued. A machine that
doesn't dial in again within 2 minutes ends its sessions with a message that names it. Nothing ever
falls back to running on this machine.

A thread's terminals come back without what ran in them: the shell and the program it ran ended
with the host. The host keeps each open terminal's tail in its folder (`kept-terminals`), and when
it starts again each one reopens under the same tab and folder, with its last screen above the
line `the program above ended; this is a new shell` and a fresh shell below. The command is never
run again. One whose thread closed, or moved off the machine, meanwhile is closed when the machine
dials in. See [terminals after a restart](AGENTS_AND_FEATURES.md#terminals-after-a-restart).

## Stop a machine and keep its disk

Part of the hosted features (Settings → About → Diagnostics → Hosted features, off by default).
With the setting off none of this is there: the routes below answer not found, and a thread on a
machine that is away fails as it always did.

Whoever runs the machines can stop one while nothing works on it and start another host on the
same disk later. Gram stops and starts nothing itself; it readies the machine, says when it is
wanted, and carries the threads on. The calls are local `POST`s with a JSON body, answered only to
the local app, as the other `/machines/*` routes are.

- `POST /machines/stop/prepare` with `{ "id": "<machine>" }` asks the machine whether it can stop.
  While sessions, terminals, clones or checks run there it answers `idle: false` with what is
  running and changes nothing. Otherwise the host takes nothing new, keeps each thread's
  uncommitted work as a commit on a hidden ref per folder, `refs/gram/wip/<thread>--<folder>`
  (`<folder>` is 16 hex characters of a hash of the folder's path; the working tree and the
  branch are left as they are), pushes those refs, and answers `idle: true` with what it kept.
  Gram then puts the idle sessions there to rest. The host holds new work off for ten minutes,
  which is the time to stop it in; left running past that, it takes work again and no longer
  counts as stopped. One call keeps up to 512 folders, and says so when there are more.
- `"force": true` readies a busy machine too. The turns it cuts off go on by themselves once a
  host is back on the disk, as after a restart (see [When it drops or restarts](#when-it-drops-or-restarts)),
  if the host is back within fifteen minutes of its connection closing and the stop was asked
  for no more than twenty-five minutes before.
- `"remote"` names where the ref is pushed, a git remote's name or an https or ssh URL. The
  default is `origin`. The ref holds every file git doesn't ignore, untracked ones included, and
  whoever can read that remote can read it, so name a private mirror when that matters. A push
  that fails is reported (`pushed: false`) and doesn't stop the answer: the work is still on the
  disk. Each kept folder's answer says the `branch` it was on and, when the call named one, the
  `remote`.
- Every folder of a thread has its own ref, so each is kept: two clones of one remote, or a
  repository's clone and a linked worktree of it, are kept side by side, and neither keep
  replaces the other's. Hosts built before folders had refs of their own kept one ref per thread, `refs/gram/wip/<thread>`,
  and only one folder per repository and per thread under it.
- A push replaces the remote's ref only while it names what this folder last kept or put back
  there (`--force-with-lease`, held to a local `refs/gram/wip-lease/<thread>--<folder>` that is
  never pushed), or, for a folder that never had any, only while the remote has none. So a
  fresh clone, a folder a resume skipped, or one written to before its work came back can't
  replace the only saved copy of work it didn't come from: that keep is answered `pushed: false`
  with "The thread's work saved at the remote didn't come from this folder", the snapshot stays
  in the folder's own ref, and the thread's saved line says the last save failed. A remote that
  has no such ref any more, or one the commit holds, is written as before.
- A machine that is lost (its node gone, its process killed) gets no stop. So, with the hosted
  features on, Gram keeps a thread's work on a joined machine under the same hidden ref while it
  works: five seconds after each of its turns ends, and while a turn runs whenever the last keep
  is five minutes old. A keep asked for at a turn's end still happens when the next turn starts
  first, a keep under way is never cut off, and at most four threads push at once. Nothing is
  held and nothing waits for the turn. Each keep logs one line naming the thread: pushed, caught
  up, skipped and why (hosted features off, parked, readied to stop, a host that can't keep, no
  folder made from a clone), or not kept and why. A host started on another disk then gets the
  folder back from that ref when it is resumed, as after a stop, and loses at most the last few
  minutes. Only folders Gram made from a clone are kept, since only those can be made again. A
  host older than this keeps nothing until it is readied to stop.
- When a lost machine doesn't come back within the session's reattach window, or comes back on
  another disk without the session, the turn it cut off fails saying so
  (`ThreadError.machineLost`: the machine, and the command that was running), not as a plain
  session end. The conversation shows that turn's card with Resume worker
  (`thread.resumeAfterMachineLost`): the same conversation gets Gram's note of what was cut off,
  which brings the machine back and its folder as last kept.
- The loss is kept on the thread apart from its last error (`Thread.machineIncident`: when, which
  machine, `away` or `lost`, and the time of the last save before it), so a later failure doesn't
  hide it: a message that waits on the machine and then fails as "offline" keeps the card, and
  every error written while it lasts carries it as `machineLost`, dated from the loss. A thread
  that was idle when its machine took its session gets it too, and so does any failure of a
  thread whose machine is offline then. Only a turn that completes, or Resume worker, clears it.
  A failure logs `machineLost: true` on its "turn failed" line.
- Each keep says what the save holds (`HostStopKept.saved`): the diff of the kept commit against
  where its branch left its base, bodies cut to 512 KB with the largest files listed without
  theirs. Gram records the time and the files on the thread (`Thread.savedWork`), so the
  machine-lost card says "Saved 08:12 · 6 files changed, not committed" with the first files, and
  the task's card and the worker's rows say "machine lost 08:14 · 6 files saved". View diff reads
  the diff back (`thread.savedDiff`) while the machine is away. The record outlives a restart of
  Gram; the diff doesn't, and the card then lists the files alone. A host older than this sends
  no `saved`, and the card says the folder comes back as last saved, as before. A keep that
  fails after a save marks the record (`lastAttemptAt`, `lastFailure`), and the task's card says
  "Last save 08:20 failed: …" until a keep reaches the remote again, so an old save never reads
  as current.
- `POST /machines/stop/cancel` takes a stop back: the host takes new work again.
- **A provisioned host sent SIGTERM** (its node drained, or a reclaimed spot node, before the
  grace period ends) readies itself to stop before it goes. It says so to this Gram
  (`host.stop.going`, from a host that names the `stop-going` feature), which readies it as
  `POST /machines/stop/prepare` with `force` does: each thread's work is kept at the remote and
  remembered here, and the machine is owed a resume when a host dials in as it again. The host
  holds its exit while this Gram does so, for up to 35 seconds, and goes at once when no Gram
  listens. The log says `a machine about to go was readied to stop`, with how many folders were
  kept and missed. Give the host a grace period longer than that (60 seconds leaves room for
  what runs after it). A machine a person joined keeps its disk, and an update's restart is a
  SIGTERM too, so it doesn't do this.
- `POST /machines/stop/status` lists each joined machine: `online`, `stoppedAt` when it was
  readied and hasn't dialled in since, `wanted` when a thread waits on it now, and `resuming`
  when it dialled in after a stop and hasn't been resumed: resume it, however it was started. A message sent
  to a thread on a machine that is away, or readied and not yet stopped, waits up to five minutes
  for it, so start a host (or take the stop back) when `wanted` turns true. With the setting on,
  this wait applies to any joined machine that is away. A thread started
  [before its machine](THREAD_PROFILES.md#before-its-machine) is on no machine yet, so it shows
  in no machine's `wanted`: its message waits in its queue, with no time limit, until a machine
  is named for it.
- `POST /machines/stop/resume` opens again the sessions the stop put to rest, once a host has
  dialled in. It answers four lists:
  - `reopened`: the sessions it opened again.
  - `restored`: the folders it made again.
  - `missing`: the folders still not on the disk, with why when the machine was asked.
  - `refused`: the folders the machine was asked to put back and didn't. It refused or failed,
    didn't answer, or couldn't say whether the folder is there.

  Threads that had no session open at the stop open with their next message, as ever.

- A machine that dialled in after a stop takes no new session until its resume ends: a host on
  another disk has its folders only once the resume has made them again. No timer opens it. When
  25 minutes pass with no resume started and no folder done, the sessions waiting on it fail with
  that reason and the log says so, and a session asked for after that fails at once the same
  way. None opens until a resume of the machine completes: one that can't reach the machine,
  loses its connection, fails or is cut off leaves it owed (`resuming` in the status), and so
  does taking its stop back. Time this Gram was down doesn't count towards the 25 minutes.
- A thread's session opens as soon as its own folders are confirmed back: every one of them put
  back or found there by this resume, or one before it on the same disk. A thread with one folder
  still coming back doesn't open. The folders of threads a session waits for go first.
- A resume that loses its connection, or whose machine comes back on another disk meanwhile,
  stops where it is and leaves the machine owed. That covers reopening the threads at rest: each
  leaves the list only once its session is seen open (within two minutes of its start) on the
  machine as it is, and the rest wait for the next resume. One whose end can't be written answers
  as failed, and the machine is still owed.
- A folder the host can make again is written as owed before anything is put back there; a write
  that fails puts nothing back. The next resume asks the host for an owed folder again, there or
  not, with `pending`: a host that names `wip-restore-pending` makes an empty one again, puts the
  kept work into a worktree of the clone left at its base, and refuses anything else. A host
  without it isn't taken at its word that such a folder is there: the thread stays out, saying
  so, until the host is updated or the folder removed.
- On a disk the folders weren't last seen on (replaced, or unknown), a folder Gram made from a
  clone that is there is checked by the host against what was kept, like one a resume left owed:
  being there isn't being back. A resume asks again only the folders still owed, never a thread's
  intact folder for a sibling that couldn't come back. A folder already holding exactly the kept
  work (a restore whose answer was lost) counts as put back. One a resume before confirmed is
  not checked against what was kept again (it may hold new work by then), but it must still be a
  checkout Git reads: one that isn't any more (an empty folder left at its path, say) is asked of
  the host again, as an owed one is. Git is asked a few times; one that can't answer leaves the
  folder's threads out for this resume, saying so, with nothing owed for it, and the next resume
  asks again.
- A folder the host can't make again (one the user picked) is back when it is there and Git can
  read it, a repository or a plain folder, and the resume's answer lists it in `unverified`:
  nothing was kept to check it by. On a disk its folders weren't last seen on, an empty plain
  folder isn't back: put its files back there. One put back by hand opens its thread at the next
  resume.
- A thread at rest whose session didn't open stays on the list and is tried again, after a
  minute, then twice as long each time up to half an hour. With the hosted features off,
  this Gram resumes a machine with folders that couldn't be put back every ten minutes, so one put
  back is found without asking.
- A thread with a folder that is missing or refused doesn't open on the machine, during the resume
  or after it. Its session fails at once with the reason, and the thread shows it. A stop and the
  periodic keep leave that folder alone, so whatever is at its path never replaces the kept work
  at the remote. The next resume asks the host about it again, even if the path is there now.
- Resume asks the machine whether each folder is there once, before any is put back. A folder made
  from a clone is always the host's to decide: it puts it back or says it is there already. So a
  clone that another folder's restore made first doesn't count as restored, and a folder the machine
  can't read doesn't count as there.
- Folders are made again a few at a time, and threads that share a folder take it in turn. Once one
  of them has it back, it is back for all of them.
- `"remote"` names where the hidden refs are fetched from; left out, it is where the stop pushed
  them. `"kept"` gives the stop's `kept` back, as it was answered: see
  [what a resume is held to](#what-a-resume-is-held-to). `"fromBranch"` lists threads to make from
  their branch when the work their stop kept is gone from the remote: see
  [when the kept work is gone](#when-the-kept-work-is-gone).
- A message that waits in a thread's queue during the resume is sent once, when the thread's
  folders are back or the resume ends.
- A resume and a prepare can each be started as a job, which a caller polls rather than holding
  one call open for minutes: `POST /machines/stop/resume/start` and `/machines/stop/prepare/start`
  take the same body plus a `key`, and answer `202 { job, joined }` at once.
  `POST /machines/jobs/get` with `{ "job", "seen"?, "waitMs"? }` answers the job as it stands,
  waiting up to `waitMs` (25 seconds at most) for a change past `seen`. A job says its `state`
  (`queued`, `running`, `done`, `failed`), each folder's outcome, its `budgetMs` and, once ended,
  the answer or error the synchronous route gives. A machine runs one job at a time, and a start
  while one of its kind runs, or naming the key of one kept, joins it. So does the synchronous
  route, which stays. After a restart of Gram a poll answers `404`: start again. See
  [long steps as jobs](design/long-steps-as-jobs.md) for the contract and the budget each
  caller's deadline must exceed.
- `POST /machines/stop/expect` says a machine is being started on another disk: `{ "id" }`. Once
  it dials in, it waits for its resume as above, though this Gram saw no stop of it (the machine
  was stopped some other way, or its host doesn't say its disk). Call it before the host starts;
  it holds for fifteen minutes. Meanwhile a host that says the disk the machine is leaving is
  refused: it is the old one dialling in again. It gets in once the fifteen minutes are up, when it
  is let back in (`POST /machines/readmit`, below), or when it says a new disk
  (`gram-host new-disk`).
  An `expect` said again after the new disk dialled in is about that disk: call it once, before
  the host starts.
- What this Gram knows of each machine's stops and restores is one record per machine, kept
  across its own restart in `remote-access/machine-marks.json` in its data folder, owner-only and
  replaced whole on each change: the disk and start its host last said, the disks it was
  replaced from, whether it was readied and left, the threads at rest, an `expect`, what each stop
  kept (without the diff), and the resume it owes (its generation, the threads confirmed back,
  those that couldn't be put back, and the folders a resume didn't finish with). So a machine owed
  a resume when Gram restarts is still owed it after, and its sessions still wait.
  - What lifts a debt (a thread confirmed back, a resume completed, a thread at rest reopened, a
    stop taken back) is written before it is taken as so. When the write fails, nothing changes
    and the thread stays owed.
  - A host dialling in is written the same way, its disk and any debt it owes in one write. When
    that write fails, the host is refused ("refused a joined machine's host, as its record
    couldn't be kept") and dials again.
  - What only adds caution (a stop, a lost connection, an `expect`) holds at once, and a write
    that fails is logged as an error and made again at the next change.
  - A file that can't be read is copied aside (`machine-marks.json.unreadable-<time>`) and
    written over at once with every joined machine owed a resume, so a restart before anything
    else is written finds them owed still; so is a machine whose own record can't be read. It
    never stops Gram starting.
  - `POST /machines/stop/expect` answers 503 when its word can't be written.
  - Removing a machine removes its record only once its removal is written. A record left of a
    machine that isn't joined is dropped at the next start.
  - What stops kept is held to the newest 256 folders a machine; a write that would pass 4 MB
    leaves out what stops kept, the threads to reopen and those already back (which then wait
    for the resume) before anything else.
- A branch whose tip is already on the remote's branch of the same name, with nothing
  uncommitted, needs no hidden ref: the stop answers `caughtUp: true` for that folder with no
  `ref`. A ref this folder left at an earlier stop is deleted then. One that names anything
  else is left, and the answer's `note` says so: another machine may have written it since, and
  only that ref holds its work. The ref is deleted only while it still names the commit it was
  looked up at.
- Closing a thread deletes nothing at the remote: a closed thread can be reopened, and what a
  stop kept of it is still there for it. A thread's ref therefore stays until a later stop of
  the thread finds its branch caught up. Whoever runs the remote can delete the refs under
  `refs/gram/wip/` of threads that are gone for good.

The new host must start with the stopped one's home folder (`GRAM_HOST_HOME`). The machine's key
is in that home, so the new host dials in as the same machine and nothing about the threads
changes. With the threads' folders at the same paths, they are found as they were.

### Same disk or a new one

A joined machine's host keeps a random id of its disk in its home folder (`disk-id`, beside the
key, never in `repos/`), made the first time it starts there, and says it in its hello with a
fresh id for each start of its process (`HostHello.diskId`, `bootId`). Gram remembers the last
disk of each machine and reads a dial against it:

- **The same disk and start**: only the connection dropped, and sessions pick up where they were.
- **The same disk, another start**: the host restarted. A session it no longer has ended with
  it, and the conversation carries on there, as before.
- **Another disk**: a new machine under the same key. It is owed a resume before any session
  opens there, whatever Gram remembers of a stop, and a session the old disk had ends as lost,
  not restarted. Each open is checked again against the connection it goes out on, so a session
  let through just before the machine came back on another disk doesn't open there either. A
  resume counts only for the disk it began on: one the machine left meanwhile, or whose
  connection went, ends without completing. With the hosted features off, nobody else resumes
  the machine, so this Gram does as soon as it is online, and sessions wait for it.
- **A work volume of its own** (`GRAM_HOST_REPOS` outside the home folder, or on another device):
  its id is part of the disk's, kept in the volume (`.gram-volume`), so a volume swapped or wiped
  under a home that stayed is another disk, owing a resume. One whose id can't be kept is said to
  be unknown (`HostHello.diskUnknown`), and owes a resume at each start, the first one too.
- **A disk it was replaced from**: an old host that was only cut off and dialled in again. It
  holds the machine's key but isn't the machine any more, so it is refused before it comes
  online, whatever is online, and the log says so ("refused a joined machine's host on a disk it
  was replaced from"); the machine that replaced it stays, and its resume goes on. Gram closes the
  dial with code 4409, whose reason is in the host's own log of it ("not connected; dialling
  again"). Gram remembers the last 64 disks a machine was replaced from.
- **Taking an old disk back**, as when the disk that replaced it is lost and the old one holds the
  only folders left: run `gram-host new-disk` on it. Its host makes a new disk id and restarts
  its service (restart a `gram-host run` yourself), and dials in on a disk Gram hasn't seen. It
  keeps its key, so it is the same machine with the same threads: it is owed a resume, which checks
  its folders against what was kept before any session opens, and the disk it took over from is
  the one refused from then on, with the same way back. The service is restarted as it was
  installed, so its folders and settings stay as they were.
- **Letting it back in from this side**, for a host nobody can run a command on (one an embedding
  app started, say): `POST /machines/readmit` with `{ "id" }`, from the local app as the other
  `/machines/*` routes are, or from an embedding app for a machine it provisioned. It lets the disk
  this Gram last refused a host of the machine on back in, at that host's next dial within fifteen
  minutes, once, and answers that disk; 409 when no host of it was refused since Gram started (it
  dials again within half a minute). A disk the machine was replaced from comes in as the machine
  replaced again, with the same id and threads, owing a resume that checks its folders before any
  session opens; the disk it is leaving under an `expect` comes in as it is, and the `expect` is
  taken back.
- Removing the machine and joining it again also lets the disk in, but as a new machine: the
  threads placed on the old one stay on it.
- **No disk said** (a host of 1.31.0 or earlier, or one that couldn't keep the file): as before,
  for a machine none of whose hosts ever said one. Once one has, a host that says none is refused
  ("refused a joined machine's host that didn't say its disk"): it can't say it isn't an old
  disk's host. Removing the machine and joining it again starts it over.

A host counts a dial as got through, for its three-minute grace, only once Gram has said more
than the hello it asks of every dial, so a host Gram keeps refusing ends its sessions when the
grace runs out: an old disk's host among them.

So whatever brings a machine back on another disk must not copy `disk-id` with the rest of the
home folder: the key and `host.json` are what make it the same machine, and the id is what makes
it another disk. A copied id reads as the old disk restarted, whose folders are taken to be
there. The id only tells an honest host's disks apart: anything holding the machine's key can
say any id, as it could dial in as the machine before.

**On a replaced disk** (the same machine key, the folders gone) a thread's work in progress
follows it. For each missing folder that Gram made from the machine's clone of a repository (a
worker's worktree, or the clone itself), resume asks the host to clone the repository again,
fetch that folder's own ref, and make the folder again at the same path: the branch at the tip
it was on, unpushed commits included, and the files that weren't committed written back as
uncommitted files (what was staged comes back unstaged; ignored files were never kept). A thread
no ref was kept of, because its branch at the remote held everything (`caughtUp`), gets its
folder from that branch at the remote, as long as that branch still holds what the stop found
there ([when the kept work is gone](#when-the-kept-work-is-gone)). The answer's `restored` says
which with `source`: `ref` or `branch`. Each folder is put back from its own ref and held to its
own record, and the thread's session opens as after any resume once every one of its folders is
back. A folder kept by an older host, under the thread's one ref, is put back from that ref only
when the stop's `commit` for this folder is known and the ref names it: unheld, it may be another
folder's work.

- It needs a host that names the `wip-restore` feature, and the host's own git credentials for
  the clone and the fetch. With an older host the folder is reported missing, as before.
- A folder that is there is never written over. Only a folder Gram made from a clone is made
  again: one the user picked on the machine, or a profile's folder, is reported missing.
- A folder nothing was kept of (no ref at the remote and no branch of its name there) stays
  missing, and says so.
- The machine's folder gate is asked about the folder before anything is written in it, and a
  folder it refuses is not made.
- A branch that is on the disk already is only ever moved forward. This matters when the disk
  was kept and only the thread's folder is gone: a branch there with commits made after the stop
  is never moved back to the ref. When the ref held nothing uncommitted, the folder is made on
  the branch as it is on the disk, and the `note` says so. When it held uncommitted files, or
  the branch went another way, nothing is put back and the folder is reported missing with why:
  the branch on the disk and the ref at the remote both stay as they are.
- A thread whose branch is the one the machine's clone is on (a fresh clone is on the default
  branch) gets it: the clone's own checkout is left where it is with its HEAD detached, when it
  has no changes of its own.
- The ref is what the last stop wrote. Work done after a resume and lost without another stop is
  not in it; when the remote's branch has commits made after it, the answer's `note` says so.
- The agent's own conversation file was on the old disk; this puts back the files, not that.

### What a resume is held to

Whoever can push to the remote can write the refs under `refs/gram/wip/`. So a resume holds the machine
to what the stop said it kept: the ref must name exactly the stop's `commit` for that folder, or
nothing is put back and the folder is reported missing with why. A folder the stop answered
`caughtUp` for is made from its branch, whatever the ref names.

A stop on SIGTERM is remembered as any stop is, so a resume after it is held to what it kept.
Gram remembers each stop's answer while it runs. After Gram itself restarted it remembers none,
so give the stop's `kept` array back in the resume call (`"kept": [...]`, entries as they were
answered; up to 512). With neither, the ref is taken as the remote has it, and a thread with no
ref gets its branch.

### When the kept work is gone

A folder whose stop kept a commit, when the remote no longer has its ref (deleted by whoever runs
the remote, say), is made from its branch only if that branch holds the commit: work committed and
pushed since is all there. So is a caught-up folder whose branch moved on; one whose branch was
pushed over is made from the thread's ref when that names exactly the commit the stop found. A
branch that doesn't hold it (the ref gone and the work uncommitted, or the branch pushed over
since) would be the folder without that work, so nothing is put back: the thread doesn't open on
the machine, and its reason says so and names the two ways out.

- **Put the work back at the remote**: push `refs/gram/wip/<thread>` at the kept commit from
  wherever it still is (another clone, or the old disk). The next resume puts it back as usual;
  with the hosted features off this Gram resumes such a machine every ten minutes by itself.
- **Take the branch without it**: in the thread, whose card says "Saved work is gone" once a
  message to it is held off for this, **Open from the branch…** asks first, saying the saved work
  isn't put back later, and then resumes its machine for that thread alone
  (`thread.restoreFromBranch`). Or resume the machine with the thread in `"fromBranch"`
  (`POST /machines/stop/resume`, `{ "id", "fromBranch": ["<thread>"] }`). The folder is made from
  the branch as it is at the remote, `restored` lists it with `source: "branch"`, and its `note`
  says it is without the work its stop kept. Only the threads named take it: a folder that threads
  share is made so only when every one of them is named, as it drops what any of them kept, and a
  named thread that shares its folder with one that isn't says so and stays out.

A host that names `wip-restore-kept` checks this itself before it makes anything. One built
before it makes the folder from the branch whatever it holds; Gram then takes a folder it made
at any other commit than the stop kept, caught up or not, as not put back unless the thread is in
`"fromBranch"`, and the next resume asks again.

### What the remote must allow

The machine's git credentials, and any push policy in front of the remote, need these and
nothing more for a stop and a resume:

- Read: listing and fetching `refs/gram/wip/<thread>--<folder>` (and `refs/gram/wip/<thread>`,
  which older hosts kept) and `refs/heads/<branch>`, and the clone and fetch of the
  repository itself.
- Write `refs/gram/wip/<thread>--<folder>`: create it, and replace it with a commit that isn't a
  descendant of the one it named (a forced update).
- Delete `refs/gram/wip/<thread>--<folder>`, and `refs/gram/wip/<thread>` when the thread is
  dropped.
- A host with a namespace (`GRAM_HOST_WIP_NAMESPACE`) puts each of these one level down, under
  `refs/gram/wip/<namespace>/`.

No branch and no tag is ever written by a stop or a resume.

## A Claude token from this machine

Instead of `claude /login` on each joined machine, Settings → Machines → **Use a token from this
Mac** runs `claude setup-token` here and sends the token it prints to the machines you tick. It is
on the row of a machine that isn't signed in, and in the **⋯** menu of one that is.

- **Your consent, each time.** The dialog says what happens before anything runs. Only the machine
  you started from is ticked, and only confirmed machines that are online can be picked. A token
  is never queued for a machine that is offline.
- **Never shown or kept here.** Gram reads the token from the command's output on this machine and
  sends it over each machine's own connection to this Gram. The page never sees the output. Gram
  doesn't save, log or show the token.
- **Owner-only there.** Each machine keeps the token in `claude-oauth-token` in its host's folder
  (mode `0600`), and sets `CLAUDE_CODE_OAUTH_TOKEN` only for the Claude sessions `gram-host`
  starts. It never goes in a shell profile or the service's unit or plist. While it is there, it
  takes the place of that machine's own `claude /login`.
- **Removing it.** **Forget token** and **Remove** (both in the machine's **⋯** menu) and
  `gram-host leave` each delete it from the
  machine. A machine that is offline when you remove it keeps the token until you run
  `gram-host leave` there.
- **Revoking it.** The token lasts a year and only makes model requests: no claude.ai connectors
  or Remote Control there. Deleting it doesn't revoke it. Revoke it at claude.ai → Settings →
  Claude Code.

Gram runs the `claude` your login shell finds, as a terminal would, but starts it directly
and without debugger, preload or request-logging settings. The
[design note](design/machine-setup-token.md) covers the threat model.

## Its repositories

A worker placed on another machine works in a worktree of that machine's own clone of the
project's repository, never in a folder on this one. The host finds the repository by the
project's `origin` remote here and clones it the first time, then fetches it each time a worker
starts there. Clones go in `repos` in the host's folder, by host, owner and name
(`repos/github.com/acme/widgets+<identity suffix>`), or in `GRAM_HOST_REPOS` when it is set before `gram-host join`
or `gram-host service install`.

- Only `https://` and `ssh` remotes are cloned, never `file`, `ext` or `git://`, and never a URL
  with a password or token in it. The clone uses that machine's own git credentials (its SSH keys
  or credential helper), so the repository has to be reachable from there.
- Different transports, ports, SSH accounts or remote paths get separate clone folders. An
  existing folder without an identity suffix is reused only when its stored origin matches
  exactly; other origins are left alone.
- An explicit base is resolved on the joined machine. Push a branch that exists only on the main
  machine before naming it as a remote worker's base. A local branch behind its origin uses the
  updated origin; a local branch with additional or divergent work keeps that local tip.
- A clone that fails or is stopped leaves nothing behind. A folder that is already there but isn't
  a clone of that remote is left alone, and the worker isn't started.
- A joined machine's terminals open with its own default shell on its own PATH. Its shells outlast
  a dropped connection or a restart of the main Gram while the host waits for it; once it connects
  again, each shell whose thread is still open on that machine is taken up again, so typing and
  closing reach it, and each one whose thread was closed meanwhile is closed.
- Bulk worktree removal asks that machine whether a command runs in the worker's terminals, and
  leaves the worker open while one does or while the machine can't be asked. A worker there shows
  no port chips, rather than chips from this machine's processes.
- Where the server runs the agent browser itself ([without the desktop app](AGENTS_AND_FEATURES.md#the-agent-browser-without-the-desktop-app)),
  a thread on a joined machine browses that machine's loopback, so its tools reach the dev server
  it started there. This needs a host that names `loopback-tunnels`. The desktop app's Preview
  pane still reaches only this computer's loopback.
- A conversation forks only onto the machine it ran on, since its history is kept there: a fork of
  a joined machine's thread goes into a worktree on that machine, and a fork of one of this
  machine's threads stays here.
- While the machine is offline its workers don't start and their folders aren't marked missing;
  nothing falls back to running on this machine.
- A checkout is its machine and its path together. Two joined machines with the same user and
  folders, or this machine, can hold the same path; each worker's git state is read on its own
  machine. A request that names only such a path, and no thread, is refused rather than sent to a
  guess.
- The Changes panel's diff, push, creating a PR, applying a review suggestion, fast-forwarding to
  upstream and undoing a turn run git on this machine, so a worker on another machine refuses them
  and says so; ask its agent, or use its terminal. PR reads and actions that name the repository
  (checks, reviews, merge, labels) work, with the PR bound to the thread. Until one is bound,
  `pr_status`, `merge_when_ready` and `pr_review_monitor` find the open PR of the worker's branch
  on GitHub, in the repository its worktree cloned (a workspace project's origin here, matched as
  for ownership below), so a PR just opened there is found at once.
- Under full auto, a worker there merges its own pull request without a card, as one here does,
  and Gram's local check of it runs without one. Ownership goes by what this Gram recorded when it
  made the worktree there: the machine, the identity of the origin it cloned (which must be a
  workspace project's origin here, the PR's repository) and the branch it gave the worker. That
  machine's host only confirms the record: that the worktree still shares the clone's repository,
  has that origin and has that branch checked out. A branch the worker switched to there, a
  re-pointed origin, an offline machine, a `gram-host` older than this Gram, and a worker started
  before Gram kept the record all still ask.
- A message sent while the connection is down waits for the machine for up to two minutes, as its
  session does, and is handed to the agent once it dials in again; if the connection dropped before
  Gram heard back, Gram asks again under the same id and the host takes it only once. A machine
  that doesn't come back in time leaves the message at the top of the thread's queue, and the
  thread says it wasn't delivered.

## Its files and attachments

A thread on another machine has its files there, and Gram reads them there: nothing about its
folders is looked up on this machine, even where the same path happens to exist here.

- **Files panel and previews.** Listing, search, `@` mentions, file previews, images, Markdown
  previews, the transcript's file links and dictation's project words go to the machine's host.
  The host scopes each path to the thread's folders itself, so a path that leads out of them,
  through `..` or a link, is refused there, and a file that may hold credentials is never
  previewed. A path outside the folders is read only when the thread's own messages name it, as on
  this machine; the transcript that decides it stays here.
- **Not yet:** an HTML preview (its page loads the files beside it from this machine) and opening a
  file in your editor or file manager, which start on this machine. Gram says so, naming the
  machine, rather than opening a file here.
- **`send_file`.** A file an agent there sends is read on its machine (a regular file of at most
  20 MB, never one that may hold credentials) and copied into the thread's attachments on this
  machine, which the card shows and deletes with the thread.
- **Attachments.** A file you attach to a message for a worker there is copied to that machine
  before the message goes, into `attachments` in the host's folder, one folder per thread, and the
  agent reads that copy. A file that can't be copied (the machine went offline, the file is gone,
  it is over 20 MB or may hold credentials) is left out, and the message tells the agent what
  didn't arrive. A thread's folder there goes when the thread is removed while the machine is
  connected, and otherwise once nothing has been added to it for a week.
- A machine whose `gram-host` is from an older Gram still runs its workers, but its files and
  attachments are refused with a note to update it ([Updating a machine](#updating-a-machine)).

## Its local checks

A solo workspace's [local check](AGENTS_AND_FEATURES.md#project-local-merge-checks) of a worker's
pull request runs on the machine the worker is on, through its host: `local_check`, `pr_status`
and `merge_when_ready` read and gate on it as they do on a check of this machine.

- The host merges the exact head onto the exact base in a bare repository of its own, in `checks`
  in the host's folder, fed only by fetch from that machine's clone, and runs the project's
  approved command and setup in a fresh worktree of the merged commit with its service's PATH. The
  main Gram keeps the record: head, base, merged tree, pass or failure, and the output's end in its
  log.
- One check runs at a time on each joined machine, in a slot of its own, so it never waits behind
  this machine's queue, nor this machine's behind it. `workspaces.localCheckConcurrency` is this
  machine's alone.
- A connection that drops while a check runs doesn't end it: the host keeps running it, and Gram
  waits up to two minutes for the machine to dial in again and asks for the same run. A machine
  that doesn't come back in time, or a Gram that quits meanwhile, leaves the check failed as
  unknown, never passed; `local_check` runs it again. A machine that is offline when the check is
  due waits the same two minutes before it fails.
- A machine whose `gram-host` is older than its main Gram runs no checks: its threads read **no
  local check on <machine>** and the local gate is off, as for a project without a command. Update it
  ([Updating a machine](#updating-a-machine)). A selected-source check doesn't run on a joined machine
  yet.
- A provisioned machine (one a hosted server or control plane started) runs no checks: it is sized
  for an agent's work, not the project's whole check beside it. Its threads read **no local check on
  <machine>**, `local_check` refuses, and a solo merge of their pull request needs the CI its base
  branch declares in `.gram/merge-ci.json`, every declared job passing on the exact head. GitHub's
  check contexts don't stand in for it, nor does a pass recorded before; a base that declares none
  refuses the merge, and a worker on one of the person's own machines can take the PR over.

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
- **Removing a machine** (Settings → Machines → ⋯ → Remove) forgets its key and closes its connection at
  once, including one still connecting. Turning access over Tailscale off, or onto another
  address, closes every joined machine's connection, including a dial let in just before and still
  connecting; the machines stay joined and dial in again once it is back. Up to 16 machines can be
  joined.
- **Leaving** (`gram-host leave`) forgets the join only once `launchctl` or `systemctl` stopped the
  background service or says it isn't loaded or running. When it can't stop it or say, the join
  and key stay, and it says the host may still be running, even when the service's file is gone.
  `gram-host leave --no-service`, for a machine that joined with `--no-service`, forgets them
  without asking.

The listing (`POST /machines/list`), join link, confirm, remove, update and sign-in check
endpoints answer only the local app, never a paired phone or a joined machine, with the same Origin
rules as phone access settings. What a thread's mark needs of a confirmed machine (its name, how it
got in, whether it is dialled in and why not) goes to every client on the event stream instead
([where a thread runs](#where-a-thread-runs)); no key, fingerprint, address or sign-in goes with it.
