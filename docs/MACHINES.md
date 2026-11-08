# Other machines

[Up: remote access](REMOTE_ACCESS.md)

Another Mac or Linux machine can join your Gram and run its work: its checkouts, git, terminals,
ports and Claude sessions. The machine you already use keeps Gram's threads, decisions and
settings; the other machine runs `gram-host`, which dials it over Tailscale. The joined machine
opens no port of its own.

This is the first part of multi-machine support. A machine can join, be confirmed and stay
connected. Placing a worker on it comes with the Machines page and the machine picker.

## What you need

- Tailscale on both machines, in the same tailnet, and phone access over Tailscale turned on in
  Gram on the main machine ([phone access](REMOTE_ACCESS.md)). The joined machine dials the same
  `https://<device>.<tailnet>.ts.net` address a paired phone opens.
- Node and a Gram checkout on the new machine, for now, until `gram-host` ships as its own
  download. Sign Claude Code in there (`claude /login`) for its sessions.

## Join a machine

1. On the main machine, make a join link: Settings → Machines → Add a machine (the local
   `POST /machines/join-link` endpoint). It lasts 15 minutes and works once.
2. On the new machine, run:

   ```sh
   node packages/server/src/host/main.ts join '<join link>'
   ```

   `--name <name>` sets the name it joins with (its host name by default), and `--no-service`
   leaves out the background service.

3. It prints the machine's fingerprint. Check it against the one the main machine shows for the
   new machine, and confirm it there (`POST /machines/confirm`). Until it is confirmed the main
   Gram refuses its dials, so a stolen link can't add a stranger's machine unnoticed.

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
- **Not a browser.** The join and dial endpoints answer only on the tailnet address, never on
  loopback, and refuse any request with an `Origin`, so no web page can reach them. They take no
  browser cookie, and a browser's cookie grants nothing there.
- **Removing a machine** (`POST /machines/remove`) forgets its key and closes its connection at
  once. Up to 16 machines can be joined.

The listing (`POST /machines/list`), join link, confirm and remove endpoints answer only the local
app, never a paired phone or a joined machine, with the same Origin rules as phone access settings.
