# Phone access

Written by the design-brief skill before the first version. Keep it short; it is what the mock is
checked against.

## Problem

To use Gram from a phone today you quit Gram, relaunch it with `GRAM_REMOTE_ORIGIN` set, add a
Tailscale Serve listener by hand, and paste a `fetch` snippet into the developer console to get a
pairing link. There is no list of paired phones and no way to remove one while Gram runs: revoking
means stopping Gram and deleting a folder.

## Who and where

A Gram user with Tailscale on their Mac and their phone. They open Settings → Machines, a new
group. For now it holds only **Phones and browsers**; paired machines join it in the multi-machine
beta.

## Must show

- **Off**, with Tailscale found: the Mac's tailnet name, the HTTPS port Gram will use, and one
  Turn on button. Turning on runs `tailscale serve --bg --https=<port>` for Gram's own listener
  only, never Funnel, and never touches other Serve listeners.
- **Tailscale missing or not ready**: not installed, signed out, or HTTPS certificates off for the
  tailnet, each with what to do.
- **On**: the address phones use, Pair a phone, Turn off, and the paired list. Each row shows the
  device and browser (from its user agent at pairing), when it paired, when it was last seen, a
  "This browser" mark for the current one, and Remove.
- **Set by `GRAM_REMOTE_ORIGIN`**: the variable wins; the switch is locked and says so, the list
  and Remove still work.
- **Pair a phone** dialog: a QR code of the one-time link, Copy link, the 15-minute countdown, and
  the warning that the link is a key until it is used. It closes itself when the phone pairs.
- **Remove** confirm: what it does (that phone is signed out at once, its open connections close).
- **A removed phone**: what the phone sees next.
- Eight paired browsers at most, as today: the ninth pairing is refused with a reason.

## Out of scope

- Paired machines, join codes and the machine picker (medium term).
- Renaming devices, per-device permissions (pairing stays full access, as today).
- Funnel, LAN listeners, or any route other than Tailscale Serve.

## Open questions

- Where: a new **Machines** group (default) rather than a section of General.
- Gram runs `tailscale serve` itself (default), rather than showing the command to copy.
- The port: Gram picks a free HTTPS port and remembers it (default 9443 when free).
- Device names come from the user agent at pairing (default); no rename in v1.
