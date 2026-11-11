# Lending this machine to a hosted workspace

[Up: other machines](../MACHINES.md) · [Mock](mocks/hosted-device/brief.md)

Status: design for review, 10 November 2026. Nothing here is built. It sits behind the one
hosted-features setting (`experimental.embedding`), and with that off none of it exists.

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
> enforced by the app on their machine. Every limit that protects the organisation is enforced by
> the server. Neither side relies on the other's check.

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

## 1. What it is, and what it isn't

|                                |                                                                                                                                                                                                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bound to one person**        | A device belongs to the person signed in on it. Only a turn that person started themselves, by their own message, may ask it for anything.                                                                                                                      |
| **Present only while you are** | It exists while the app is open, the person is signed in, lending is on for that workspace and the screen is unlocked. Quitting the app, signing out, switching lending off or locking the screen takes it offline at once. No background service is installed. |
| **Asks before each command**   | By default every command is shown on the machine and runs only after the person allows it there.                                                                                                                                                                |
| **Limited to chosen folders**  | Commands start in, and files are read from, only the folders the person picked for that workspace, with Gram's existing guard on credential folders and files.                                                                                                  |
| **Dials out**                  | The app opens one HTTPS WebSocket to the hosted server with the person's sign-in. The machine listens on nothing. No Tailscale.                                                                                                                                 |
| **Governed**                   | Every request passes the control plane's decision hook before it is sent and is written to its event sink. An organisation can turn devices off or allow reading only.                                                                                          |

It is **not** a joined machine, and deliberately so:

- No worker, orchestrator or agent session is ever placed on it. In this version it runs single
  commands and reads files; see [open decisions](#10-open-decisions) for whole sessions.
- Nothing unattended may use it: no routine, wake, trigger, webhook or message from another
  thread.
- The server can't install, update, configure or sign in anything on it. None of the joined
  machine calls for updates, Claude tokens, terminals, repositories or worktrees exist on this
  connection.

## 2. Parties and what each is trusted for

| Party                                    | What it is                                                                                                                     | Trusted for                                                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| **The person**                           | Signed in to the hosted server in their desktop app                                                                            | Deciding what runs on their machine.                                                                                              |
| **The app's main process**               | Gram on the person's machine: holds the sign-in, the device key and the lending settings, draws the ask, runs what was allowed | Everything that protects the person. It is the only trusted code on the person's side.                                            |
| **The app's renderer**                   | Gram's bundled web UI, showing hosted workspaces beside local ones                                                             | Display only. It renders text that came from the server, so it is **not** trusted to approve anything.                            |
| **The hosted server's front**            | Whatever terminates TLS and signs people in ahead of the control plane (the fronted sign-in seam)                              | Naming who is signed in, and applying the organisation's device policy. Not trusted by the device for what may run.               |
| **The control plane**                    | Headless Gram for one workspace                                                                                                | Binding requests to the person and turn, calling the decision hook, the audit record. Not trusted by the device for what may run. |
| **The agent session**                    | A model with a shell on a sandbox host, reading repositories, web pages and issues                                             | Nothing. Its requests, and the reasons it gives for them, are untrusted text.                                                     |
| **Other members**                        | People in the same workspace                                                                                                   | Nothing on someone else's device. They can read the threads they could already read, including a command's output.                |
| **The decision endpoint and event sink** | The embedding platform's policy and audit                                                                                      | The organisation's rules. They can refuse, never compel: an "allow" from them is not an approval on the device.                   |

The assets, in order: the person's files and credentials on their machine; the person's ability to
tell what they are approving; the organisation's audit record and policy.

## 3. The flow

### Sign in and see hosted workspaces

1. With hosted features on, Settings gains **Hosted**. The person types the server's address
   (`https://gram.example.com`) and chooses **Sign in**.
2. The app reads `https://<server>/.well-known/gram-hosted` ([below](#discovery)) and opens the
   **system browser** at the server's authorization address: OAuth 2.0 authorization code with
   PKCE and a loopback redirect ([RFC 8252](https://www.rfc-editor.org/rfc/rfc8252)). The app
   never shows a sign-in page itself and never sees a password.
3. The app keeps the refresh token in the operating system's keychain (Electron `safeStorage`)
   and the access token in memory. The first sign-in to an address asks the person to confirm it,
   showing the address as the server presented its certificate for it.
4. The app lists the person's workspaces from the server and shows them in the sidebar beside
   local ones, marked as hosted and with the server's name. Opening one connects Gram's own
   bundled UI to that workspace through the server's front. **No page or script from the server
   is ever loaded into the app**: the server supplies data, the app supplies the UI.

### Lend this machine

5. On a hosted workspace's settings, **Lend this Mac** is off. Turning it on asks for at least
   one folder, through the system folder dialog. Each folder is checked on the spot
   ([folders](#folders)).
6. The first time, the app makes an Ed25519 key pair for this machine and this server, keeps the
   private half in the keychain, and registers the public half with the server under the
   person's sign-in. The server lists the person's devices, by name and fingerprint, where the
   person and their organisation's admins can see and revoke them.
7. The app dials `wss://<server>/device/connect` for that workspace: the person's access token
   plus a signature by the device key over the address, the workspace, the time and a nonce (the
   same construction as a joined machine's dial in `host/machine-keys.ts`). The front checks the
   sign-in, the device's registration to that person, the person's membership and the
   organisation's policy, then forwards the connection to the workspace's control plane with a
   signed statement of who the person is and which device key this is. The control plane checks
   the dial's signature against the key in that statement and admits the connection as a host of
   kind `device`, owned by that person.
8. While it is lent, the app says so wherever the person is: a **Lending this Mac** mark in the
   sidebar's footer that opens what is lent and to whom, with **Stop lending**.

### A thread asks for a command

9. The person writes to a thread in the hosted workspace. For that turn only, the session gets
   three tools from the control plane: `device_run`, `device_read_file` and `device_list_files`,
   each naming the device and one of its lent folders.
10. The session calls `device_run`. The control plane checks that the turn was started by a
    message from the device's owner and is still running ([binding](#the-person-binding)), calls
    the decision hook, writes the request to the event sink, and sends `device.exec` down the
    device's connection with a deadline.
11. The app's main process checks the request against the folder and its own limits, then opens
    the **ask**: a small window of its own, showing the server, the workspace, the thread, the
    folder and the exact command. The thread's view shows "Waiting for you on this Mac".
12. **Run once** runs it; **Don't run** refuses it. The output streams back, bounded, and becomes
    the tool's result in the thread. The control plane writes the answer and the outcome to the
    event sink. The app writes its own line to a local activity log.

### Going away

13. Quitting the app, signing out, switching lending off, locking the screen or losing the
    network closes the connection. The control plane marks the device offline at once (the
    connection closed) or within 20 seconds (four missed pings, as for a joined machine). A
    request in flight fails with `DeviceUnavailable` and a reason the thread can show: "This Mac
    went offline: Gram was closed." A command still running on the machine is stopped, its
    whole process tree with it.
14. Every request carries a deadline (the ask's wait plus the command's timeout). When it passes,
    the control plane answers the tool call itself. Nothing waits on a device without a clock
    running.

## 4. The protocol

### Discovery

`GET https://<server>/.well-known/gram-hosted` answers, without sign-in:

```json
{
  "version": 1,
  "name": "Example Co",
  "authorization_endpoint": "https://gram.example.com/oauth/authorize",
  "token_endpoint": "https://gram.example.com/oauth/token",
  "workspaces_endpoint": "https://gram.example.com/api/workspaces",
  "devices_endpoint": "https://gram.example.com/api/devices",
  "device_connect": "wss://gram.example.com/device/connect"
}
```

Every address must be `https:` or `wss:` on the server's own origin; the app refuses the document
otherwise. Plain `http:` is accepted only for loopback, for tests. Gram defines this document and
the calls below; whatever fronts the control plane serves them. Gram's tests carry a small front
that does.

### Sign-in, workspaces and devices

| Call                                                                                    | With                                          | Answers                                                                |
| --------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------- |
| Authorization code + PKCE (`S256`), loopback redirect on a random port, `state` checked | browser                                       | access token (15 minutes at most), rotating refresh token              |
| `GET workspaces_endpoint`                                                               | access token                                  | `[{ id, name, organisation, role, devices: "off" \| "read" \| "on" }]` |
| `POST devices_endpoint`                                                                 | access token, `{ publicKey, name, platform }` | `{ deviceId }`; the id is derived from the public key                  |
| `DELETE devices_endpoint/<deviceId>`                                                    | access token                                  | forgets the device; the app does this on **Sign out**                  |

`devices` on a workspace is the organisation's policy as the server will enforce it. The app
shows it; it never relies on it.

### The dial

One WebSocket per lent workspace:

```
GET wss://<server>/device/connect?workspace=<id>
Authorization: Bearer <access token>
x-gram-device-id:        <deviceId>
x-gram-device-time:      <ms since epoch>
x-gram-device-nonce:     <16 random bytes>
x-gram-device-signature: Ed25519(device key, "gram-device-v1\n" + origin + "\n" + workspace + "\n" + deviceId + "\n" + time + "\n" + nonce)
```

The front refuses a dial whose token is invalid, whose device isn't registered to that person,
whose person isn't a member, or whose organisation has devices off. The control plane refuses
one whose signature doesn't verify against the key in the front's statement, whose time is more
than two minutes off, or whose nonce it has seen. The access token is renewed over the socket
(`device.renew`) before it expires; a connection whose token lapses is closed by the server.

### The device's service

Framing is the host protocol's (Effect RPC, NDJSON over the socket, pings every five seconds).
The service is **its own small group, `DeviceRpcs`, not `HostRpcs` with calls removed**: a call
that isn't in the table doesn't exist on this connection, and a new host call never appears here
by default. The control plane is the client; the app's main process serves.

| Call                | Payload                                                                                                                  | Answers                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `device.hello`      | –                                                                                                                        | `{ protocol: 1, deviceId, platform, release?, capabilities, folders: [{ id, label }] }`                                 |
| `device.exec`       | `{ requestId, thread: { id, title }, actor: { id, name }, turnStartedAt, folderId, cwd?, command, timeoutMs?, reason? }` | stream: `asked`, then `refused { why }` or `started`, `output { stream, text }` …, `exit { code \| signal, truncated }` |
| `device.files.list` | `{ requestId, thread, actor, folderId, path, limit }`                                                                    | names, kinds and sizes; folders and files                                                                               |
| `device.files.read` | `{ requestId, thread, actor, folderId, path, maxBytes }`                                                                 | text or bytes, bounded; `refused { why }`                                                                               |
| `device.cancel`     | `{ requestId }`                                                                                                          | stops the ask or the command                                                                                            |
| `device.renew`      | `{ accessToken }`                                                                                                        | – (sent by the app; the one call in this direction)                                                                     |

Notes that matter:

- **`capabilities`** is `["read"]` or `["read", "exec"]`. The app leaves `exec` out when the
  workspace's policy is read only, and the control plane doesn't offer `device_run` either.
- **`folders`** carry an opaque `id` and a `label` (the path with home shown as `~`). Requests
  name a folder by id and a path inside it; an absolute path is refused, never interpreted.
- **`command`** is one string, run as `<login shell> -c <command>` with stdin closed and no
  terminal. It is at most 8 KiB, valid UTF-8 and free of NUL. Requests carry **no environment,
  no shell choice and no flags**: the only things a request can vary are the folder, the path
  inside it, the command and a timeout within the device's own bounds.
- **`thread`, `actor`, `turnStartedAt` and `reason`** are the server's word. The app shows them,
  labelled as coming from the server, and decides nothing by them except to refuse a request
  whose `actor.id` isn't the signed-in person.
- **`requestId`** makes a request idempotent. A repeat joins the ask or the run under way, or
  answers with how it ended. An approval is bound to the SHA-256 of
  `(requestId, folderId, cwd, command)` as shown, and what runs is exactly those bytes.
- **`refused.why`** is one of a fixed set (`not-allowed-by-person`, `not-answered`,
  `away`, `outside-folders`, `credential-path`, `too-many-requests`, `paused`, `read-only`,
  `too-large`, `not-for-this-person`), so a thread can say what happened without the device
  describing its disk.

### What the session sees

The control plane adds three app tools to a session only for a turn that may use a device:

| Tool                                                             | Does                                  |
| ---------------------------------------------------------------- | ------------------------------------- |
| `device_run { device, folder, cwd?, command, reason, timeout? }` | One command, its output and exit code |
| `device_read_file { device, folder, path }`                      | A file's text, bounded                |
| `device_list_files { device, folder, path? }`                    | A folder's entries                    |

Their descriptions tell the agent that the person is asked on their machine for each command,
that a refusal is final for that request, and that the device may go offline at any time. A
refusal or an offline device is an ordinary tool result with the reason, never a hang and never
an error the session retries by itself: the control plane refuses a repeat of a refused command
within the same turn.

## 5. What the device enforces

All of this is in the app's main process, on the person's machine, and holds whatever the server
does.

### Presence

The connection exists only while the app runs, the person is signed in, lending is on for that
workspace and the session is unlocked. The app closes it on `lock-screen` and `suspend`
(Electron `powerMonitor`), and where the platform reports no lock, after five minutes of system
idle. Lending switches itself off when the app quits; the next launch offers **Resume lending**
and does nothing until the person chooses it ([open decision 2](#10-open-decisions)).

### The ask

- **A window of its own.** The ask is a small window the main process creates, with its own
  preload that exposes two calls, allow and refuse, for the request it was opened with. The
  app's main window, which renders text from the server, has no call that answers an ask. A
  script that ran in the main window, by whatever bug, could not approve a command.
- **What it shows.** From the app's own settings: the server's address, the workspace and the
  folder's real path. From the request, marked "the server says": the thread's title, who
  started the turn and when, and the agent's reason. Then the command, whole, in a monospaced
  box that scrolls and never truncates.
- **Shown as it will run.** Control characters, bidirectional overrides, zero-width characters
  and other invisible code points are drawn as visible escapes (`‮`), and a command that
  has any is flagged. A newline is drawn as a line break with a marker. Nothing is rendered as
  Markdown, a link or HTML.
- **Look closely.** A short list of patterns adds a plain warning above the buttons: output
  piped to a shell, `sudo`, deletion outside the folder, a path under a credential folder,
  `env` or `printenv`, a download, base64 or hex decoded into a shell. The list is a prompt to
  read, not a filter: it blocks nothing and catching nothing proves nothing.
- **Hard to approve by accident.** Focus starts on **Don't run**. Enter and Space never allow.
  **Run once** takes a click or ⌘↩, and only after the window has been visible and focused for
  700 ms. A system notification can open the ask; it can never answer it.
- **One at a time, with limits.** One ask is shown; others wait behind it, at most three per
  thread and eight in all, and more are refused (`too-many-requests`). An ask not answered in
  five minutes is refused (`not-answered`). Three refusals in a row from one thread pause that
  thread on this device (`paused`) until the person lifts it in settings.

### Allowing without an ask

Off by default, per workspace and folder, set only in the app's settings, never from an ask
dialog's defaults and never by the server:

- **Reads without asking.** Listing and reading files inside that folder skip the ask. These are
  the calls the device can truly confine, so this is the one broad rule on offer.
- **This exact command, for this thread, until Gram closes.** A tick on the ask itself. The rule
  is the command's bytes, the folder and the thread; it is kept in memory only and ends with the
  app, the sign-in or lending. There are no patterns, prefixes or "all commands".

A rule never applies while the screen is locked, and every use of one is in the local log and
the event sink, marked as allowed by rule.

### Folders

- A lent folder is checked when it is added, when the app starts and on every request, by real
  path (links resolved), with the guard joined machines already use (`host/folders.ts`): no
  credential folder or anything in one, no agent login folder, none of Gram's own folders, not
  `/`. A lent folder may not be the home folder itself either, since that contains all of those.
- A command's working folder must be a lent folder or inside one, by real path at the moment it
  starts.
- A read or listing must resolve inside the lent folder. The file is opened without following a
  final link, and the opened file's real path is checked again before a byte is sent. Credential
  files are refused by name and extension wherever they are (`credential-paths.ts`: `.env*`,
  keys, certificates, token files).
- Reads are at most 1 MiB and listings 500 entries. A command's output is at most 256 KiB, the
  end kept, with `truncated` set.

**The folder limit does not confine a command.** A command runs as the person, with the
person's permissions, and can read or change anything they can, from whichever folder it starts
in. This is the same honest limit as a joined machine's folder guard. What stands between a
command and the rest of the disk is the ask. This is why there is no broad rule for commands,
and why [confinement by the operating system](#10-open-decisions) is the thing to build before
one is ever offered.

### Running a command

- The person's login-shell environment, as Gram already resolves it for local sessions, **minus
  variables that look like credentials** (names matching `TOKEN`, `SECRET`, `PASSWORD`, `_KEY`,
  `CREDENTIAL`, and the known provider prefixes), so that a stray `env` in a script doesn't send
  them to the server. A folder's settings can pass the whole environment.
- No stdin and no terminal, so nothing can prompt for a password. A process group of its own.
  A timeout of two minutes unless the request asks for less or up to ten.
- Stopped, with its whole process tree, on timeout, cancel, a closed connection, a lock or quit.

### The local log

The app appends one line per request to a file in its own data folder: time, server, workspace,
thread, folder, command, how it was answered (person, rule, refused and why) and the exit code.
No output is kept. Settings → Hosted → **Activity on this Mac** shows it. It is the person's own
record and doesn't depend on the server's.

## 6. What the control plane enforces

These protect the organisation and the other members, and are a second line for the person.

### The person binding

A device has exactly one owner, taken from the front's signed statement at the dial, never from
anything the device says. A request may be sent to a device only when all of these hold:

1. The session's **current turn was started by a message the owner sent themselves** to that
   thread, as the fronted sign-in seam attributes it. A turn started by a wake, a routine, a
   trigger, a webhook, a pushed repository event, a helper, another thread's message or a
   worker's report is never a person's turn, whoever set those up.
2. That turn is still running. The tools are removed from the session when it ends.
3. The device is online and its hello offered the capability.
4. The thread is not a worker spawned by another thread. In this version only the thread the
   person is writing to may use their device ([open decision 4](#10-open-decisions)).

A thread acting for anyone else gets a refusal that says so: "Only a turn started by Ada can use
Ada's Mac." The check is made where the request is sent, not only where the tools are offered.

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
  decision), `device.answered` (allowed by the person, allowed by rule, or refused and why) and
  `device.finished` (exit, duration, bytes, truncated). The output itself is in the thread's
  transcript as the tool result, like any other tool's.
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

| #   | Threat                                                                                                                                               | What stops or limits it                                                                                                                                                                                                            | What remains                                                                                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | **A compromised or malicious server** sends whatever requests it likes.                                                                              | The device treats every request as untrusted: ask per command, the narrow service, no environment or flags in a request, limits and pauses. The server has no call that changes the device's settings, rules, folders or software. | It can send convincing asks. The person's judgement is the last line.                                                                                                                                                                          |
| T2  | **An injected agent** (a poisoned issue, web page or file) asks for `curl … \| sh`, or for a harmless-looking command with a harmful tail.           | The same ask, with the command whole, escapes visible, the reason marked as the agent's own claim, and the look-closely warnings. The decision hook can refuse classes of command for the organisation.                            | A person who approves without reading. Mitigated, not removed, by the pauses and the queue limits.                                                                                                                                             |
| T3  | **Another member** drives someone's device: writes to a shared thread, or starts a thread and names the device.                                      | The turn must be started by the owner's own message; checked where the request is sent. The front binds the device to the person at the dial.                                                                                      | **Planted instructions**: a member leaves text in a shared thread, and the owner's next turn acts on it. The ask shows the command, and says who started the turn, not who wrote every earlier message.                                        |
| T4  | **Unattended use**: a routine, wake or webhook runs commands on a laptop at night.                                                                   | Such turns never qualify. The device is offline when locked or idle, and rules don't apply while locked. Devices aren't placement targets.                                                                                         | None known.                                                                                                                                                                                                                                    |
| T5  | **A command reaches outside the lent folders.**                                                                                                      | Not prevented, and said so in the app where folders are picked. The ask is the control. No broad rule for commands.                                                                                                                | Everything the person's account can reach, for a command they approved. See [section 8](#8-what-this-does-not-protect-against).                                                                                                                |
| T6  | **Output carries secrets** to the server and to members who can read the thread.                                                                     | Credential-looking environment variables removed; credential files refused for reads; output bounded; the ask says the output is sent to the workspace.                                                                            | A command that prints a secret from a file or a keychain, approved by the person.                                                                                                                                                              |
| T7  | **The ask misleads**: right-to-left overrides, invisible characters, look-alike letters, a very long command, a newline that hides a second command. | Escapes drawn visibly and flagged; no truncation; line breaks marked; an 8 KiB cap; plain text only; the approval bound to the hash of what was shown.                                                                             | Look-alike letters in ordinary scripts (a Cyrillic `а` in a host name) are flagged only as "non-ASCII", not explained.                                                                                                                         |
| T8  | **The app's own window is turned against the person**: server-supplied text that draws a fake ask, or a renderer bug that clicks Allow.              | The ask is a separate window with its own two-call preload; the main window has no way to answer. Focus on Don't run, no Enter, a 700 ms hold, no answering from a notification.                                                   | A fake ask drawn in the main window can still fool the eye, though clicking it does nothing. The real one looks like a system sheet and names the server.                                                                                      |
| T9  | **Approval fatigue or flooding**: many asks until the person clicks through.                                                                         | One at a time; three per thread, eight in all; refusals pause the thread; five-minute expiry; no "allow everything".                                                                                                               | A patient attacker asking a few plausible commands.                                                                                                                                                                                            |
| T10 | **A stolen sign-in.**                                                                                                                                | It reaches no device by itself: a device must be online and the person must allow each command. The device key means a token alone can't pose as an existing device. Tokens are short-lived, rotated and kept in the keychain.     | The thief can register **their own** machine as the person's device and have the person's threads send it commands and take poisoned output back. New devices are listed and announced to the person by the server; the tools name the device. |
| T11 | **A look-alike server.**                                                                                                                             | Sign-in happens in the system browser, where a password manager and the address bar apply. The app shows the address and asks the person to confirm a new one. `https` only. Every ask names the server.                           | A person who signs in to the wrong place has given that place a device to ask. The asks still stand.                                                                                                                                           |
| T12 | **Another program on the machine** drives the device service.                                                                                        | There is nothing to connect to: no listening socket, no loopback endpoint, no command-line entry. Asks are answered only through the ask window's preload.                                                                         | A program already running as the person needs none of this.                                                                                                                                                                                    |
| T13 | **Path tricks**: links out of the folder, a swap between check and use, `..`, an absolute path.                                                      | Real paths at use; no-follow open then a second check on the opened file; relative paths only; refusal when a check can't be made.                                                                                                 | A race on a folder the person lent and an attacker on the same machine controls; that attacker already has the account.                                                                                                                        |
| T14 | **Replay or alteration**: a retried request runs twice, or the command changes after approval.                                                       | Idempotent `requestId`; approval bound to the hash; dial nonces and signed time.                                                                                                                                                   | None known.                                                                                                                                                                                                                                    |
| T15 | **The server mislabels** the thread, the person or the reason to lend an ask credibility.                                                            | Those are shown as the server's word. What the app vouches for (server, workspace, folder, command) comes from the app itself.                                                                                                     | The person may still weigh the label.                                                                                                                                                                                                          |
| T16 | **A runaway command**: a fork bomb, a daemon left behind, a full disk.                                                                               | Timeout, process group, tree kill on every way the request can end.                                                                                                                                                                | What a command does in its first seconds, and anything it detaches beyond the process tree.                                                                                                                                                    |
| T17 | **The organisation's policy is bypassed** by a modified app.                                                                                         | Policy is enforced at the front (the dial) and the control plane (the tools, the hook). The app's copy is display.                                                                                                                 | None: the app is the person's, and is not asked to enforce the organisation's rules.                                                                                                                                                           |
| T18 | **Hosted content reaches local powers** of the desktop app: open or reveal a local file, a local terminal, the folder dialog.                        | A hosted workspace gets a reduced desktop bridge: paths in its messages are never opened, previewed or revealed on this machine, and its links follow the existing link-trust rules.                                               | To be enumerated call by call in the build; listed in the review checklist.                                                                                                                                                                    |
| T19 | **Two devices, one person**: the wrong machine runs it.                                                                                              | The tool names the device; the ask appears only there and names the workspace and folder.                                                                                                                                          | None known.                                                                                                                                                                                                                                    |
| T20 | **The audit record leaks** commands or paths to people who shouldn't see them.                                                                       | The sink is the organisation's; the local log stays on the machine and holds no output. The ask says the command and its output go to the workspace.                                                                               | A person may not expect their admins to see commands they ran. The copy has to say it.                                                                                                                                                         |

## 8. What this does not protect against

Stated plainly, so nobody reads more into "limited to chosen folders" than is there:

- **An approved command is the person running that command.** It has their files, their
  credentials, their network. The folder list bounds where commands start and what can be read
  without a command; it is not a sandbox.
- **The person is the control.** Someone who allows every ask has lent their account to a model
  that reads the internet. The design makes each ask legible and makes blanket approval
  unavailable; it can't make the decision for them.
- **Output is shared.** Whatever a command prints goes into the workspace, where the thread's
  readers and the organisation's audit can see it.
- **The server is believed about who is who.** The device can't verify that a thread is what the
  server says. That is why those labels decide nothing on the device.
- **A compromised machine** is out of scope: malware running as the person doesn't need this.

## 9. Build order and the acceptance test

Nothing is built until this design has had an independent security review and the mock is
approved. Then, each a pull request into the integration branch:

1. **Contracts**: `DeviceRpcs`, the discovery document, the refusal reasons, the event shapes.
2. **The device service** in the desktop app's main process: key, dial, folder checks, command
   runner, limits, the local log. No UI yet; driven by tests against a fake control plane.
3. **The ask window** and the Hosted settings, from the approved mock.
4. **The control plane's side**: the `device` host kind (after the provisioned hosts seam), the
   person binding (after the fronted sign-in seam), the three tools, the decision hook call and
   the sink events (after those seams).
5. **Hosted workspaces in the sidebar**, with the reduced desktop bridge.

The acceptance test runs in CI with the fake agent, a headless control plane, the test front and
the device service started in-process, and proves the three things the brief asks for, plus the
ones the threat model leans on:

- a hosted thread runs a command on the signed-in person's machine after they allow it, and the
  output is the tool's result;
- the same request from a turn started by another member, and from a routine, is refused with
  the reason, and never reaches the device;
- closing the app's side takes the device offline, and a request in flight ends with
  `DeviceUnavailable` within its deadline instead of hanging;
- a refusal on the device, an unanswered ask and a path outside the lent folders each reach the
  thread as their own reason;
- the decision hook's refusal stops a request before the device hears of it, and each step is in
  the sink in order;
- with the hosted-features setting off, none of the endpoints, tools or settings exist.

Unit tests cover the escaping of an ask's text, the approval hash, the folder and credential
checks (links, races, case), the environment filter, the limits and the dial's signature.

## 10. Open decisions

Each has a default the mock and this note assume.

1. **Rules that skip the ask.** Default: reads inside a lent folder, and one exact command per
   thread until the app closes. No broader rule for commands until the operating system confines
   them.
2. **Lending across restarts.** Default: off at each launch, with a one-click **Resume
   lending**. The alternative is to remember it, which is more convenient and means a laptop
   opened in the morning is lent before its owner has thought about it.
3. **Whole agent sessions on a device.** Default: not in this version. A session there would run
   the person's own Claude Code against their files with a hosted thread steering it, and its
   permission prompts would have to be answered on the machine and nowhere else. It needs its
   own design and review.
4. **Workers.** Default: only the thread the person writes to. Letting a worker the orchestrator
   spawned in that turn inherit the device is natural for Gram, and stretches "a turn the person
   started" over hours of unattended work; it wants an expiry and its own mark on the ask.
5. **Confinement by the operating system.** Later: run commands under the platform's sandbox
   (Seatbelt on macOS, Landlock or bubblewrap on Linux) so the folder list becomes a real
   boundary, with the network off unless the folder allows it. This is what would make a
   "don't ask in this folder" rule defensible.
