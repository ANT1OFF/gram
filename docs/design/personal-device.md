# Lending this machine to a hosted workspace

[Up: other machines](../MACHINES.md) · [Mock](mocks/hosted-device/brief.md)

Status: design approved on 11 November 2026 with the defaults in
[section 10](#10-open-decisions), after an independent security review
([what it changed](#11-what-the-security-review-changed)). Nothing here is built yet. It sits
behind the one hosted-features setting (`experimental.embedding`), and with that off none of it
exists.

A Gram control plane can run headless on a server, with every session placed on hosts that join
it. A workspace run that way needs nobody's computer to be on. This note covers the way back:
while a person works in the desktop app, a thread in a hosted workspace can ask to run a command
or read a file on **that person's own machine**. The app calls this **lending this Mac** (or this
computer); the record on the control plane is a **personal device**.

The direction of trust is the reverse of [a joined machine](../MACHINES.md). A joined machine
belongs to the person who owns the main Gram, and its host does what the main Gram asks. A
personal device belongs to one person and is reached from a server that person doesn't run,
shared with people they may not know, on behalf of a model that reads untrusted text. So the rule
for everything below is:

> **The machine decides.** Nothing the server sends is an instruction to the device. It is a
> request, shown to the person, who allows it or doesn't. Every limit that protects the person is
> enforced by the app's main process on their machine, from facts that process holds itself.
> Every limit that protects the organisation is enforced by the server. Neither side relies on
> the other's check.

## Contents

1. [What it is, and what it isn't](#1-what-it-is-and-what-it-isnt)
2. [Parties and what each is trusted for](#2-parties-and-what-each-is-trusted-for)
3. [The flow](#3-the-flow)
4. [The protocol](#4-the-protocol)
5. [What the device enforces](#5-what-the-device-enforces)
6. [What the control plane enforces](#6-what-the-control-plane-enforces)
7. [Threat model](#7-threat-model)
8. [What this does not protect against](#8-what-this-does-not-protect-against)
9. [Build order and the acceptance test](#9-build-order-and-the-acceptance-test)
10. [Open decisions](#10-open-decisions)
11. [What the security review changed](#11-what-the-security-review-changed)

## 1. What it is, and what it isn't

|                                |                                                                                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Bound to one person**        | A device belongs to the person signed in on it. Only a turn that person started from this app, by their own message, may ask it for anything, and the device checks that itself.                                   |
| **Present only while you are** | It exists while the app is open, the person is signed in, lending is on for that workspace, the screen is unlocked and the person wrote to the thread in the last few minutes. No background service is installed. |
| **Asks before every request**  | Every command and every file read is shown on the machine and happens only after the person allows it there. This version has no rule that skips the ask.                                                          |
| **Limited to chosen folders**  | Commands start in, and files are read from, only the folders the person picked for that workspace, with a guard on credential folders and files.                                                                   |
| **Dials out**                  | The app opens one HTTPS WebSocket to the hosted server with the person's sign-in. The machine listens on nothing. No Tailscale.                                                                                    |
| **Governed**                   | Every request passes the control plane's decision hook before it is sent and is written to its event sink. An organisation can turn devices off or allow reading only.                                             |

It is **not** a joined machine, and deliberately so:

- No worker, orchestrator or agent session is ever placed on it. In this version it runs single
  commands and reads files; see [open decisions](#10-open-decisions) for whole sessions.
- Nothing unattended may use it: no routine, wake, trigger, webhook or message from another
  thread.
- The server can't install, update, configure or sign in anything on it. None of the joined
  machine calls for updates, Claude tokens, terminals, repositories or worktrees exist on this
  connection.

## 2. Parties and what each is trusted for

| Party                                    | What it is                                                                                                                            | Trusted for                                                                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **The person**                           | Signed in to the hosted server in their desktop app                                                                                   | Deciding what runs on their machine.                                                                                                  |
| **The app's main process**               | Gram on the person's machine: holds the sign-in, the device key and the lending settings, draws every decision, runs what was allowed | Everything that protects the person. It is the only trusted code on the person's side.                                                |
| **The app's local window**               | Gram's bundled UI for the workspaces on this machine, with the local server's cookie and the full desktop bridge                      | Not trusted to approve anything or to change what is lent. It never renders a hosted workspace.                                       |
| **The hosted view**                      | Gram's bundled UI again, in web contents of its own, showing a hosted workspace's data                                                | Display only. It renders text the server supplied, so it gets no local server, no sign-in token and a bridge of a few harmless calls. |
| **The hosted server's front**            | Whatever terminates TLS and signs people in ahead of the control plane (the fronted sign-in seam)                                     | Naming who is signed in, and applying the organisation's device policy. Not trusted by the device for what may run.                   |
| **The control plane**                    | Headless Gram for one workspace                                                                                                       | Binding requests to the person and turn, calling the decision hook, the audit record. Not trusted by the device for what may run.     |
| **The agent session**                    | A model with a shell on a sandbox host, reading repositories, web pages and issues                                                    | Nothing. Its requests, and the reasons it gives for them, are untrusted text.                                                         |
| **Other members**                        | People in the same workspace                                                                                                          | Nothing on someone else's device. They can read the threads they could already read, including a command's output.                    |
| **The decision endpoint and event sink** | The embedding platform's policy and audit                                                                                             | The organisation's rules. They can refuse, never compel: an "allow" from them is not an approval on the device.                       |

The assets, in order: the person's files and credentials on their machine; the person's ability to
tell what they are approving; the organisation's audit record and policy.

### Decisions belong to the main process

A **decision** is anything that widens what the server may ask: answering an ask, turning lending
on, resuming it, adding a folder, passing the whole environment, lifting a pause, accepting a new
server, registering or forgetting the device. Each one is made in a window or native dialog the
main process creates and owns. A renderer, local or hosted, can ask the main process to open such
a window and nothing more: no call from either renderer carries a folder path, a setting or an
answer. A folder's path is taken by the main process from its own folder dialog and never passes
through a renderer on the way in.

The lending settings are kept in one file, authenticated with a key from the keychain. A file
that fails the check is ignored and lending is off, so a command that edits the file can't lend
more than the person did.

## 3. The flow

### Sign in and see hosted workspaces

1. With hosted features on, Settings gains **Hosted**. The person types the server's address
   (`https://gram.example.com`) and chooses **Sign in**.
2. The main process reads `https://<server>/.well-known/gram-hosted` ([below](#discovery)) and
   opens the **system browser** at the server's authorization address: OAuth 2.0 authorization
   code with PKCE and a loopback redirect ([RFC 8252](https://www.rfc-editor.org/rfc/rfc8252)).
   The app never shows a sign-in page itself and never sees a password.
3. The main process keeps the refresh token in the operating system's keychain (Electron
   `safeStorage`) and access tokens in memory. No renderer ever holds a token. Where the platform
   has no real keyring (`safeStorage` falling back to a fixed password on Linux), signing in works
   for the session only and lending is unavailable. The first sign-in to an address asks the
   person to confirm it in a main-owned dialog, with the host shown in its ASCII (punycode) form.
4. The main process lists the person's workspaces and the sidebar shows them beside local ones,
   marked as hosted and with the server's host name. Opening one shows Gram's own bundled UI **in
   web contents of its own**: a separate origin and session partition, no local-server cookie, a
   minimal preload, and a connection to the workspace that the main process makes and
   authenticates on its behalf. **No page or script from the server is ever loaded**: the server
   supplies data, the app supplies the UI. What the hosted view can't do is decided in the main
   process by which web contents is calling, not by the UI's own code
   ([the hosted view](#the-hosted-view)).

### Lend this machine

5. On a hosted workspace's page, **Lend this Mac…** opens the lending sheet, a main-owned window.
   It says what lending allows, what the organisation's admins will see, and takes at least one
   folder through the system folder dialog. Each folder is checked on the spot
   ([folders](#folders)).
6. The first time, the main process makes an Ed25519 key pair for this server and this person,
   keeps the private half in the keychain, and registers the public half: the server sends a
   challenge and the app signs it, so nobody can register a key they don't hold. The server lists
   the person's devices where the person and their organisation's admins can see and revoke them.
7. The app dials `wss://<server>/device/connect` for that workspace with an access token bound to
   the device key and a signature by that key ([the dial](#the-dial)). The front checks the
   sign-in, the device's registration to that person, the person's membership and the
   organisation's policy, then forwards the connection to the workspace's control plane with a
   signed statement of who the person is and which device key this is. The control plane checks
   the dial's signature against the key in that statement and admits the connection as a host of
   kind `device`, owned by that person.
8. While it is lent, the app says so wherever the person is: a **Lending this Mac** mark in the
   sidebar's footer, drawn in the local window from the main process's state, with **Stop
   lending** (stopping needs no confirmation; it only narrows).

### A thread asks for a command

9. The person writes to a thread in the hosted workspace from this app. As the message leaves,
   the main process, which carries the hosted view's connection, mints a **turn grant**: the
   workspace, the thread, a nonce and an expiry ten minutes on, signed by the device key
   ([the turn grant](#the-turn-grant)). It travels with the message.
10. For that turn only, the session gets three tools from the control plane: `device_run`,
    `device_read_file` and `device_list_files`, each naming the device and one of its lent
    folders.
11. The session calls `device_run`. The control plane checks that the turn was started by that
    message and nothing else has entered it ([binding](#the-person-binding)), calls the decision
    hook, writes the request to the event sink, and sends `device.exec` down the device's
    connection with the grant and a deadline.
12. The main process checks the grant, the folder and its own limits, then opens the **ask**: a
    small window of its own, showing the server, the workspace, the thread, the folder and the
    exact command. The thread's view shows "Waiting for you on this Mac".
13. **Run once** runs it; **Don't run** refuses it. The output streams back, bounded, and becomes
    the tool's result in the thread. The control plane writes the answer and the outcome to the
    event sink. The app writes its own line to a local activity log.

### Going away

14. Quitting the app, signing out, switching lending off, locking the screen, switching user,
    five minutes without input or losing the network closes the connection. The control plane
    marks the device offline at once (the connection closed) or within 20 seconds (four missed
    pings, as for a joined machine). A request in flight fails with `DeviceUnavailable` and a
    reason the thread can show: "This Mac went offline: Gram was closed." A command still running
    is asked to stop (`SIGTERM` to its process group), then killed with its whole process group
    five seconds later.
15. Every request carries a deadline (the ask's wait plus the command's timeout). When it passes,
    the control plane answers the tool call itself. Nothing waits on a device without a clock
    running.

## 4. The protocol

### Discovery

`GET https://<server>/.well-known/gram-hosted` answers, without sign-in:

```json
{
  "version": 1,
  "issuer": "https://gram.example.com",
  "name": "Example Co",
  "client_id": "gram-desktop",
  "authorization_endpoint": "https://gram.example.com/oauth/authorize",
  "token_endpoint": "https://gram.example.com/oauth/token",
  "workspaces_endpoint": "https://gram.example.com/api/workspaces",
  "devices_endpoint": "https://gram.example.com/api/devices",
  "device_connect": "wss://gram.example.com/device/connect"
}
```

The fetch follows no redirect. `issuer` must equal the address the person typed, and every other
address must be `https:` or `wss:` on that same origin; the app refuses the document otherwise.
Plain `http:` is accepted only for loopback, for tests. Connections use the system's trust store,
so a TLS-inspecting root the machine trusts sees this traffic like any other; the ask and the turn
grant still stand against it. Gram defines this document and the calls below; whatever fronts the
control plane serves them. Gram's tests carry a small front that does.

Keeping every address on one origin rules out an identity provider elsewhere as the token
endpoint. A front that signs people in with one redirects to it from its own authorization
address, in the browser. If the rule is ever relaxed, the issuer check of
[RFC 9207](https://www.rfc-editor.org/rfc/rfc9207) becomes necessary rather than belt and braces.

### Sign-in, workspaces and devices

| Call                                                                                                   | With                                                    | Answers                                                                |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| Authorization code + PKCE (`S256`), loopback redirect on a random port, `state` checked, `iss` checked | browser                                                 | access tokens (15 minutes at most), a rotating refresh token           |
| `GET workspaces_endpoint`                                                                              | access token, scope `workspaces`                        | `[{ id, name, organisation, role, devices: "off" \| "read" \| "on" }]` |
| `POST devices_endpoint/challenge` then `POST devices_endpoint`                                         | access token, scope `device:register`, signed challenge | `{ deviceId }`; the id is derived from the public key                  |
| `DELETE devices_endpoint/<deviceId>`                                                                   | access token, scope `device:register`                   | forgets the device; the app does this on **Sign out**                  |

Gram's token answer adds one field to OAuth's: `sub`, the person's subject id, which the dial
signs and the gate checks each request's actor against. A renewal that names another person ends
the sign-in. The app signs in once for `workspaces device:register device:connect` and narrows
each renewal to one scope; renewals go one at a time, since each rotates the refresh token, and
the rotated token is in the keychain before it is used. A token is used for fifteen minutes at
most, whatever the server says. The registration's signature covers, length-prefixed,
`"gram-device-register-v1"`, the origin, the subject, the public key and the challenge, and the
id the server answers with must be the one derived from that key.

Access tokens are scoped and never shared between uses: `workspaces` and `workspace:<id>` for the
hosted view's connection, `device:register`, and `device:connect`. The `device:*` tokens are
sender-constrained to the device key ([DPoP, RFC 9449](https://www.rfc-editor.org/rfc/rfc9449)),
so a copied token is useless without the key. A server should ask for a fresh interactive sign-in
before it accepts a registration. `devices` on a workspace is the organisation's policy as the
server will enforce it. The app shows it; it never relies on it.

### The dial

One WebSocket per lent workspace:

```
GET wss://<server>/device/connect?workspace=<id>
Authorization: DPoP <access token, scope device:connect>
x-gram-device-id:        <deviceId>
x-gram-device-time:      <ms since epoch>
x-gram-device-nonce:     <16 random bytes>
x-gram-device-signature: Ed25519(device key, fields below)
```

The signature covers, each field length-prefixed: `"gram-device-v1"`, the origin, the path, the
workspace, the person's subject id, the device id, the SHA-256 of the access token, the time and
the nonce. A captured set of headers therefore works with no other token, person or workspace.

The front refuses a dial whose token is invalid, whose device isn't registered to that person,
whose person isn't a member, or whose organisation has devices off. The control plane refuses one
whose signature doesn't verify against the key in the front's statement, whose time is more than
two minutes off, or whose nonce it has seen; the nonce record is the workspace's own and survives
a restart, as a joined machine's does. This signature protects against a stolen token and a
confused front; it gives nothing against a dishonest front, which names the key. Before the
token expires the control plane asks for a fresh one over the socket (`device.token`), which the
device mints from its own sign-in. **The device closes the socket itself** when it can't, and at
the old token's expiry whether or not it was asked, without waiting for the server to.

### The turn grant

The one fact about "who is working" that the device can know without believing the server is that
its own person just sent a message from its own app. The main process carries the hosted view's
connection, so it sees each message the person sends there, and for each one it signs:

```
grant = { v: 1, origin, workspace, thread, nonce, issuedAt, expiresAt: issuedAt + 10 min }
```

with the device key. The control plane stores it with the message and attaches it to every device
request of the turn that message started. The device refuses a request (`no-grant`) unless it
carries a grant that this device signed, for this origin and workspace, unexpired, for the thread
the request names, and not withdrawn. A grant is renewed only by the person sending again. The
main process withdraws a thread's grants when lending stops, the screen locks or the app quits.

So a server, however compromised, can raise an ask only within ten minutes of the person writing
to that thread from this machine, and only naming that thread. A message sent from a browser or a
phone can't wake this machine's ask at all.

### The device's service

Framing is the host protocol's (Effect RPC, NDJSON over the socket, pings every five seconds).
The service is **its own small group, `DeviceRpcs`, not `HostRpcs` with calls removed**: a call
that isn't in the table doesn't exist on this connection, and a new host call never appears here
by default. The control plane is the client; the app's main process serves.

| Call                | Payload                                                                                                                        | Answers                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `device.hello`      | –                                                                                                                              | `{ protocol: 1, deviceId, platform, capabilities, folders: [{ id, label }] }`                                                     |
| `device.exec`       | `{ requestId, grant, thread: { id, title }, actor: { id, name }, othersWrote?, folderId, cwd?, command, timeoutMs?, reason? }` | stream: `asked`, then `refused { why }` or `started`, `output { stream, text }` …, `exit { code \| signal, truncated, timedOut }` |
| `device.files.list` | `{ requestId, grant, thread, actor, folderId, path, limit }`                                                                   | names, kinds and sizes; or `refused { why }`                                                                                      |
| `device.files.read` | `{ requestId, grant, thread, actor, folderId, path, maxBytes }`                                                                | text or bytes, bounded; or `refused { why }`                                                                                      |
| `device.cancel`     | `{ requestId }`                                                                                                                | withdraws the ask or stops the command                                                                                            |
| `device.token`      | –                                                                                                                              | `{ accessToken }`: a fresh token for this connection, minted by the device                                                        |

Notes that matter:

- **`capabilities`** is `["read"]` or `["read", "exec"]`. The app leaves `exec` out when the
  workspace's policy is read only, and the control plane doesn't offer `device_run` either.
- **`folders`** carry an opaque `id` and a `label` the person chose in the lending sheet (the
  folder's own name by default, never its full path). Nothing else about the disk, the machine's
  name or the app's release is sent before the first allowed request. Requests name a folder by
  id and a path inside it; an absolute path is refused, never interpreted.
- **`command`** is one string of at most 8 KiB, valid UTF-8 and free of NUL
  ([how it runs](#running-a-command)). Requests carry **no environment, no shell choice and no
  flags**: the only things a request can vary are the folder, the path inside it, the command and
  a timeout within the device's own bounds.
- **`thread.title`, `actor` and `reason`** are the server's word. The app shows them, labelled as
  such, and decides nothing by them except to refuse a request whose `actor.id` isn't the
  signed-in person. The thread's id is checked against the grant.
- **`requestId`** makes a request idempotent. A repeat with the same payload joins the ask or the
  run under way, or answers with how it ended; a repeat with a different payload is refused.
- **The approval** is bound to the SHA-256 of what was shown, each field length-prefixed: the
  origin, the workspace, the request id, the folder's real path, the real working folder, the
  command or the file's real path, and the timeout. What runs is exactly those bytes there.
- **`refused.why`** is one of a fixed set (`not-allowed-by-person`, `not-answered`, `no-grant`,
  `away`, `outside-folders`, `credential-path`, `not-a-file`, `too-many-requests`, `paused`,
  `read-only`, `too-large`, `not-for-this-person`, `changed-request`), so a thread can say what
  happened without the device describing its disk.

### What the session sees

The control plane adds three app tools to a session only for a turn that may use a device:

| Tool                                                             | Does                                  |
| ---------------------------------------------------------------- | ------------------------------------- |
| `device_run { device, folder, cwd?, command, reason, timeout? }` | One command, its output and exit code |
| `device_read_file { device, folder, path }`                      | A file's text, bounded                |
| `device_list_files { device, folder, path? }`                    | A folder's entries                    |

Their descriptions tell the agent that the person is asked on their machine for each request,
that a refusal is final for that request, and that the device may go offline at any time. A
refusal or an offline device is an ordinary tool result with the reason, never a hang and never
an error the session retries by itself: the control plane refuses a repeat of a refused request
within the same turn.

## 5. What the device enforces

All of this is in the app's main process, on the person's machine, and holds whatever the server
does.

### Presence

The connection exists only while the app runs, the person is signed in, lending is on for that
workspace and the person is there. "There" fails closed:

- The app closes every device connection on `lock-screen`, `suspend`, a switch to another user
  (`user-did-resign-active`) and five minutes of system idle, on every platform, and polls
  `powerMonitor.getSystemIdleState` for `locked` as a second signal, since lock events don't
  arrive on every platform.
- Where neither a lock event nor an idle reading can be had, lending is unavailable, and the
  lending sheet says why.
- The turn grant bounds what is left: an unlocked machine nobody is at stops being askable ten
  minutes after its person last wrote.
- Lending switches itself off when the app quits. The next launch offers **Resume lending**,
  which opens the lending sheet; nothing is lent until the person confirms it there
  ([open decision 2](#10-open-decisions)).

### The ask

Every command, file read and folder listing gets one.

- **A window of its own.** The ask is a window the main process creates: its own session
  partition and a fixed internal origin that is not the app's, fixed zoom, and a preload that
  exposes two calls, allow and refuse, for the request it was opened with. Those calls are
  accepted only from that window's own web contents and main frame. It is left out of everything
  the app does to "all windows" (reload, hide, theme, vibrancy, the notification fallback).
  Neither the local window nor the hosted view has any call that answers an ask.
- **What it shows.** Vouched for by the app: the server's address, the folder's real path, and
  "you wrote to this thread from this Mac at 14:02", which is the grant. Marked "the server
  says": the workspace's and the thread's names, and the agent's reason. Then the command, whole,
  in a monospaced box that scrolls and never truncates. For a read: the file's real path and its
  size.
- **Shown as it will run.** Control characters, bidirectional overrides, zero-width characters
  and other invisible code points are drawn as visible escapes (`‮`), and a command that
  has any is flagged. A newline is drawn as a line break with a marker. Nothing is rendered as
  Markdown, a link or HTML.
- **What it runs.** Under the command, always, the facts a real shell parse gives: the programs
  it invokes, whether any is a file in the folder, substitutions and redirections, pipes into an
  interpreter, `sudo`, network tools, paths outside the folder. There is never a "clean" state:
  the list is what the command is made of, not a verdict, and a command that can't be parsed says
  so. When a program comes from the folder, or is a tool that runs the folder's own scripts
  (`npm`, `make`, `pytest`, `cargo`, `./gradlew` and the like), it says so: **"Runs code from
  this folder"**, and **"The folder changed since you last allowed a command here"** when its
  git HEAD or index did. The sandbox the agent works in can usually push to the same repository,
  so `git pull` followed by `npm test` is two harmless-looking asks that together run code the
  agent wrote.
- **Hard to approve by accident.** The ask never takes keyboard focus from what the person is
  typing in; it shows, and a notification says so. There is **no keyboard shortcut that allows**:
  Run once takes a pointer click, and only after the window has shown its present content for a
  full second. Any change of content re-arms that second.
- **No swap under the cursor.** An ask the server withdraws (`device.cancel`) or that expires
  stays on screen as "Withdrawn" until the person dismisses it; the next ask never slides into
  its place.
- **One at a time, with limits.** One ask is shown; others wait behind it, at most three per
  thread and eight in all. Beyond the per-thread counts, which use ids the server chooses, there
  is a count per server that it can't dodge: at most twenty asks in ten minutes, and three in a
  row refused, left unanswered or taken back by the server pause lending to that server until the
  person lifts the pause, a decision. An ask not answered in five minutes is refused (`not-answered`).

### No rule skips the ask

This version has none: not for reads, not for a repeated command. Two were considered and cut
after review:

- _Reads without asking_ would turn one tick into a silent copy of the folder, behind a filter
  (`credential-paths.ts`) that was written to keep keys off the screen, not out of a server:
  `.git/config`, `terraform.tfstate`, service-account files and local databases all pass it.
- _This exact command, for this thread_ binds bytes, and a command's meaning is in the folder.
  `npm test` approved once is not the same command after the next pull.

Both can come back only with confinement by the operating system and a budget the person can see
([open decisions](#10-open-decisions)).

### Folders

- A lent folder is checked when it is added, when lending resumes and on every request, by real
  path (links resolved), with the rules joined machines use (`host/folders.ts`), reimplemented
  in the main process without the server's dependencies: no credential folder or anything in
  one, no agent login folder, none of Gram's own folders (the lending settings and the local log
  among them), not `/`, not the home folder itself.
- A command's working folder must be a lent folder or inside one, by real path at the moment it
  starts.
- A lent folder is never a system folder or one that holds one (`/etc`, `/usr`, `/proc`, …),
  and never a Git folder: `.git`, a bare `name.git`, or any folder that holds `HEAD`, `objects`
  and `refs`. The device keeps the folder's device and inode with its path, so a folder moved
  into a lent folder's place isn't taken for it.
- A path is judged in this order, and anything that doesn't fit is refused rather than guessed at:
  1. **by its names alone**, before the disk is looked at: relative, no `..`, no name that starts
     with `..` (a file's other forks on macOS), no name that is `.git` or ends in `.git`, and no
     name the credential check knows (`.env*`, `*.env`, keys, certificates, token files, the
     credential folders), on every name of the path. A refusal here is the same whether or not
     anything is there, so refusals can't be used to find out what is on the disk;
  2. **a name at a time** from the lent folder, without following links: the walk stops at the
     first link whose target leaves the folder, with one answer whatever is behind it. A link
     that stays inside is followed and its target's names are judged as in step 1. A folder on
     the way that holds a Git folder's contents is refused;
  3. what it arrives at must be on the lent folder's device (`st_dev`) and outside every folder
     that is never lent, as those are at that moment, so one created after lending counts.
- A read then goes like this:
  1. require a regular file with one hard link before anything is opened (`not-a-file`
     otherwise: opening a FIFO or a terminal is itself an act);
  2. open it with `O_NOFOLLOW | O_NONBLOCK | O_NOCTTY`; `fstat` the handle; require the same
     device and inode as the file that was checked;
  3. on Linux, ask the kernel where the handle is (`/proc/self/fd/<n>`) and require the path
     that was checked; everywhere, judge the path again and require the same file;
  4. read at most 1 MiB from the handle, counting bytes rather than trusting the size.
- A listing judges the folder the same way. On Linux it holds the folder open and reads it
  through the handle. It looks at no more than 10,000 names, sorts them, returns at most 500
  with kinds and sizes, and omits entries the credential check names. A hard-linked file is
  listed without its size.
- A request about the disk is answered within ten seconds; a mount that doesn't answer counts
  as a refusal. The stuck call itself can't be cancelled, so the device service asks nothing
  more of that folder until it settles.
- A command's output is at most 256 KiB, the end kept, with `truncated` set, cut after
  redaction and never before.

On Linux, a folder swapped for a link between the checks is caught by the kernel's answer. On
macOS and Windows the handle can't be asked where it is, so a swap timed between the checks by
another process running as the person can still win there; that includes a process an earlier
approved command left behind. macOS named forks and Windows streams, device names and its
missing open flags are refused by name but **not yet tested on those systems: neither is lent
until its tests pass there** (see [build order](#9-build-order-and-the-acceptance-test)).
Refusing files with more than one hard link costs reads inside package stores that link their
files (pnpm's `node_modules`); a command can still be asked for.

**The folder limit does not confine a command.** A command runs as the person, with the
person's permissions, and can read or change anything they can, from whichever folder it starts
in. This is the same honest limit as a joined machine's folder guard. What stands between a
command and the rest of the disk is the ask.

### Running a command

- **The shell.** `/bin/sh -c <command>` with no start-up files: not a login shell, not an
  interactive one, so the person's rc files, aliases, functions and directory hooks don't run and
  can't change what a command means. `PATH` and the rest come from the environment Gram already
  probes from the login shell for local sessions, taken once, not re-run per command.
- **The environment** is that probed one, minus variables that read as credentials: by a word
  anywhere in the name (`TOKEN`, `SECRET`, `PASSWORD`, `PASSPHRASE`, `APIKEY`, `CREDENTIAL`,
  `WEBHOOK`, …), by a segment of it (`KEY`, `PAT`, `DSN`, `SESSION`, `AUTH`, `JWT`, …), or by what
  the value looks like (a URL that signs in, `password=…` in a connection string, a well-known
  token prefix, a private key). Also removed: `SSH_AUTH_SOCK`, the askpass variables,
  `GIT_SSH_COMMAND`, `KRB5CCNAME`, Git's settings-by-environment as a set, and
  `DBUS_SESSION_BUS_ADDRESS`, so a command can't borrow the person's signing agent, tickets or
  keyring or raise a password window. The last one costs `systemctl --user` and desktop
  notifications from a command. This is hygiene, not a boundary: it misses what it doesn't know
  and a command can read the same values from files.
- **On the way out, the exact values of the removed variables are redacted from the output**
  before it is sent, and so are a URL's password and a connection string's secret on their own.
  The result is the same however the output is cut into chunks, and the work is one step per
  character. It catches a value printed as it is. It does not catch one printed in pieces, with a
  line break or colour code inside it, or encoded, and values under six characters are removed
  from the environment but not redacted (`1` or `true` would blank half of any output). Passing
  the whole environment to a folder is a decision, made in the lending sheet.
- No stdin and no terminal. A process group of its own. A timeout of two minutes unless the
  request asks for less or up to ten.
- Stopped with `SIGTERM`, then killed with its process group after five seconds, on timeout,
  cancel, a closed connection, a lock or quit. Whatever is left in the group is killed when the
  shell ends, and the group is never signalled after the shell has been collected, since its
  number may then belong to another process. A command that leaves its group (`setsid`, a
  daemon) outlives the request, and a text check can't see that reliably: only confinement by
  the operating system stops it. Output such a process writes after the shell ends is lost, and
  the result says so.
- Variables that change what a command means under bash (`BASH_FUNC_*`, `SHELLOPTS`, `BASHOPTS`,
  `ENV`, `BASH_ENV`, `PS4`, `CDPATH`, `IFS`, `GLOBIGNORE` and the like) are dropped whatever else the environment keeps.

### The hosted view

A hosted workspace is drawn in web contents of its own, so that a rendering bug set off by
someone else's message can't reach what the local window can: the local server's RPC (which
includes `terminal.open` and `terminal.input`), its cookie, or the full desktop bridge. The main
process decides by the calling web contents, and for a hosted view it serves only:

- window chrome (title, traffic lights, zoom of its own);
- `openExternal` for `https:` links, through the existing link-trust prompt;
- asking the main process to open the lending sheet or the activity window for its workspace.

It does not serve: reveal in folder, open or preview a local path, the folder dialog, local
ports, the preview panes, notifications worded by the page (the main process words its own),
clipboard writes without a user gesture, login-item, update or window-management calls. Paths in
a hosted thread's messages are text, never links to this disk.

### The local log

The app appends one line per request to a file in its own data folder, which no lent folder may
contain: time, server, workspace, thread, folder, command or path, how it was answered and the
exit code. No output is kept. Each line carries a keyed hash chained to the one before, with the
key in the keychain, so the activity window can say when the file was edited. It is the person's
own record and doesn't depend on the server's.

## 6. What the control plane enforces

These protect the organisation and the other members, and are a second line for the person.

### The person binding

A device has exactly one owner, taken from the front's signed statement at the dial, never from
anything the device says. A request may be sent to a device only when all of these hold:

1. The session's **current turn was started by a message the owner typed** in an interactive,
   signed-in session of the desktop app, carrying a turn grant, as the fronted sign-in seam
   attributes it. A turn started by a wake, a routine, a trigger, a webhook, a pushed repository
   event, a helper, another thread's message, a worker's report, an API token or automation
   acting as the owner, or a message that waited in a queue past its grant, is never such a turn.
2. **Nothing else has entered the turn.** The moment any input that the owner didn't type joins
   it (another member's steer or queued message, another thread's interrupting message, an answer
   to a question by someone else), the tools are withdrawn for the rest of the turn and pending
   requests are cancelled. A turn recovered after a restart doesn't get them back.
3. The turn is still running and its grant hasn't expired. A long turn waiting on workers
   outlives its grant and loses the tools with it.
4. The call arrived on the turn's own tool channel. The three tools are bound to a secret made
   for that turn and handed only to the session's tool connection, not to the thread's standing
   token, so a process left behind in the sandbox by an earlier turn can't call them.
5. The device is online and its hello offered the capability.
6. The thread is not a worker spawned by another thread. In this version only the thread the
   person is writing to may use their device ([open decision 4](#10-open-decisions)).

A thread acting for anyone else gets a refusal that says so: "Only a turn started by Ada can use
Ada's Mac." The check is made where the request is sent, not only where the tools are offered.
When other people have written in the thread since the owner's previous message, the request says
so and the ask shows it: "Others have written in this thread since your last message."

A device is never a placement target: `spawn_worker`, the orchestrator's own session, checks,
terminals and the machine picker don't list it, and a thread profile can't name it.

### Policy and audit

- Before each request the control plane calls the **decision hook** with the action
  (`device.exec`, `device.files.read`, `device.files.list`), the workspace, thread, acting
  person, device, folder label and the command or path. A refusal stops the request and the
  thread shows why. An "ask a person" answer adds the organisation's own approval **before** the
  device's ask; it never replaces it. With no hook configured, hosted devices stay off: the
  seam doesn't run ungoverned.
- The **event sink** gets `device.connected` and `device.disconnected` (person, device, why),
  `device.requested` (thread, turn, person, device, folder, the command or path, the hook's
  decision), `device.answered` (allowed by the person, or refused and why) and `device.finished`
  (exit, duration, bytes, truncated). The output itself is in the thread's transcript as the
  tool result, like any other tool's. A command the person refuses is in the record too, and the
  lending sheet says so before they lend.
- **Policy** has three values per organisation or workspace, supplied from outside and read-only
  inside: `off` (the front refuses the dial and no tool is offered), `read` (no `device_run`),
  `on`.

### Never hanging

Each request has a deadline the control plane keeps itself. An offline device, a closed
connection, a missed deadline and a refusal each produce a tool result with a fixed reason and a
sentence for the thread. Nothing schedules against a device, and a turn that ends cancels its
requests.

## 7. Threat model

Who might attack: the agent (through injected instructions in what it reads), another member, a
compromised or malicious server, someone holding a stolen sign-in, a look-alike server, and text
that only wants the person to misread an ask.

| #   | Threat                                                                                                                              | What stops or limits it                                                                                                                                                                                                       | What remains                                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | **A compromised or malicious server** sends whatever requests it likes.                                                             | Every request needs a grant this device signed minutes ago for that thread, then an ask. The narrow service, no environment or flags in a request, per-server rate and pause. No call changes settings, folders or software.  | Within ten minutes of the person writing, it can send convincing asks. The person's judgement is the last line.                                           |
| T2  | **An injected agent** (a poisoned issue, web page or file) asks for `curl … \| sh`, or changes the folder and then asks to run it.  | The ask, with the command whole, escapes visible, the reason marked as the agent's, what the command is made of, "runs code from this folder" and "the folder changed". The decision hook can refuse classes of command.      | A person who approves without reading, or who trusts a test script the agent just rewrote.                                                                |
| T3  | **Another member** drives someone's device: writes to a shared thread, steers a running turn, or names the device.                  | The turn must start from the owner's typed message with a grant; any other input withdraws the tools; the per-turn tool secret; the front binds the device to the person.                                                     | **Planted instructions** left earlier in a shared thread, acted on in the owner's next turn. The ask shows the command and that others have written.      |
| T4  | **Unattended use**: a routine, wake, webhook or queued message runs commands on a laptop nobody is at.                              | Such turns carry no grant, so the device refuses them itself. Lock, user switch and idle close the connection. Devices aren't placement targets.                                                                              | An unlocked machine in the ten minutes after its person wrote and walked away: an ask shows and nobody clicks.                                            |
| T5  | **A command reaches outside the lent folders.**                                                                                     | Not prevented, and said so in the lending sheet and on every ask. The ask is the control. No rule skips it.                                                                                                                   | Everything the person's account can reach, for a command they approved. See [section 8](#8-what-this-does-not-protect-against).                           |
| T6  | **Output or a read carries secrets** to the server and to members who can read the thread.                                          | Every read is asked and shows the real path. `.git`, credential names, non-regular and hard-linked files refused. Credential-looking variables removed and their values redacted from output. Bounds on size.                 | A secret in a file with an ordinary name, or printed by an approved command.                                                                              |
| T7  | **The ask misleads**: right-to-left overrides, invisible characters, look-alike letters, a very long command, a hidden second line. | Escapes drawn visibly and flagged; no truncation; line breaks marked; an 8 KiB cap; plain text only; the parse's list of what runs; the approval bound to the hash of what was shown.                                         | Look-alike letters in ordinary scripts (a Cyrillic `а` in a host name) are flagged only as "non-ASCII", not explained.                                    |
| T8  | **The app's own windows are turned against the person**: server text that draws a fake ask or sheet, or a renderer bug that clicks. | Asks and every other decision are main-owned windows with their own origin and preload; no renderer can answer or change one. Hosted content has web contents of its own with no local powers.                                | A fake ask drawn in the hosted view can fool the eye, though clicking it does nothing.                                                                    |
| T9  | **Approval fatigue, flooding or timing**: many asks, or one swapped in as the pointer lands.                                        | One at a time; per-thread and per-server limits; pause after three refused or unanswered; no keyboard allow; one second per content; withdrawn asks stay put; the ask doesn't take focus.                                     | A patient attacker asking a few plausible commands.                                                                                                       |
| T10 | **A stolen sign-in.**                                                                                                               | Device tokens are bound to the device key; grants are signed by it; registration needs proof of the key and a narrow, fresh scope. Tokens live in the main process and the keychain only.                                     | A thief with an interactive sign-in can register **their own** machine as the person's device. New devices are listed and announced; the tools name them. |
| T11 | **A look-alike server.**                                                                                                            | Sign-in in the system browser; the address confirmed in a main-owned dialog in punycode; `https` only; issuer and origin checks on discovery; every ask names the server.                                                     | A person who signs in to the wrong place has given that place a device to ask. The asks still stand.                                                      |
| T12 | **Another program on the machine** drives the device service or edits its settings.                                                 | No listening socket, no loopback endpoint, no command-line entry. Settings authenticated with a keychain key; the log chained.                                                                                                | A program already running as the person needs none of this.                                                                                               |
| T13 | **Path tricks**: links out of the folder, hard links, a swap between check and use, `..`, a FIFO, another mount.                    | The read steps in [folders](#folders): real path, same device, no-follow non-blocking open, regular file with one link, inode compared, bytes counted.                                                                        | Off Linux, a swap timed between the checks by a process that is already the person.                                                                       |
| T14 | **Replay or alteration**: a retried request runs twice, a request id is reused for another command, a dial is replayed.             | Idempotent `requestId` with a payload check; approval bound to a length-prefixed hash; dial bound to subject and token with stored nonces; a grant honoured only while it is in the in-memory list of grants this run minted. | None known.                                                                                                                                               |
| T15 | **The server mislabels** the thread, the workspace or the reason to lend an ask credibility.                                        | Those are marked as the server's word. What the app vouches for (server address, folder, command, that the person just wrote) comes from the app itself.                                                                      | The person may still weigh the label.                                                                                                                     |
| T16 | **A runaway command**: a fork bomb, a daemon left behind, a full disk.                                                              | Timeout, process group, terminate then group kill on every way the request can end.                                                                                                                                           | What a command does in its first seconds, and anything it detaches beyond the process tree.                                                               |
| T17 | **The organisation's policy is bypassed** by a modified app.                                                                        | Policy is enforced at the front (the dial) and the control plane (the tools, the hook). The app's copy is display.                                                                                                            | None: the app is the person's, and is not asked to enforce the organisation's rules.                                                                      |
| T18 | **Hosted content reaches local powers** of the desktop app: a local terminal, a local file, the folder dialog, the sign-in token.   | [The hosted view](#the-hosted-view): its own web contents, origin and partition; the bridge decided in the main process by caller; tokens never in a renderer.                                                                | Bugs in the short list of calls it does get.                                                                                                              |
| T19 | **An approved command grants standing access**: it edits the lending settings or the log.                                           | Settings and log are outside every lent folder, authenticated with a keychain key; a failed check means lending is off.                                                                                                       | A command that reads the keychain as the person. See section 8.                                                                                           |
| T20 | **The audit record surprises the person**: admins see commands, including refused ones; the hello describes the disk.               | The lending sheet says what admins see. The hello carries chosen labels only. The local log holds no output.                                                                                                                  | People skim sheets.                                                                                                                                       |

## 8. What this does not protect against

Stated plainly, so nobody reads more into "limited to chosen folders" than is there:

- **An approved command is the person running that command.** It has their files, their
  credentials, their network, and the operating-system permissions the person gave Gram (on
  macOS, its Files and Folders grants). The folder list bounds where commands start and what can
  be read; it is not a sandbox.
- **A command's text is not its meaning.** `npm test` runs whatever the folder says it runs. The
  ask says when a command runs the folder's code and when the folder changed; it can't read the
  code for the person.
- **The person is the control.** Someone who allows every ask has lent their account to a model
  that reads the internet. The design makes each ask legible and makes blanket approval
  unavailable; it can't make the decision for them.
- **Output is shared.** Whatever a command prints goes into the workspace, where the thread's
  readers and the organisation's audit can see it.
- **The server is believed about names.** The device can't verify a thread's title or what a
  workspace is called. That is why those decide nothing on the device.
- **A compromised machine** is out of scope: malware running as the person doesn't need this.

## 9. Build order and the acceptance test

The head of each pull request gets its own independent review before it merges. Each is a pull request into the integration branch:

1. **Contracts**: `DeviceRpcs`, the discovery document, the grant, the refusal reasons, the event
   shapes.
2. **The device service** in the desktop app's main process: key, dial, grant, folder and read
   checks, command runner, limits, the authenticated settings and log. No UI yet; driven by tests
   against a fake control plane.
3. **The main-owned windows**: the ask, the lending sheet, the new-server dialog, the activity
   window, from the approved mock.
4. **The hosted view**: separate web contents, the caller-checked bridge, the main-process
   connection, hosted workspaces in the sidebar.
5. **The control plane's side**: the `device` host kind (after the provisioned hosts seam), the
   person binding and per-turn tool secret (after the fronted sign-in seam), the three tools, the
   decision hook call and the sink events (after those seams).

The device's checks are tested on Linux and macOS in CI. Lending is offered on a system only
once its path tests pass there: macOS named forks before macOS, and streams, device names and
the missing open flags before Windows.

The acceptance test runs in CI with the fake agent, a headless control plane, the test front and
the device service started in-process, and proves the three things the brief asks for:

- a hosted thread runs a command on the signed-in person's machine after they allow it, and the
  output is the tool's result;
- the same request from a turn started by another member, and from a routine, is refused with
  the reason, and never reaches the device;
- closing the app's side takes the device offline, and a request in flight ends with
  `DeviceUnavailable` within its deadline instead of hanging.

And the properties the threat model leans on, each asserted somewhere in CI:

- on the device: a request with no grant, a forged, expired or other-thread grant, a wrong
  `actor`, or a reused `requestId` with a different payload is refused;
- no call available to the local window or a hosted view answers an ask or changes a lending
  setting, and a hosted view's web contents can't reach the local server or the full bridge;
- another member's steer, an interrupting message or someone else's answer removes the tools
  mid-turn, and a call made with the thread's standing token is refused;
- an ask re-arms after its content changes, and a withdrawn ask is not replaced in place;
- lock, idle and user switch each close the connection and stop a running command;
- the dial is refused on replay, with another person's token or with a token the signature
  doesn't name; a registration without proof of the key is refused;
- reads refuse links out of the folder, hard-linked files, FIFOs, another mount, `.git` and
  credential names; removed variables' values are redacted from output;
- the hello and everything before the first allowed request carry no path;
- a refusal on the device, an unanswered ask and a path outside the lent folders each reach the
  thread as their own reason; the decision hook's refusal stops a request before the device
  hears of it; each step is in the sink in order;
- with the hosted-features setting off, none of the endpoints, tools, windows or settings exist.

## 10. Open decisions

Each default below was approved with the mock on 11 November 2026.

1. **Rules that skip the ask.** Default: none in this version. A later one would need
   decision 5 first, plus a visible budget of files and bytes.
2. **Lending across restarts.** Default: off at each launch, with **Resume lending** confirmed in
   the lending sheet. The alternative is to remember it, which is more convenient and means a
   laptop opened in the morning is lent before its owner has thought about it.
3. **Whole agent sessions on a device.** Default: not in this version. A session there would run
   the person's own Claude Code against their files with a hosted thread steering it, and its
   permission prompts would have to be answered on the machine and nowhere else. It needs its
   own design and review.
4. **Workers.** Default: only the thread the person writes to. Letting a worker the orchestrator
   spawned in that turn inherit the device is natural for Gram, and stretches "a turn the person
   started" over hours of unattended work.
5. **Confinement by the operating system.** Later, and before any rule: run commands under the
   platform's sandbox (Seatbelt on macOS, Landlock or bubblewrap on Linux) so the folder list
   becomes a real boundary, with the network off unless the folder allows it.
6. **The grant's length.** Default: ten minutes from each message the person sends. Shorter
   interrupts long turns; longer widens what a compromised server can do.

## 11. What the security review changed

An independent reviewer read the first draft of this note against the code on 11 November 2026
and found the direction sound but not fit to build past the device service. Its findings, and
where each landed:

| Finding                                                                                            | Change                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lending settings were set from a renderer the design called untrusted                              | [Decisions belong to the main process](#decisions-belong-to-the-main-process); the lending sheet; authenticated settings                                   |
| Hosted content shared a renderer with the local server's terminal RPC and the full bridge          | [The hosted view](#the-hosted-view): its own web contents, a caller-checked bridge, tokens in the main process                                             |
| The device believed the server about whether its person was working                                | [The turn grant](#the-turn-grant), signed by the device key when the person sends from this app                                                            |
| Steers, queued messages and the thread's standing tool token got round "a turn the person started" | [The person binding](#the-person-binding), points 1 to 4                                                                                                   |
| "Reads without asking" was a silent copy of the folder behind a filter built for something else    | Cut. Every read is asked; `.git`, hard links and non-files refused                                                                                         |
| "This exact command" bound bytes, not meaning                                                      | Cut. The ask says when a command runs the folder's code and when the folder changed; a no-rc shell; a fuller, length-prefixed hash                         |
| An ask could be swapped under the cursor, and ⌘↩ is the composer's send key                        | No keyboard allow, no focus taking, re-arm per content, withdrawn asks stay; the ask window left out of all-window loops                                   |
| The read algorithm wasn't implementable in Node as written                                         | The four steps in [folders](#folders), with the race that remains stated                                                                                   |
| The environment filter was undone by a login shell and missed common names                         | No start-up files; a wider name list; askpass and the SSH agent dropped; removed values redacted from output                                               |
| The dial didn't sign the person or the token; anyone could register any key                        | [The dial](#the-dial): subject, token hash and path signed; sender-constrained tokens; challenge-signed registration; the device closes on renewal failure |
| Presence failed open where lock events don't arrive                                                | [Presence](#presence): idle limit everywhere, a polled second signal, user switch, no lending without a signal, terminate before kill                      |
| Sign-in and discovery left the issuer, redirects, scopes and weak keyrings unsaid                  | [Discovery](#discovery) and sign-in: issuer, no redirects, scopes, punycode, no lending without a real keyring                                             |
| Flood limits keyed on ids the server picks; the warning list gave false comfort                    | A per-server rate and pause; facts from a parse, never a clean state                                                                                       |
| An approved command could edit the settings; askpass windows                                       | Authenticated settings outside lent folders; askpass variables removed; the macOS privacy point in section 8                                               |
| The hello described the disk; admins see refused commands                                          | Chosen labels only, no release; the lending sheet says what admins see; a chained local log                                                                |

### What the code review changed

An independent reviewer read the contracts and the device core (keys, folders, environment) on
11 November 2026, with reproductions, before any of it was wired. Its fifteen findings and where
each landed:

| Finding                                                                                   | Change                                                                                                                                     |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| A folder swapped for a link read a file outside the lent folder, under an inside path     | The walk and the kernel's answer in [folders](#folders); closed on Linux, narrowed and stated elsewhere                                    |
| Refusal reasons told a server what exists anywhere on the disk                            | Names judged before the disk; the walk stops at the first link out; one answer either way                                                  |
| A grant held for ever when the clock wasn't a number                                      | Clock, issue time and a dial's time must be whole numbers                                                                                  |
| Blank and never-drawn characters showed as ordinary text in an ask (no-break space first) | Drawn by Unicode property, tested against every code point                                                                                 |
| Redaction leaked by how output was chunked, and could stall the main process              | One pass that finds every place, joins overlaps and holds back only what could still match                                                 |
| The environment filter missed common names and shapes, and broke Git for some             | Words inside names, value shapes, Git's variables as a set; what it still costs is said above                                              |
| A `.git` folder or a bare repository could be lent and read                               | Never lent; refused by name and by contents; `*.env` and other key names added                                                             |
| macOS forks and Windows streams could step round the name checks (not tested)             | Refused by name; neither system is lent until tested there                                                                                 |
| System folders could be lent; later-created forbidden folders and a replaced folder read  | System folders refused; never-lent folders compared on every request; device and inode kept; ten-second deadline; nothing but files opened |
| Discovery checked parsed addresses and handed back the raw text                           | An address must be spelled as a URL parser writes it, with no query or fragment                                                            |
| Signed fields with a lone surrogate encoded alike                                         | Refused; ids are printable ASCII                                                                                                           |
| Signatures had sixteen spellings; small-order keys verified anything; ids from any text   | One spelling; small-order keys refused; an id only from a valid key, and a dial must name its key's device                                 |
| Half a millisecond became no timeout; limits that weren't numbers; unbounded fields       | Floored first; refused; bounds on the command, output, listings, folders and sizes                                                         |
| A listing cut short wasn't the same twice and gave sizes of hard-linked files             | Sorted before it is cut; no size for a hard-linked file                                                                                    |
| Many checks could be deleted without a test failing                                       | A test for each, the swap race and the redactor's chunking among them                                                                      |

Left for the device service, where the caller lives: path refusals count against the per-server
rate; a grant is honoured only while its nonce is in the device's in-memory list of grants it
minted, so none survives a quit; "the same payload" is compared on the decoded request; output is
decoded with a `StringDecoder`; server-worded text in main-owned windows is drawn like a command.

A second independent review, of the fixes, found no way out of a lent folder on Linux and no
leak in the redactor, and asked for: a swap test that lands every time rather than by luck; a
mark that goes out at once for a value that overlaps itself, so nothing is held without bound;
"no" rather than an exception for a grant whose fields aren't text; and a URL that only names a
user (`ssh://git@host`) left alone. Those are in. Carried to the device service and the windows:
tests for each remaining single check its mutation run found unasserted; combining marks after
an ASCII character in an ask; judging names again on the real path for file systems that fold
names (macOS, Windows short names); a narrower list of where a folder may be lent from.

### What the review of the gate changed

A third independent review read the gate, the serving of `DeviceRpcs`, the dial and the lending
settings on 11 November 2026, with reproductions and a mutation run. It found nothing that runs,
reads or lists without an allow for what the window showed, and asked for these, which are in:

| Finding                                                                                   | Change                                                                                      |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| A request taken back or stopped while its path was looked at was still asked, and counted | Never asked; one the server took back still counts against the server                       |
| With asks full, a path that exists and one that doesn't were answered differently         | A place among the asks is taken before any path is looked at; a path refused frees it       |
| A server without a grant could make the device write log lines without end                | Refusals before any ask: at most 20 lines in ten minutes, words cut short, the rest counted |
| Only presence and the working folder were checked after the allow                         | Every check before the ask is made again, and the folder must still be the one lent         |
| A list or read the control plane stopped waiting for wasn't taken back                    | Taken back when the last caller waiting on it leaves; a joined caller leaving doesn't       |
| Concurrent token calls each asked for a token, and one that never came hung               | One at a time, shared; none in 30 seconds ends the connection                               |
| A window that threw before it returned kept its place among the asks for ever             | A refusal; the place is freed however the ask ends                                          |
| Exits after the allow weren't logged                                                      | Logged                                                                                      |
| A read could return more than the size the window showed                                  | Read no further than that size                                                              |
| A dial address with a fragment couldn't be dialled; settings weren't synced or bounded    | Fragment dropped; written to disk before the rename; a file over 4 MiB is refused           |

A second review of the fixes found them holding and asked for four more, which are in: the
device ending a connection stops what waits on the person before the calls end, so a lock is
"away" and never counts toward a pause; every check after the allow is made after the last wait;
a file shown empty is read as empty; a listener that throws frees its place.

Carried to the wiring: the headers are made afresh for each dial (an Effect WebSocket keeps the
headers it was made with, so a reconnect would repeat the nonce). A lending settings file copied
back from earlier still checks out; a generation number kept beside the key will catch that,
and resuming lending already goes through the lending sheet.

### The ask window as built

The ask is a page of its own, loaded from a `data:` address in a session partition of its own,
with no bridge to the app. It draws only text it is handed, and answers through its own title,
which the main process reads from that window alone. Allow takes a pointer click on content that
has been on screen a full second; new content, or the window going out of sight and back, starts
the second again, and the main process checks the second itself. Asks are shown one at a time,
without taking focus, and one the server takes back stays on screen, marked withdrawn, until the
person dismisses it, so nothing slides in under their pointer. What a command runs is read by a
small shell parser: the programs, code from the folder, network, elevation, paths outside the
folder, and "Gram couldn't read this command whole" where it can't. These are facts, never a
verdict.

The review of the ask window changed four things. The command reader now says it can't read
what bash expands in ways it can't follow: `$((` that names a value or holds a substitution,
`${…}` with a default, indirection or transformation, an unquoted here-document holding a
substitution, `$'…'`, and brace expansion; it names assignments before a program, a `cd` out of
the folder, and programs behind more wrappers (`find -exec`, `setsid`, `busybox`, `su -c`), and
refuses wrapper options it doesn't know. The queue can't stick: a window that closes, crashes,
hangs or reloads takes its ask with it as refused, and a withdrawal that crosses a draw is sent
again. Allow also needs the pointer to have moved since the second ended and to have pressed on
Allow after that, the window opens in the corner farthest from the pointer, and losing focus
starts the second again. What the server says is drawn one line a piece, cut at 160 characters,
with a warning for look-alike letters, and the command's own words in a fact are quoted.

A second review found more that bash runs without showing it, and those are in: arithmetic in
any form (`((…))`, `[[ … ]]`, `$[…]`, subscripts, `let`, `declare -i`, `printf -v`, `test -v`)
and programs that run others in ways the reader doesn't follow (`watch`, `strace`, `flock` and
the like) leave the command unread; `trap` is read as the text it runs; names are matched
without case, as a disk that ignores case finds them; a pattern such as `.?` that can match `..`
counts as leaving the folder; and a window closing is tied to the ask it drew, so a late close
can't refuse the next one, and no ask window opens once the app is quitting.

A third review found the earlier fixes holding and no ordinary command made unreadable, and
asked for a few more, which are in: every sed and awk script is named as a script that can run
commands and write files; an interpreter given a glued script (`-e'…'`) or fed a file or a
here-document is named as running it; options between `bash -c` and its text leave the command
unread; options that run commands (`tar --checkpoint-action`, `split --filter`, `ssh`'s
`ProxyCommand` and the like) are named; and a window that goes while loading refuses its ask.
The reader stays a list of facts: programs with exec options it doesn't know still read as
themselves, which is why the command is always shown whole above them.
