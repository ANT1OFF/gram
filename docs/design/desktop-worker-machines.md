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

No HTTP route is added for it: only the app's main process, which started the server, can hand it a
relayed connection. Even so, it can only hand over a dial signed by a key the desktop registered,
for the server that key came through, once. The app reads nothing of the frames but the first,
which must be exactly the host's four dial headers.

If the machine isn't online within five minutes, the desktop asks `…/stop`, forgets the name, and
the spawn fails with "The machine worker-… didn't join within 5 minutes, so it was stopped". No
machine is left running for a spawn that failed. A server that says the machine failed or stopped
(`phase: "failed"`) ends the wait at once with its own words.

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
is cut to length and shown as data, as the embedded provider's answers are.

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
