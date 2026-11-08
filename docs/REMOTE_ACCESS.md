# Phone access over Tailscale

[Up: development](DEVELOPMENT.md)

Gram can serve its web app through Tailscale Serve to a browser on your own phone. It is the same
server, database, threads and agent processes as the desktop app, with the desktop layout; there
is no native mobile app. Remote access is off until it is turned on from phone access settings
(the local `/remote/enable` endpoint below) or `GRAM_REMOTE_ORIGIN` is set; the variable wins.

## Trust and authentication

The server always listens on `127.0.0.1`. Either way it accepts exactly one remote origin.
`GRAM_REMOTE_ORIGIN` allows exactly one
canonical `https://device.tailnet.ts.net` origin, optionally with a port. It must
have no trailing slash, path, query, credentials, fragment, wildcard, uppercase or
explicit default port. Invalid configuration stops startup; absent means off.
The name is configuration, not proof of private transport: use only tailnet-only
HTTPS Serve, never Funnel, a public proxy or a LAN listener. Restrict your tailnet
policy to your intended devices/users before enabling it.

### Turned on from settings

Without `GRAM_REMOTE_ORIGIN`, the local app switches access through the Tailscale CLI
(`tailscale` on PATH, Homebrew's, or the one inside the Mac app), never through a shell:

- `tailscale status --json` must report the backend running, this machine's `.ts.net` name and
  an HTTPS certificate domain for it. Otherwise turning on is refused with what to do: install
  Tailscale, sign in, connect, or turn on HTTPS certificates for the tailnet.
- Gram adds only its own HTTPS listener, `tailscale serve --bg --https=<port>
  http://127.0.0.1:<loopback port>`, on the port asked for or the first of 9443, 9444, 9445,
  9446 and 8443 that `tailscale serve status --json` shows free. A port that another listener
  holds, or that Funnel shares, is refused. Gram never runs Funnel, `serve reset`, or anything
  that touches another listener.
- The setting is `<dataDir>/remote-access/serve.json` (`version`, `enabled`, `port`, `target`), private
  like the pairings. The origin is `https://<name>.ts.net:<port>` (no port for 443).
- Each launch gets a new loopback port, so Gram removes its listener when the server stops and
  adds it back, pointed at the new port, when it starts. A crash leaves a listener pointing at a
  dead loopback port until the next start re-points it; another program that later takes that
  port would be reachable from the tailnet meanwhile, so turn access off before uninstalling.
  Gram saves the exact target it points its listener at before asking Tailscale, and only a listener with that one `/` proxy and no other handler counts as Gram's; startup re-points only that one, and anything else on the saved port leaves access off with a problem the status reports.
- Turning off removes that listener (only while it is still Gram's alone), even when saving the setting fails, closes every open
  remote connection and keeps the pairings. The remote cookie is named after the Serve port, so
  pairings survive restarts on a new loopback port.

With `GRAM_REMOTE_ORIGIN` set, Serve stays the user's to configure, as below, and turning on or
off is refused with a message naming the variable. Listing and removing browsers still work.

Host and Origin checks remain in front of authentication. Forwarded host/protocol
and Tailscale identity headers grant no trust. Forwarding headers refuse local
authority even when a raw proxy client spoofs a loopback Host; the supported Serve
proxy always adds these headers. A Funnel marker is also refused. Do not strip
forwarding headers on the proxy. Remote WebSockets require the exact
configured Origin and a valid remote cookie. All remote app assets and RPC upgrades
need that cookie. Remote `/mcp`, local boot-token exchange and pairing minting are
refused even with a remote cookie. The server's normal RPC, provider/scope helper
consent, subscription credential isolation, app-tool approvals and owning-child
EXIT fences still apply. Pairing grants full browser control of this Gram instance;
it is not a restricted observer role and does not grant new native shell capability.

Authentication uses the same pinned path matcher as the HTTP router to detect
aliases of `/`, `/ws`, `/mcp` and all three pairing paths, then requires each
protected path's canonical spelling. Case, escaped letters, duplicate/trailing
slashes and semicolon aliases are refused with 403, including when authenticated.
Malformed escapes/UTF-8, raw authority/absolute targets, backslashes, fragments,
control characters and literal dot-segment paths also fail closed. A `boot` query
parameter is only legal at the canonical root locally and is refused on every
remote path, including the otherwise unauthenticated pairing bridge/exchange.
Ordinary encoded data/asset paths remain supported. New credential endpoints must
join the shared protected-path registry; do not add literal-path guards independently.

An already authenticated **local** browser can POST `/remote/pair` with its allowed
local Origin. The response is `{ url, expiresAt }`, where `expiresAt` is Unix
milliseconds. With eight browsers paired it answers 409 `{ reason: "full", max: 8 }`
instead of minting a link. A new invitation replaces the previous outstanding one. Each link
has 256 random bits, lasts 15 minutes and can be consumed once, including concurrent
claims. Its secret is in `/remote/connect#pair=…`, never in an HTTP request URL.
The self-contained bridge removes the fragment using `history.replaceState`
before POSTing the secret to `/remote/claim`; it then replaces the navigation with
`/`. The bridge has a hash-pinned script CSP, no assets/analytics, no-store and
no-referrer headers. Do not add request-body logging or capture/share pairing pages.

The link remains a temporary bearer capability: clipboard managers, link sharing,
browser extensions, screen recording or browser history sync before script execution
can retain it. Send it only to your own phone through a trusted channel. A stolen
unused link can pair a different browser until expiry or replacement. The scheme
requires explicit local minting and exact same-origin POST exchange; a foreign form
cannot mint or claim. It refuses to replace an already authenticated remote session,
so an incoming link cannot swap its cookie. There is one Gram authority/database,
not a separate remote account selected by the link.

The remote session cookie is separate from the desktop boot token, uses the
`__Host-` prefix, Secure, HttpOnly, SameSite=Strict, Path=/ and no Domain. Up to
eight browser sessions are admitted with no automatic eviction. Sessions last up to
one year, and the cookie has a matching persistent Max-Age. Restarting Gram retains
paired browsers; invitations remain memory-only and expire after 15 minutes.
Only SHA-256 hashes of random session secrets and expiry times are saved in
`<dataDir>/remote-access/`, in origin/port-bound files with private permissions and
atomic writes. Corrupt or insecure storage refuses startup rather than discarding
trusted devices silently. Browser data clearing, expiry or revocation requires
pairing again.

Cookies are scoped to the hostname, **not the HTTPS port**: other HTTPS services
on that same `.ts.net` host can receive the cookie. Use only a hostname whose
services you trust; use a dedicated tailnet node/name if other services have
different owners. A different port and the cookie-name suffix do not isolate a
compromised sibling service. Removing a browser cookie logs that browser out but
does not revoke a copied cookie.

### Managing access

These endpoints are answered by the authentication middleware itself, are in the
protected-path registry, and take only POST with an Origin header, so a page on another
origin can neither read nor forge them. Request bodies are JSON of at most 256 bytes.

| Path                                         | Local app (launch cookie)                        | Paired browser                                           |
| -------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------- |
| `/remote/status`                             | The status below                                 | The status without `pairing`, plus `current`, its own id |
| `/remote/pair`                               | A pairing link, or 409 when full                 | 403                                                      |
| `/remote/enable` `{ port? }`                 | Turns access on; 409 `{ message }` when refused  | 403                                                      |
| `/remote/disable`                            | Turns access off; 409 under `GRAM_REMOTE_ORIGIN` | 403                                                      |
| `/remote/revoke` `{ id }` or `{ all: true }` | Removes that browser, or all of them             | Only `{ id }` of itself, which also expires its cookie   |

The status (`RemoteAccessStatus` in `@gram/contracts`) is the mode (`off`, `on` or `env`),
what Tailscale reported, the port, the origin while on, the paired browsers, the newest
pairing link's state (`waiting`, `paired` with the device id, or `expired`) and any problem.
Each browser has an id (the first 16 hex digits of its session hash), a name such as
"iPhone · Safari" picked from a fixed list by its user agent at pairing (the user agent itself
is never stored), when it paired, the hour it was last seen and when it expires.

Removing a browser deletes its session hash at once (in memory first, so it holds even if saving fails; the answer is then a 500 saying it comes back at restart), so its next request gets 401, and closes
its open WebSocket connections. Removing all does the same for every browser. These need the
server running; with it stopped you can still back up the data directory and remove only
`<dataDir>/remote-access/`, then restart and pair again. Never reset storage while a server is
running. Unsetting `GRAM_REMOTE_ORIGIN` stops remote access but does not delete saved pairings.

## Set it up

Run one Gram: don't start a second server against the same data directory, and keep the
data directory you already use (`GRAM_DATA_DIR`, if you set one).

1. On the Mac running Gram, check `tailscale status` and `tailscale serve status --json`.
   Leave existing Serve handlers and occupied ports alone. Pick a free HTTPS port (for
   example 9443, if unused) and note the host's `.ts.net` name. HTTPS must be enabled for
   the tailnet, and the phone needs Tailscale connected with a policy that lets it reach
   this device and port.
2. Quit Gram and start it with `GRAM_REMOTE_ORIGIN` set to that origin. A packaged app
   serves its own renderer and passes its environment to the server:

   ```sh
   GRAM_REMOTE_ORIGIN=https://device.tailnet.ts.net:9443 /Applications/Gram.app/Contents/MacOS/Gram
   ```

   A Finder or Dock launch doesn't carry your shell's environment. From a development
   checkout, build the renderer first (`bun run --filter @gram/web build`), since the
   development server otherwise serves only the API and WebSockets:

   ```sh
   GRAM_REMOTE_ORIGIN=https://device.tailnet.ts.net:9443 \
   GRAM_WEB_ROOT=/absolute/path/to/checkout/apps/web/dist \
   bun run dev:desktop
   ```

3. Find the loopback server port in the startup log, without copying its boot URL, and add
   only the Serve listener you chose:

   ```sh
   tailscale serve --bg --https=9443 http://127.0.0.1:4317
   tailscale serve status --json
   ```

   Substitute the actual loopback port; don't proxy Vite. Serve must preserve the external
   Host and Origin. Don't rewrite headers, disable checks, enable Funnel or use `serve reset`.
   See Tailscale's [Serve command reference](https://tailscale.com/docs/reference/tailscale-cli/serve)
   and [Serve guide](https://tailscale.com/docs/features/tailscale-serve).

4. From the authenticated **local** Gram window's developer console, create a pairing link
   with the existing cookie (in development, the Vite proxy forwards only the local management endpoints):

   ```js
   const pairingResponse = await fetch("/remote/pair", {
     method: "POST",
     credentials: "same-origin",
   });
   if (!pairingResponse.ok) throw new Error("Pairing unavailable");
   copy((await pairingResponse.json()).url);
   ```

   `copy` writes the link to your clipboard without printing it. Send it privately to your
   own phone and open it within 15 minutes. Clipboard history and extensions are inside the
   trust boundary above; never paste the link into a shared chat or a log. The plain base URL
   returns 401 before pairing. After pairing, use the base URL or a thread URL; the pairing
   link can't be reused. Never put a desktop `?boot=` token into the remote URL. A 403
   "pairing unavailable" means `GRAM_REMOTE_ORIGIN` isn't set for the running server.

5. Check that the unpaired base URL gets 401, that pairing removes the fragment, and that the
   phone reads an existing thread and reconnects its WebSocket. Only a check from the phone
   shows that the phone can reach Gram.

To stop exposure, remove only the listener you added:

```sh
tailscale serve --https=9443 off
```

Then quit Gram and start it with `GRAM_REMOTE_ORIGIN` unset. Removing the listener doesn't close
sockets already upgraded; quitting the server does. To invalidate saved pairings, reset them as
described above. Leave unrelated Serve listeners, databases, credentials and installed
applications alone.

## Other machines

The same tailnet address lets another Mac or Linux machine join and run Gram's work. See
[other machines](MACHINES.md).

## Tests

`bun run test packages/server/src/http/auth-target.test.ts packages/server/src/http/remote-access.test.ts packages/server/src/http/remote-control.test.ts packages/server/src/http/remote-sessions.test.ts packages/server/src/http/auth.test.ts packages/server/src/http/server.test.ts packages/server/src/config.test.ts`
checks validation, expiry, replay/races, CSRF/session swapping, header spoofing,
cookie separation, static assets, MCP refusal, socket upgrades, listing and removing
browsers (including closing a removed browser's open socket), and turning Serve on and
off against a synthetic Tailscale CLI that holds other listeners. The socket
regression sends raw case/percent/slash/semicolon aliases through actual HTTP and
WebSocket routing, plus malformed encodings and noncanonical boot requests.

`bun run --filter @gram/web e2e:real mobile-access.spec.ts` builds the current web
and server bundles, runs the existing disposable harness with explicit fake agent,
synthetic GitHub state and temporary homes, and exercises a 390 × 844 browser
through a loopback HTTPS reverse proxy with an invented `.ts.net` origin. Its
self-signed certificate is temporary; certificate bypass applies only to that
isolated browser test. It sends echo turns, reads a thread, reconnects and checks
fragment removal, request URL secrecy and replay/session-swap refusal. It never
changes Tailscale configuration or uses the user's application data. This is not
real-phone, real tailnet policy, production certificate or paid-provider acceptance.
