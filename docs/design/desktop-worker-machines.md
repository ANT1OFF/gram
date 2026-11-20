# Workers of a desktop orchestrator on a hosted server's machines

[Up: other machines](../MACHINES.md) · [Embedding](../EMBEDDING.md#workers-own-machines) ·
[Lending this machine](personal-device.md)

Status: design, November 2026. Behind the hosted-features setting (`experimental.embedding`), like
every hosted call the desktop app makes.

An orchestrator in a Gram that runs embedded in a hosted server can give a heavy worker a machine
of its own (`spawn_worker`'s `sandbox`, [embedding](../EMBEDDING.md#workers-own-machines)).
The desktop app can be signed in to such a server, to send whole tasks there
([personal device](personal-device.md)), but its own orchestrator can't ask that server for a
machine: `sandbox` is refused with "Workers can't have machines of their own here". This note
covers that: with the app signed in to a hosted server that offers it, the desktop orchestrator's
`sandbox: {own: true}` (or `shareWith`) asks that server for a worker machine owned by the
signed-in person, the machine joins the desktop Gram as a remote host, the worker's worktree and
session run there, and the machine is released when the worker's work is over.

## 1. The pieces that exist

| Piece                        | Where                                                                 | What it does today                                                                                                           |
| ---------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `sandbox` on `spawn_worker`  | `orchestration/tools.ts` `workerSandbox`                              | Resolves picks against the provider's choices, asks for the machine, waits for it to join, places the worker by name.        |
| The provider                 | `embedding/on-demand.ts` `OnDemand`                                   | An `OutsideService` (URL and bearer token) from `GRAM_HOST_PROVIDER_URL`: only when Gram runs embedded.                      |
| Asking for a worker machine  | `embedding/worker-machines.ts`                                        | `POST /hosts/start` `{kind: "worker", owner, name, …}`; 409 over the person's total, 403/404 off.                            |
| Joining                      | `http/machine-routes.ts` `/machines/provision`, `host/provisioned.ts` | The provider registers the host's public key; the host dials the Gram's provisioned-host listener (TLS, public).             |
| Release                      | `embedding/worker-machine-release.ts`                                 | Every ten minutes, `POST /hosts/release` for a worker machine with no worker left at work.                                   |
| The desktop's sign-in        | `shell/modules/device/hosted.ts`                                      | OAuth with PKCE, refresh token in the keychain, a DPoP-bound access token narrowed per scope, held by the main process only. |
| The server's door to the app | `embedding/sent-work-port.ts`                                         | The desktop's Gram server (a utility process) asks the app over `parentPort`; the app makes the call with the sign-in.       |

Two things are missing on the desktop: a provider (there is no `GRAM_HOST_PROVIDER_URL`, and the
desktop's server holds no token), and a way in for the machine (the desktop is behind NAT, and its
joined machines dial it over Tailscale, which a hosted machine isn't on).

## 2. A second provider source: the sign-in

The orchestrator's `sandbox` code stops talking to `OnDemandHosts` directly. It talks to a
**worker-machine provider** with four calls (choices, start, status, release, plus stop) and a rule
for which joined machines are its own. There are two:

- **Embedded** (unchanged): `OnDemandHosts` over `GRAM_HOST_PROVIDER_URL`, naming the orchestrator
  host's owner in each call, as now.
- **Signed in** (new): the desktop app, over the same `parentPort` door `send_worker` uses. The
  server asks; the app makes the call to the hosted server with the person's sign-in and answers.
  The server never holds a token, and names no owner: the hosted server takes the person from the
  token.

Embedded wins where both could apply (a headless Gram has no desktop app, so in practice they never
meet). With neither, `sandbox` is refused as today, and the refusal now says how to get one:
"sign in to a hosted server that offers worker machines, in Settings → Machines → Hosted servers".

The hosted server says it offers worker machines in its discovery document, with two optional
fields, both or neither, on its own origin like every other address:

```json
{
  "worker_machines_endpoint": "https://gram.example.com/api/worker-machines",
  "worker_machine_connect": "wss://gram.example.com/api/worker-machines/connect"
}
```

and the app asks for one new scope, `machines:workers`, only of a server that names both. A person
signed in before the server offered it is told to sign in again; nothing is asked for silently.

The calls, each `POST` with a DPoP-bound `machines:workers` token, the person taken from it:

| Call        | Body                                   | Answer                                                                                                 |
| ----------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `…/choices` | `{}`                                   | The provider's choices, as `/hosts/choices` answers them (size, architecture, isolation, environment). |
| `…/start`   | `{name, title, orchestrator, choices}` | 202 `{name}`; 409 over the person's total (the body `/hosts/start` gives); 403/404 off.                |
| `…/status`  | `{name}`                               | `{phase, message?, publicKey?, platform?}`: the host's public key once it has made one.                |
| `…/release` | `{name, released, reason}`             | As `/hosts/release`.                                                                                   |
| `…/stop`    | `{name}`                               | The machine is stopped and reclaimed; used when it never joins.                                        |

Which of the person's workspaces there the machine is started under, and so whose limits and
choices apply, is the server's to decide from the sign-in; `…/choices` says which (`workspace:
{id, name}`). With several servers signed in, the first that offers worker machines is asked.

`…/choices` may also list the models the server's machines run, as `models: [{ agent, id,
resolvedId?, label? }]` (`opus` running `claude-opus-…`, say): their model access is the server's.
Before any machine is asked for, `spawn_worker` resolves the worker's model as the spawn will
(the named one, else the charter's default), and refuses a model not on that list, by id or the id
an alias runs, or one through a gateway profile, with the list in its words: "Example's worker
machines don't run claude:opus, so no machine was asked for. They run …". A worker is never started
on another model than it asked for without saying so. A server that lists no models leaves it to
the machine's host, which reports what it runs once it joins, as any joined machine's does; a spawn
refused then, after its machine came, gives the machine back (`…/stop`) rather than leave it
running.

So the sandbox choices (size, architecture, isolation, environment) are the server's, as when
embedded, and the same pick resolution (`resolveWorkerPicks`) and over-total words apply. The
server keeps a 404 for a server that has none of this: the desktop then says the server doesn't
offer worker machines, and the worker isn't spawned.

## 3. How the machine joins: it dials the server, the app dials the server, the server pipes

The desktop is usually behind NAT and listens on nothing public, so the hosted machine can't dial
it. Nor does it join the person's tailnet: that would need a tailnet key on a machine the person
doesn't run. Both sides dial out instead, to the hosted server, which pairs the two connections
and copies frames between them:

```
 hosted machine (gram-host) ──wss──▶  hosted server  ◀──wss── desktop app (main process)
   signed dial for the                 pairs by machine          DPoP-bound machines:workers
   server's origin                     name and owner            token, ?name=worker-…
                                                                    │
                                                                    └─frames over parentPort─▶ desktop Gram server
                                                                       relayed dial, checked as any dial
```

1. The desktop's server picks the machine's name (`worker-` and ten hex, from the orchestrator and
   the spawn's `clientRequestId`, as now) and asks `…/start`.
2. The hosted server starts the machine for the signed-in person. Its `gram-host provision` makes
   the host's key on the machine, for the origin `https://<the hosted server>`; the host's id is
   derived from that key (`hostIdOf`), as for every provisioned host.
3. The desktop's server polls `…/status` until it carries the host's public key, then registers the
   machine **itself**, in its own `machines.json`, as a provisioned host of kind `worker` that came
   through that server (`via: <origin>`). Nothing on the server can register a machine on the
   desktop: the desktop asks for a name, and takes a key only for that name, from the server it
   asked.
4. The app opens `worker_machine_connect?name=<name>` with its token, and the host dials the same
   server. The server pairs the two only when the app's person owns that machine, then sends the
   app the host's signed dial headers as the first frame and copies every frame after it, both
   ways, unchanged.
5. The app passes those headers to its own Gram server over the `parentPort` the server already
   asks it through (`machines.relay.dial`), then each frame both ways (`machines.relay.frame`,
   `machines.relay.end`). The server makes a socket of them and checks the dial exactly as any
   dial: the machine's own signature over the origin it was registered through, a fresh nonce, the
   clock. A machine registered through one server is taken only from that server's relay; one
   joined or provisioned another way is never taken on it.
6. The machine is online. The worker is placed on it by name, as an embedded worker is, and its
   worktree and session run there.

**App tools go over the host's own connection.** A session on a joined machine reaches its
thread's app tools at `<the address it dialled>/host/mcp`; a relayed machine dialled the hosted
server, which can't answer for the desktop. So for a relayed machine the desktop asks its host to
serve `/host/mcp` on the machine's own loopback (`host.appTools.open`, the `app-tools-tunnel`
feature), gives its sessions that address, and answers each call the host carries back over the
connection (`host.appTools.requests`, `host.appTools.answer`) from its own app-tools endpoint, as a
session on the desktop calls it. Those calls are answered on every connection the machine dials in
on, a redial's included, from the moment it comes online, whether or not anything here has asked
for the machine since. The desktop lets a call through only with a token issued for a
thread whose session is on that machine, as it does for a call over the tailnet; the host takes
only a call to its own loopback address with no `Origin` and nothing a proxy adds, and its address
must be `http://127.0.0.1:<port>` for the desktop to use it. The hosted server
relays these calls as host frames and serves no app tools; a relayed machine is never given the
hosted server's address for them, so no thread's token goes there. A host that doesn't name `app-tools-tunnel` (an older
`gram-host`) is refused as soon as it joins, in words that say so, and given back; a session on one
already registered is refused the same way rather than waited on as if the machine were offline.

No HTTP route is added for it: only the app's main process, which started the server, can hand it a
relayed connection. Even so, it can only hand over a dial signed by a key the desktop registered,
for the server that key came through, once. The app reads nothing of the frames but the first,
which must be exactly the host's four dial headers.

If the machine isn't online within five minutes, the desktop asks `…/stop`, forgets the name, and
the spawn fails with "The machine worker-… didn't join within 5 minutes, so it was stopped". No
machine is left running for a spawn that failed. A server that says the machine failed
(`phase: "failed"`), or stopped before its host joined, ends the wait at once with its own words.
One stopped after its host joined (`phase: "stopped"` with its key) is registered all the same,
and started again as below.

**No dial wakes a machine there.** A relay's dial only keeps a running, unreleased machine at
work. One the server says is paused (`phase: "stopped"`, stopped while idle) or failed stays so
until this Gram sends `…/start` for its name, which wakes it on its own disk. So the desktop sends
that start itself whenever work here needs the machine:

- **A worker resumed on it, or a message to one,** opens a session there, which waits for the
  machine (`stops.wanting`). Each time an offline relayed machine comes to be wanted, the desktop
  reads its `…/status` and, only if that says stopped or failed, sends `…/start` with `{name}`
  alone (the server keeps what it was started with). A name the server doesn't say is stopped or
  failed is never started, so one it no longer knows is never made afresh.
- **A spawn reusing it** does the same as it waits: started once; failed again after that start,
  the spawn is told at once in the server's words.
- Each wake is the spawn's start: the name's lock, a release taken back first, a `503` asked again
  a few times. Nothing else starts a machine: never a dial, a relay, or a pass.

A machine registered here that the server says is stopped or failed isn't relayed while it is
(a failed one is said once in the log): it stays registered, since it may hold an earlier spawn's
work, and a wake or a start of its name relays it again.

A start answered `503` (`busy` or `unavailable`) started nothing: it is asked again after two
seconds, then four, three times in all, and then refused as the server unavailable, never as over
the total or gone, with nothing to give back.

## 4. Who owns and pays for it

The machine is the signed-in person's on the hosted server, started under their account and their
organisation's limits, and counted against the same total as worker machines their hosted
orchestrators ask for. The server's 409 says what is in use, and the orchestrator is told as it is
when embedded. The desktop never names an owner; the server takes it from the token, so the desktop
can't start a machine for anyone else.

On the desktop, the machine is the desktop's, like any joined machine: open to its orchestrators,
never anyone's default, placed on only by `spawn_worker`'s `sandbox`. Its model access is the
hosted server's, as for that server's own worker machines: the desktop never sends it the person's
Claude or Codex sign-in. The existing per-machine sign-in (Settings → Machines) stays the only way a
subscription token reaches a machine, with its own consent.

## 5. Release, an expired sign-in, and a sleeping desktop

- **No card of its own.** A spawn that starts a new machine on the hosted server raises no approval
  card beyond the spawn's usual ones: the person's sign-in with the `machines:workers` scope is the
  consent, and the server's own limits and total bound what it may start.
- **Only once the spawn goes ahead.** The machine is asked for in the tool's handler, after any
  approval card, so a denied or refused spawn starts nothing. One that came for a spawn that is
  then refused, held or interrupted is given back (`…/stop`); a start that got no answer is given
  back too, since the server may have started it. A stop is tried three times; one that never
  succeeds leaves the machine registered here, so the release pass still tells the server, and the
  orchestrator is told it wasn't confirmed.
- **The relays follow the registry.** The desktop's server tells the app the whole list of machines
  to carry (`relays`): at start (`fresh`, so every connection carried for a server that has since
  restarted is dialled again), on every change of its machines (a removal under Settings stops its
  relay), and every minute besides. The app keeps that list even while its sign-in is still being
  restored, and dials each once the sign-in covers it. A machine the server no longer knows
  (`…/status` 404, reclaimed after its release) is forgotten, so relays never pile up; past 32
  relayed machines a new one is refused with what to remove.
- **Revocation.** Signing out, the sign-in ending, or hosted features turning off closes every live
  relay the sign-in no longer covers, at once and in a check every 30 seconds; none dials again
  until it is covered. Each live relay holds a lease besides: every five minutes the app asks the server for a
  `machines:workers` token never handed out before, so a sign-in that expired or was revoked on
  the server ends its relays within that long, whatever token is cached. The server is still
  the one that enforces it: a relay it carries is one it may end itself.
- **Stops owed.** A stop the server never confirmed, for a machine never registered here, is kept
  (`worker-machine-stops.json`, beside the machines) and asked again every ten minutes until it is.
  When the start's outcome wasn't known (no answer, or a spawn stopped while it was on its way), the
  server's "no such machine" (a 404, or a 2xx with `stopped: false`) settles nothing for fifteen
  minutes, since the start may still make it. A start and a stop of one name never overlap here:
  a give-back keeps the name through every attempt of its stop, and half a minute more after one
  no one answered, so a retry's start of that name goes out only after it.
- **A machine in use is never given back.** A spawn that fails or is interrupted after its machine
  came gives the machine back only if no open thread is placed on it: not its own worker made
  before the failure, and not another worker sharing it. A name a later start takes, or one registered here since, is that start's: no stop owed for
  an earlier one ever ends its machine.
- **Release across a restart.** The release pass keeps what it told in memory only, so after a
  restart it tells each machine at work that it is working, once, in case the server still holds
  a release from before; a machine just back online is told so at once, and only a verdict that
  its work is over waits for it to settle. A release counts as told only once the server applied
  it (not a 404, nor a 2xx saying it knows no such machine), so one that wasn't is told again.
- **A machine the server no longer knows** is forgotten here after three passes in a row answer
  404, since the same answer comes while its workspace is out of reach for a while.
- **Reusing a machine.** A machine a spawn reuses (one an earlier spawn of the same id left
  registered, or one it shares that is offline) is told it is working (`released: false`) before
  it is waited for: one released once its work was over sleeps until then.
- **A machine still released.** A start answered `409 { code: "released" }` takes the release
  back (`released: false`) and asks once more, never again. A take-back answered `404` (the
  release is already due for reclaim) spends the name as a reclaimed one, below, and asks
  nothing again under it. A release answered
  `404 { code: "not_found" }`, a take-back's too, is a machine reclaimed there, forgotten here; a
  `503` is asked again after a wait.
- **A reclaimed name.** A start answered `409 { code: "name_in_use" }` (the name was a machine's
  the server has since reclaimed) is refused once, saying to spawn with another
  `clientRequestId`; it is never asked again, nor read as being over the total.
- **A retry of the same spawn.** A machine registered here before the try (an earlier spawn of the
  same `clientRequestId`) is waited for but never stopped by that try, however long it stays
  offline: it may hold the earlier spawn's work. Only a machine a try started is given back.
  Each try holds its machine's name until its spawn is over, and only the first try to hold it
  starts the machine or gives it back: a retry that comes while that try is still at work (a
  reconnect, a tool call tried again) waits for its machine and, refused or cancelled itself,
  stops nothing. A first try whose spawn fails while such a retry waits leaves the machine to it,
  and to the release pass should it not place a worker either.
- **A lost workspace role.** Every call about a machine whose workspace the person no longer has
  a role in is answered `404 { code: "not_found" }`, and its relay's handshake is refused: read
  as the machine gone wherever a call is made for it, and forgotten by the pass above.
- **A nonce for each dial.** A WebSocket's handshake can't answer a DPoP nonce challenge the app
  can read, so before each dial of a relay the app makes one call to the server's worker-machine
  endpoint, which takes the challenge and keeps the nonce, and signs the dial with it.
- **A call hung up on.** A session on the machine that gives up on an app-tool call (its
  connection closed) has the host say so over the connection, and the desktop stops answering it,
  as it does a session that hangs up on its own endpoint.
- **Held briefs.** A worker on a machine from a hosted server isn't held: its machine would be
  stopped, or released once its other work is over, before the brief ran. A spawn that would be is
  refused with when to spawn again; its brief is let go first, then a machine started for it given
  back (a shared one stays), whatever interrupts them. An embedder's machines are kept by their
  provider, so a brief held there (by a limit or the spawn breaker) stays held, as before.

- **Release** is `worker-machine-release.ts`'s pass, run against whichever provider there is: a
  worker machine with no worker left at work is told released (`…/release`), and told again,
  `released: false`, if one is at work there again. The server pauses and reclaims it as it does
  its own.
- **The app quits or the desktop sleeps.** The relay closes; the machine shows offline, as a joined
  machine whose network went. The host dials the server again by itself (`dialForever`), and the
  app dials the relay again for every relayed machine still registered when it starts or wakes, so
  the two meet again. A session whose machine is gone past the usual grace is ended as for any
  joined machine.
- **The sign-in expires or the person signs out.** New spawns with `sandbox` are refused with
  "sign in to <server> again". Relays can't be dialled again; the machine stays offline here. The
  server's own idle reclaim takes it back, as it does a hosted orchestrator's machine nobody
  released. Nothing is kept on the desktop that could start or reach a machine without a sign-in.
- **The desktop's Gram server restarts.** The machines are in `machines.json`; it asks the app to
  relay each again.

## 6. Trust boundaries

**The hosted machine gets no more than a joined machine.** It is a provisioned host speaking the
ordinary host protocol: what the desktop sends it is what it sends any joined machine for a worker
placed there (the worktree, the session, the thread's app tools over the host connection). It is
placed on only by name, by an orchestrator's `sandbox`, and is never a default. It gets no
subscription token. The hosted server relays its connection and so sees the traffic, but it runs the
machine and so sees everything on it already: relaying adds nothing it couldn't see. A server that
impersonates the host is a malicious host, which the desktop already treats a joined machine as
able to be.

**The desktop gets no more than the person may do on the server.** Every call is the person's,
with a token narrowed to `machines:workers` and bound to the device key, and the server checks each
one: whether worker machines are on for them, their total, which choices they may pick, and that a
relay is opened only by the machine's owner. The desktop names no owner and can't reach another
person's machine.

**The desktop's server holds no credential.** It asks the app, which holds the sign-in as for every
other hosted call. No new long-lived credential is written: the refresh token is the existing one
in the keychain, with one more scope; the machine's public key in `machines.json` is not a secret.
Tokens and dial headers are never logged.

**Untrusted text stays text.** What the server answers (choice labels, refusals, status messages)
is cut to length and shown as data, as the embedded provider's answers are. The app passes on only
the fields each answer is read for, so a token a server echoes never leaves the app, and logs keep
statuses, never a server's words. The server's name reaches the orchestrator's prompt as one plain
line of at most 60 characters.

**A model is never swapped.** A worker on a machine from a hosted server runs the model it was given
or none: a named model the machine doesn't run is refused, not replaced with another the roster
has, and a pin on one model's own id (`claude-opus-5-5`) is refused where the machine's alias of
the model to launch runs another. An embedder's machines keep their roster fallback.

## 7. What a server needs

A server that wants this offers the two discovery fields, the `machines:workers` scope, the five
calls and the relay, and starts the machine's `gram-host` provisioned for its own origin
(`gram-host provision --origin https://<server>`), so the host dials `wss://<server>/host/connect`,
where the server takes the host's side of the relay. Its own rules for worker machines (whether
the organisation allows them, the person's total) apply as for its hosted orchestrators; a rule
that only makes sense there, such as needing the person's own hosted machine running, is the
server's to relax for a desktop's ask or not. Until it does, the desktop refuses `sandbox` with the server's name and
"doesn't offer worker machines". Nothing on the desktop depends on how the server runs machines.

## 8. Where it is built

| Piece                                     | Where                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| Discovery fields, the scope, the calls    | `contracts/src/device.ts`, `shell/modules/device/hosted.ts`            |
| The app's answers and the relay           | `shell/modules/device/serve-machines.ts`, wired in `apps/desktop`      |
| The server's door, the provider, the dial | `server/src/embedding/signed-in-workers.ts`                            |
| One provider shape for both sources       | `server/src/embedding/worker-machines.ts` (`WorkerMachineSource`)      |
| A relayed host                            | `PairedMachine.via`, `DialRoute` `relayed` (`host/paired-machines.ts`) |
| Release                                   | `embedding/worker-machine-release.ts` (`releaseTeller`)                |
| The orchestrator's prompt                 | One line on `sandbox`, only where a provider offers it (`prompt.ts`)   |

## 9. Tests

- Signed in, `sandbox: {own: true}`: the machine is asked for, registered from its status, its
  relayed dial is taken, and the worker is placed on it.
- Not signed in: today's refusal, naming the sign-in.
- A machine that never joins: the spawn fails with the timeout's words, and `…/stop` is called.
- Release: a finished worker's machine is told released through the signed-in provider.

All with a fake app and a fake server; none starts a real machine.
