/**
 * The installer a new machine runs to join this Gram, as one command:
 *
 *   curl -fsSL https://<device>.<tailnet>.ts.net/host/install | sh -s -- '<join link>'
 *
 * Gram's own app carries `gram-host` (`gram-host.js` beside the server, run by the app's binary as
 * plain Node), so the machine needs no Node, checkout or package of its own. The script uses a Gram
 * app installed there when it is this Gram's version (or, for a Gram run from source, any that has
 * `gram-host.js`); otherwise it downloads this Gram's release from GitHub, checks it against the
 * release's `SHA256SUMS.txt`, and keeps it beside the host's folder. It then writes a `gram-host`
 * command to `~/.local/bin` and joins with the link on stdin; run again on a joined machine, it
 * moves the service to the new app instead. The script holds no secret: the link is the user's to
 * pass, and it sits in that shell's history and `sh`'s arguments until the script ends.
 */

/** The public repository whose releases the app is downloaded from. */
export const RELEASES = "https://github.com/ANT1OFF/gram/releases/download";

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const ORIGIN = /^https:\/\/[0-9A-Za-z.-]+(?::\d+)?$/;

/** The one command Settings → Machines shows, for this Gram at `origin` and its join link. */
export const installCommand = (origin: string, link: string): string =>
  `curl -fsSL ${origin}/host/install | sh -s -- '${link.replaceAll("'", "")}'`;

/**
 * The script, for this Gram at `origin` running release `version` (undefined for a Gram run from
 * source, which has no release to download: then only an app already installed there is used).
 */
export const installScript = (origin: string, version: string | undefined): string => {
  if (!ORIGIN.test(origin)) throw new Error("Not an https origin.");
  if (version !== undefined && !VERSION.test(version)) throw new Error("Not a version.");
  return `#!/bin/sh
# Joins this machine to the Gram at ${origin}, with the link given after \`sh -s --\`.
# Everything is in main, run on the last line, so a script cut off in transit runs nothing.
set -eu

ORIGIN='${origin}'
VERSION='${version ?? ""}'
RELEASE="${RELEASES}/v$VERSION"

say() { printf 'gram-host: %s\\n' "$*" >&2; }
die() { say "$*"; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$2"; }

# The release file's checksum, from the release's own list.
verify() {
  sums=$(curl -fsSL "$RELEASE/SHA256SUMS.txt") || die "Couldn't read the release's checksums."
  want=$(printf '%s\\n' "$sums" | awk -v f="$2" '$2 == f || $2 == "*" f { print $1 }')
  [ -n "$want" ] || die "The release lists no checksum for $2."
  if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$1" | cut -d' ' -f1)
  else got=$(shasum -a 256 "$1" | cut -d' ' -f1); fi
  [ "$got" = "$want" ] || die "$2 doesn't match its checksum; nothing was installed."
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
  case "$(uname -s)" in
    Darwin)
      [ "$(uname -m)" = arm64 ] || die "Gram for macOS runs on Apple silicon only."
      HOST_HOME="$HOME/Library/Application Support/Gram Host"
      APPS="$HOST_HOME/apps"
      mkdir -p "$APPS"
      for app in "/Applications/Gram.app" "$HOME/Applications/Gram.app"; do
        if [ -x "$app/Contents/MacOS/Gram" ] && usable "$app/Contents/Resources" "$(mac_version "$app")"; then
          BIN="$app/Contents/MacOS/Gram"; RESOURCES="$app/Contents/Resources"; break
        fi
      done
      if [ -z "$BIN" ]; then
        own="$APPS/$VERSION/Gram.app"
        if [ -z "$VERSION" ] || [ ! -x "$own/Contents/MacOS/Gram" ]; then
          zip="gram_\${VERSION}_darwin-arm64_signed.zip"
          download "$zip"
          rm -rf "$APPS/$VERSION"
          mkdir -p "$APPS/$VERSION"
          ditto -x -k "$APPS/$zip" "$APPS/$VERSION" || die "Couldn't unpack $zip."
          rm -f "$APPS/$zip"
        fi
        BIN="$own/Contents/MacOS/Gram"; RESOURCES="$own/Contents/Resources"
      fi
      ;;
    Linux)
      [ "$(uname -m)" = x86_64 ] || die "Gram for Linux runs on x64 only."
      case "\${XDG_CONFIG_HOME:-}" in /*) HOST_HOME="$XDG_CONFIG_HOME/gram-host" ;; *) HOST_HOME="$HOME/.config/gram-host" ;; esac
      # The app is large and can be downloaded again, so it goes with data, not the host's config.
      case "\${XDG_DATA_HOME:-}" in /*) APPS="$XDG_DATA_HOME/gram-host/apps" ;; *) APPS="$HOME/.local/share/gram-host/apps" ;; esac
      mkdir -p "$APPS"
      deb=$(dpkg-query -W -f='\${Version}' gram 2>/dev/null || true)
      if [ -x /opt/Gram/gram ] && usable /opt/Gram/resources "$deb"; then
        BIN=/opt/Gram/gram; RESOURCES=/opt/Gram/resources
      else
        own="$APPS/$VERSION"
        if [ -z "$VERSION" ] || [ ! -x "$own/gram" ]; then
          image="gram_\${VERSION}_x86_64.AppImage"
          download "$image"
          chmod +x "$APPS/$image"
          # Unpacked, so it needs no FUSE and starts no desktop: the host is the app's binary as Node.
          rm -rf "$APPS/squashfs-root" "$own"
          (cd "$APPS" && "./$image" --appimage-extract >/dev/null) || die "Couldn't unpack $image."
          mv "$APPS/squashfs-root" "$own"
          rm -f "$APPS/$image"
        fi
        BIN="$own/gram"; RESOURCES="$own/resources"
      fi
      ;;
    *) die "Only macOS and Linux machines can join." ;;
  esac

  ENTRY="$RESOURCES/app.asar/out/server/gram-host.js"
  case "$BIN$ENTRY" in *"'"*) die "Gram's folder has a quote in its path: $BIN" ;; esac
  mkdir -p "$HOME/.local/bin"
  SHIM="$HOME/.local/bin/gram-host"
  {
    printf '#!/bin/sh\\n'
    printf '# Gram'"'"'s own app, run as Node: its gram-host.\\n'
    printf 'ELECTRON_RUN_AS_NODE=1 exec %s %s "$@"\\n' "'$BIN'" "'$ENTRY'"
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
    say "This machine already joined a Gram; moving its service to this app."
    "$SHIM" service install </dev/null
    for old in "$APPS"/*; do
      [ -e "$old" ] || continue
      case "$BIN" in "$old"/*) ;; *) rm -rf "$old" ;; esac
    done
  elif [ "$#" -gt 0 ] && [ -n "$1" ]; then
    printf '%s\\n' "$1" | "$SHIM" join
  else
    "$SHIM" join </dev/tty
  fi
}

main "$@"
`;
};
