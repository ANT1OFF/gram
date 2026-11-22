import { GRAM_MAC_TEAM_ID, macDesignatedRequirement, validTeamId } from "@gram/git/mac-signature";
import { GRAM_RELEASE_PUBLIC_KEY, releaseKeyPem } from "@gram/git/release-signature";
import { LINUX_HOST_SWITCHES } from "./launch.ts";

/** Whom the installer trusts a downloaded app from, and the Apple tools it asks; seams for tests. */
export interface InstallTrust {
  /** The publisher's release signing key (base64 Ed25519); null, the placeholder, refuses on Linux. */
  readonly releaseKey: string | null;
  /** The publisher's Developer ID Team ID; null refuses a download on macOS. */
  readonly macTeam: string | null;
  readonly codesign: string;
  readonly spctl: string;
}

export const PUBLISHER: InstallTrust = {
  releaseKey: GRAM_RELEASE_PUBLIC_KEY,
  macTeam: GRAM_MAC_TEAM_ID,
  codesign: "/usr/bin/codesign",
  spctl: "/usr/sbin/spctl",
};

const TOOL = /^\/[0-9A-Za-z/._-]+$/;

/** The public repository whose releases the app is downloaded from. */
export const RELEASES = "https://github.com/ANT1OFF/gram/releases/download";

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const ORIGIN = /^https:\/\/[0-9A-Za-z.-]+(?::\d+)?$/;

const installUrl = (origin: string): string => `'${origin.replaceAll("'", "")}/host/install'`;

/** The one command Settings → Machines shows, for this Gram at `origin` and its join link. */
export const installCommand = (origin: string, link: string): string =>
  `curl -fsSL ${installUrl(origin)} | sh -s -- '${link.replaceAll("'", "")}'`;

/**
 * The command that updates a machine already joined to this Gram at `origin`: the same installer
 * with no link, which moves its service to this Gram's release and keeps the join.
 */
export const updateCommand = (origin: string): string => `curl -fsSL ${installUrl(origin)} | sh`;

/**
 * The script, for this Gram at `origin` running release `version` (undefined for a Gram run from
 * source, which has no release to download: then only an app already installed there is used).
 */
export const installScript = (
  origin: string,
  version: string | undefined,
  run: {
    /** The join link, carried in the script itself when Gram runs it over SSH (`ssh-join.ts`). */
    readonly link?: string;
    /** Only moves a joined machine's service, run over SSH to update it: it never joins. */
    readonly update?: boolean;
  } = {},
  trust: InstallTrust = PUBLISHER,
): string => {
  const { link } = run;
  const team = trust.macTeam !== null && validTeamId(trust.macTeam) ? trust.macTeam : undefined;
  const key = trust.releaseKey === null ? "" : releaseKeyPem(trust.releaseKey);
  if (!TOOL.test(trust.codesign) || !TOOL.test(trust.spctl)) throw new Error("Not a tool path.");
  if (!ORIGIN.test(origin)) throw new Error("Not an https origin.");
  if (version !== undefined && !VERSION.test(version)) throw new Error("Not a version.");
  if (link !== undefined && !link.startsWith(`${origin}/host/join#code=`))
    throw new Error("Not this Gram's join link.");
  if (link !== undefined && !/#code=[a-f0-9]{64}$/.test(link)) throw new Error("Not a join link.");
  return `#!/bin/sh
# Joins this machine to the Gram at ${origin}, with the link given after \`sh -s --\`.
# Everything is in main, run on the last line, so a script cut off in transit runs nothing.
set -eu

ORIGIN='${origin}'
VERSION='${version ?? ""}'
RELEASE="${RELEASES}/v$VERSION"
LINK='${link ?? ""}'
UPDATE='${run.update === true ? "1" : ""}'
RELEASE_KEY='${key}'
MAC_REQUIREMENT='${team === undefined ? "" : macDesignatedRequirement(team)}'
CODESIGN='${trust.codesign}'
SPCTL='${trust.spctl}'

say() { printf 'gram-host: %s\\n' "$*" >&2; }
die() { say "$*"; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$2"; }

# The release's checksum list, as a file: on Linux only once the publisher's signature of its exact
# bytes verifies (macOS checks the app's own Developer ID signature instead, \`mac_signed\`).
sums() {
  curl -fsSL -o "$APPS/.sums" "$RELEASE/SHA256SUMS.txt" || die "Couldn't read the release's checksums."
  [ "$(uname -s)" = Linux ] || return 0
  [ -n "$RELEASE_KEY" ] || die "Signed release refused: this Gram pins no release signing key, so it can't verify the release."
  need openssl "OpenSSL 3 is needed to check the release's signature."
  case "$(openssl version 2>/dev/null)" in "OpenSSL "[3-9]*) ;; *) die "OpenSSL 3 is needed to check the release's signature." ;; esac
  curl -fsSL -o "$APPS/.sums.sig" "$RELEASE/SHA256SUMS.txt.sig" || die "Signed release refused: the release has no checksum signature."
  printf '%s\n' "$RELEASE_KEY" >"$APPS/.release-key.pem"
  openssl base64 -d -A -in "$APPS/.sums.sig" -out "$APPS/.sums.bin" 2>/dev/null || die "Signed release refused: the release's checksum signature is malformed."
  openssl pkeyutl -verify -pubin -inkey "$APPS/.release-key.pem" -rawin -in "$APPS/.sums" -sigfile "$APPS/.sums.bin" >/dev/null 2>&1 ||
    die "Signed release refused: the release's checksums aren't signed by Gram's publisher."
}

# The release file's checksum, from the release's own (verified) list.
verify() {
  sums
  want=$(awk -v f="$2" '$2 == f || $2 == "*" f { print $1 }' "$APPS/.sums")
  rm -f "$APPS/.sums" "$APPS/.sums.sig" "$APPS/.sums.bin" "$APPS/.release-key.pem"
  [ -n "$want" ] || die "The release lists no checksum for $2."
  if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$1" | cut -d' ' -f1)
  else got=$(shasum -a 256 "$1" | cut -d' ' -f1); fi
  [ "$got" = "$want" ] || die "$2 doesn't match its checksum; nothing was installed."
}

# Whether the app bundle is Gram, sealed and signed by the publisher's Developer ID team, and
# notarized as Gatekeeper sees it: before anything in a downloaded or cached app runs.
mac_signed() {
  [ -n "$MAC_REQUIREMENT" ] || return 1
  "$CODESIGN" --verify --deep --strict -R "=$MAC_REQUIREMENT" "$1" >/dev/null 2>&1 || return 1
  "$SPCTL" --assess --type execute "$1" >/dev/null 2>&1
}

download() {
  [ -n "$VERSION" ] || die "Install Gram on this machine first: the Gram at $ORIGIN runs from source, so there is no release to download."
  say "Downloading Gram $VERSION..."
  curl -fL --progress-bar -o "$APPS/$1.part" "$RELEASE/$1" || die "Couldn't download $1."
  verify "$APPS/$1.part" "$1"
  mv "$APPS/$1.part" "$APPS/$1"
}

# Whether the app with these resources can be the host: it carries gram-host, and is this Gram's
# version when this Gram is a release (the second argument is the app's version).
usable() {
  # The asar's header names its files, so an app from before gram-host is told apart unopened.
  [ -f "$1/app.asar" ] && LC_ALL=C grep -q -a '"gram-host.js"' "$1/app.asar" || return 1
  [ -z "$VERSION" ] || [ "$2" = "$VERSION" ]
}

# Check the actual entry and its imported resources before publishing or reusing a cache.
# --help loads the host without joining, starting a service or reading a saved join.
# The app runs the gram-host bundled in its own asar when that is its first argument (host mode),
# on Linux with Chromium's switches for a machine with no display ($SWITCHES, split on purpose).
host_app() {
  [ -x "$1" ] && [ -e "$2/app.asar" ] || return 1
  ELECTRON_RUN_AS_NODE=1 "$1" "$2/app.asar/out/server/gram-host.js" --help $SWITCHES </dev/null >/dev/null 2>&1
}

# Repair an owner-created directory from an older installer, but never follow a link or take
# over another user's folder. Do this before making children or consuming the invitation.
private_home() {
  [ ! -L "$HOST_HOME" ] || die "The host folder must not be a symbolic link."
  (umask 077; mkdir -p "$HOST_HOME")
  # Both macOS sh and Linux sh test ownership directly; stat's flags differ across platforms
  # and a user's PATH can put GNU stat ahead of macOS's BSD stat.
  [ -O "$HOST_HOME" ] || die "The host folder must belong to this user."
  chmod 700 "$HOST_HOME"
}

mac_version() {
  /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$1/Contents/Info.plist" 2>/dev/null || true
}

main() {
  need curl "curl is needed."
  need git "git is needed: workers clone and work in git repositories here."
  command -v tailscale >/dev/null 2>&1 || say "Tailscale isn't on the PATH here. This machine reaches $ORIGIN over your tailnet, so install it and sign in to the same tailnet."
  command -v claude >/dev/null 2>&1 || say "Claude Code isn't on the PATH here. Install it and run \\\`claude /login\\\` before placing workers on this machine."

  BIN=""
  RESOURCES=""
  SWITCHES=""
  case "$(uname -s)" in
    Darwin)
      [ "$(uname -m)" = arm64 ] || die "Gram for macOS runs on Apple silicon only."
      HOST_HOME="$HOME/Library/Application Support/Gram Host"
      case "\${GRAM_HOST_HOME:-}" in /*) HOST_HOME="$GRAM_HOST_HOME" ;; esac
      private_home
      APPS="$HOST_HOME/apps"
      mkdir -p "$APPS"
      for app in "/Applications/Gram.app" "$HOME/Applications/Gram.app"; do
        if [ -x "$app/Contents/MacOS/Gram" ] && usable "$app/Contents/Resources" "$(mac_version "$app")"; then
          BIN="$app/Contents/MacOS/Gram"; RESOURCES="$app/Contents/Resources"; break
        fi
      done
      if [ -z "$BIN" ]; then
        own="$APPS/$VERSION/Gram.app"
        if [ -z "$VERSION" ] || [ ! -f "$APPS/$VERSION/.complete" ] || ! mac_signed "$own" || ! host_app "$own/Contents/MacOS/Gram" "$own/Contents/Resources"; then
          zip="gram_\${VERSION}_darwin-arm64_signed.zip"
          download "$zip"
          stage=$(mktemp -d "$APPS/.extract-XXXXXX")
          trap 'rm -rf "$stage"' EXIT
          trap 'exit 1' HUP INT TERM
          ditto -x -k "$APPS/$zip" "$stage" || die "Couldn't unpack $zip."
          mac_signed "$stage/Gram.app" || die "Signed update refused: the app isn't Gram signed by its publisher's Developer ID team and notarized; nothing was installed."
          host_app "$stage/Gram.app/Contents/MacOS/Gram" "$stage/Gram.app/Contents/Resources" || die "The extracted app is incomplete. Run the installer again."
          touch "$stage/.complete"
          rm -rf "$APPS/$VERSION"
          mv "$stage" "$APPS/$VERSION"
          trap - EXIT HUP INT TERM
          rm -f "$APPS/$zip"
        fi
        BIN="$own/Contents/MacOS/Gram"; RESOURCES="$own/Contents/Resources"
      fi
      ;;
    Linux)
      [ "$(uname -m)" = x86_64 ] || die "Gram for Linux runs on x64 only."
      SWITCHES="${LINUX_HOST_SWITCHES.join(" ")}"
      case "\${XDG_CONFIG_HOME:-}" in /*) HOST_HOME="$XDG_CONFIG_HOME/gram-host" ;; *) HOST_HOME="$HOME/.config/gram-host" ;; esac
      case "\${GRAM_HOST_HOME:-}" in /*) HOST_HOME="$GRAM_HOST_HOME" ;; esac
      private_home
      # The app is large and can be downloaded again, so it goes with data, not the host's config.
      case "\${XDG_DATA_HOME:-}" in /*) APPS="$XDG_DATA_HOME/gram-host/apps" ;; *) APPS="$HOME/.local/share/gram-host/apps" ;; esac
      mkdir -p "$APPS"
      deb=$(dpkg-query -W -f='\${Version}' gram 2>/dev/null || true)
      if [ -x /opt/Gram/gram ] && usable /opt/Gram/resources "$deb"; then
        BIN=/opt/Gram/gram; RESOURCES=/opt/Gram/resources
      else
        own="$APPS/$VERSION"
        if [ -z "$VERSION" ] || [ ! -f "$own/.complete" ] || ! host_app "$own/gram" "$own/resources"; then
          image="gram_\${VERSION}_x86_64.AppImage"
          download "$image"
          chmod +x "$APPS/$image"
          # Unpacked, so it needs no FUSE and starts no desktop: the host is the app's own, in host mode.
          stage=$(mktemp -d "$APPS/.extract-XXXXXX")
          trap 'rm -rf "$stage"' EXIT
          trap 'exit 1' HUP INT TERM
          (cd "$stage" && "$APPS/$image" --appimage-extract >/dev/null) || die "Couldn't unpack $image."
          host_app "$stage/squashfs-root/gram" "$stage/squashfs-root/resources" || die "The extracted app is incomplete. Run the installer again."
          touch "$stage/squashfs-root/.complete"
          rm -rf "$own"
          mv "$stage/squashfs-root" "$own"
          rm -rf "$stage"
          trap - EXIT HUP INT TERM
          rm -f "$APPS/$image"
        fi
        BIN="$own/gram"; RESOURCES="$own/resources"
      fi
      ;;
    *) die "Only macOS and Linux machines can join." ;;
  esac

  # Joined to another Gram: that join stands, and this link isn't used.
  if [ -f "$HOST_HOME/host.json" ] && ! grep -qF "\\"$ORIGIN\\"" "$HOST_HOME/host.json"; then
    die "This machine already joined another Gram. Run \\\`gram-host leave\\\` there first to join $ORIGIN."
  fi
  # An update finds the machine joined, or changes nothing.
  if [ -n "$UPDATE" ] && [ ! -f "$HOST_HOME/host.json" ]; then
    die "This machine hasn't joined $ORIGIN, so there is nothing to update. Add it again in Settings → Machines."
  fi

  ENTRY="$RESOURCES/app.asar/out/server/gram-host.js"
  case "$BIN$ENTRY" in *"'"*) die "Gram's folder has a quote in its path: $BIN" ;; esac
  mkdir -p "$HOME/.local/bin"
  SHIM="$HOME/.local/bin/gram-host"
  {
    printf '#!/bin/sh\\n'
    printf '# Gram'"'"'s own app, running its own gram-host.\\n'
    printf 'ELECTRON_RUN_AS_NODE=1 exec %s %s "$@"%s\\n' "'$BIN'" "'$ENTRY'" "\${SWITCHES:+ $SWITCHES}"
  } >"$SHIM.part"
  chmod +x "$SHIM.part"
  mv "$SHIM.part" "$SHIM"
  say "Installed $SHIM."

  # Apps this one replaces, unless the service still runs one: it moves below.
  for old in "$APPS"/*; do
    [ -e "$old" ] || continue
    case "$BIN" in "$old"/*) ;; *) [ -f "$HOST_HOME/host.json" ] || rm -rf "$old" ;; esac
  done

  if [ -f "$HOST_HOME/host.json" ]; then
    # Already joined: the service moves to this app, and the join stands.
    say "This machine already joined $ORIGIN; moving its service to this app."
    "$SHIM" service install </dev/null
    # Its fingerprint, which tells the main Gram that ran this over SSH which machine it moved.
    "$SHIM" status </dev/null || true
    for old in "$APPS"/*; do
      [ -e "$old" ] || continue
      case "$BIN" in "$old"/*) ;; *) rm -rf "$old" ;; esac
    done
  elif [ -n "$LINK" ]; then
    printf '%s\\n' "$LINK" | "$SHIM" join
  elif [ "$#" -gt 0 ] && [ -n "$1" ]; then
    printf '%s\\n' "$1" | "$SHIM" join
  else
    "$SHIM" join </dev/tty
  fi
}

main "$@"
`;
};
