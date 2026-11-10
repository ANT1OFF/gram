# Provisioned hosts

[Up: other machines](MACHINES.md)

A provisioned host is a `gram-host` that another system starts and registers, rather than one a
person joins. It is for a Gram that runs as a service: a self-hosted install where a controller
makes a container or VM per piece of work, registers it, and removes it afterwards. It differs
from a [joined machine](MACHINES.md) in how it gets in, and in nothing after that:

|                      | Joined machine                      | Provisioned host                         |
| -------------------- | ----------------------------------- | ---------------------------------------- |
| Who adds it          | A person, with a join link          | A control plane, by the host's key       |
| Confirmed by         | A person comparing fingerprints     | Registering the key                      |
| Dials                | The tailnet address, over Tailscale | A listener of its own, over ordinary TLS |
| Signs each dial with | Its Ed25519 key                     | Its Ed25519 key, the same way            |
| Speaks               | The host protocol                   | The same host protocol                   |
| Updates              | Itself, to the main Gram's release  | Never: whoever started it replaces it    |

Provisioned hosts are one of the hosted features: they are off unless **Hosted features** is on
([Docker](DOCKER.md#hosted-features)), and the listener exists only when its environment is set.
With either missing, Gram behaves as it does without them.

## Turn the listener on

Set these where the server starts. They go together: with only some of them set, the server
refuses to start rather than run half configured.

| Variable                       | What it is                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `GRAM_PROVISIONED_ORIGIN`      | The address hosts dial and sign for: one `https://name[:port]` origin, such as `https://gram.internal:8443` |
| `GRAM_PROVISIONED_TLS_CERT`    | A PEM file: the certificate chain for that name                                                             |
| `GRAM_PROVISIONED_TLS_KEY`     | A PEM file: its private key                                                                                 |
| `GRAM_PROVISIONED_PORT`        | Optional. The port to bind, when it differs from the origin's (a service that maps 443 to 8443)             |
| `GRAM_PROVISIONED_LISTEN_HOST` | Optional. The IP address to bind; every interface (`0.0.0.0`) by default                                    |

The address must be `https:`. Plain `http:` is refused, and so is a tailnet address, which belongs
to joined machines. Gram ends TLS itself, with TLS 1.3 only, so nothing between a host and Gram
sees a dial or what it carries. The certificate and key are read once, when the server starts:
restart it to take a renewed certificate.

The listener is apart from the app's own, which stays on loopback. It answers two things and
nothing else:

- `GET /host/connect`, a registered host's signed dial, as a WebSocket.
- `POST /host/mcp`, a session on such a host reaching its own thread's app tools, with that
  thread's token.

Everything else is refused: the app, its WebSocket, its settings routes, the join route and the
installer aren't served there, and neither is any request for another name than the origin's or
with a browser's `Origin`. So is everything while Hosted features is off, and a host connected
when it is turned off is dropped within a few seconds.

## Provision a host

1. **On the host, make its key.** Nothing is sent anywhere:

   ```sh
   gram-host provision --origin https://gram.internal:8443 --name sandbox-1
   ```

   It prints one line of JSON for the control plane:

   ```json
   {
     "hostId": "m-0123456789abcdef01234567",
     "name": "sandbox-1",
     "platform": "linux",
     "publicKey": "…",
     "fingerprint": "ABCD-…",
     "origin": "https://gram.internal:8443"
   }
   ```

   The private key stays in the host's folder (`GRAM_HOST_HOME`), owner-only, and is never
   printed. Run again with the same address, it prints the same key. A host that joined a Gram
   with a link, or was provisioned for another address or name, refuses until
   `gram-host leave --no-service`.

2. **On the control plane, register the public key.** This is one of the Machines settings
   routes, so only the app on the server's own machine may call it: a `POST` to
   `/machines/provision` with the launch cookie and an `Origin`, like the rest of them.

   ```json
   { "name": "sandbox-1", "publicKey": "…", "platform": "linux" }
   ```

   It answers `{ "hostId", "fingerprint", "created", "origin" }`. Registering the same key again
   changes nothing and answers `created: false`. A key that belongs to a machine that joined with
   a link is refused, so registering never confirms a machine a person hasn't. Up to 256
   provisioned hosts can be registered at once, counted apart from the 16 joined machines.

3. **Start the host.** `gram-host run` dials the address and serves, and dials again whenever the
   connection ends. It trusts the certificates Node does: for one from your own authority, set
   `NODE_EXTRA_CA_CERTS` to that authority's PEM file where the host starts.

4. **Remove it when its work is done:** `POST /machines/remove` with `{ "id": "<hostId>" }`. Its
   connection closes and its key is unknown again.

A registered host is listed in Settings → Machines like any other and takes the same work: a
thread or worker is placed on it by its name or id.

## What registering trusts

Registering a key gives its holder what a confirmed machine has: the work placed on it, with the
repositories and messages that come with that work. There is no second check, so register a key
only for a host you started, and read it from that host over a channel you control.

- **Only a registered key gets in.** A dial names the host and carries a time, a nonce and an
  Ed25519 signature over those and the address. A key nobody registered, a signature by another
  key, a dial signed for another address, a time more than two minutes off and a nonce seen before
  are each refused with `401` before any WebSocket opens.
- **The two ways in don't cross.** A provisioned host's key is taken only on the provisioned
  listener, and a joined machine's only on the tailnet address. On the other, either is as unknown
  as a key never registered. A thread's app-tools token is likewise taken only on the address its
  own host dialled.
- **The host proves itself; Gram proves itself by its certificate.** A host that doesn't trust the
  listener's certificate doesn't connect. Keep the certificate's key private to the server.
- **Network policy is still yours.** The listener is meant for a private network. Gram refuses
  what isn't a registered host's, but which machines can reach the port is up to the network it is
  on.
