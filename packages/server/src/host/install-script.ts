/**
 * The installer a new machine runs to join this Gram, as one command:
 *
 *   curl -fsSL https://<device>.<tailnet>.ts.net/host/install | sh -s -- '<join link>'
 *
 * Gram's own app carries `gram-host` (`gram-host.js` beside the server, run by the app's binary as
 * plain Node), so the machine needs no Node, checkout or package of its own: the script uses the
 * Gram app already installed there, or downloads this Gram's release from GitHub, checks it against
 * the release's `SHA256SUMS.txt`, and keeps it in the host's folder. It then writes a `gram-host`
 * command to `~/.local/bin` and joins with the link, which it hands over on stdin so it never shows
 * in the process list. The script holds no secret: the link is the user's to pass.
 */

/** The public repository whose releases the app is downloaded from. */
export const RELEASES = "https://github.com/ANT1OFF/gram/releases/download";

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const ORIGIN = /^https:\/\/[0-9A-Za-z.-]+(?::\d+)?$/;

/** The one command Settings → Machines shows, for this Gram at `origin` and its join link. */
export const installCommand = (origin: string, link: string): string =>
  `curl -fsSL ${origin}/host/install | sh -s -- '${link.replaceAll("'", "")}'`;

/**
 * The script, for this Gram at `origin` running `version` (undefined when run from source: then
 * only an app already installed there is used).
 */
export const installScript = (origin: string, version: string | undefined): string => {
  if (!ORIGIN.test(origin)) throw new Error("Not an https origin.");
  if (version !== undefined && !VERSION.test(version)) throw new Error("Not a version.");
  return `#!/bin/sh
# Joins this machine to the Gram at ${origin}, with the link given after \`sh -s --\`.
set -eu

ORIGIN='${origin}'
VERSION='${version ?? ""}'
RELEASE="${RELEASES}/v$VERSION"

say() { printf 'gram-host: %s\\n' "$*" >&2; }
die() { say "$*"; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$2"; }

need curl "curl is needed."
need git "git is needed: workers clone and work in git repositories here."
command -v tailscale >/dev/null 2>&1 || say "Tailscale isn't on the PATH here. This machine reaches $ORIGIN over your tailnet, so install it and sign in to the same tailnet."
command -v claude >/dev/null 2>&1 || say "Claude Code isn't on the PATH here. Install it and run \\\`claude /login\\\` before placing workers on this machine."

case "$(uname -s)" in
  Darwin)
    DATA="$HOME/Library/Application Support/Gram Host"
    ;;
  Linux)
    DATA="\${XDG_DATA_HOME:-$HOME/.local/share}/gram-host"
    ;;
  *) die "Only macOS and Linux machines can join." ;;
esac
mkdir -p "$DATA"

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
  curl -fL --progress-bar -o "$DATA/$1.part" "$RELEASE/$1" || die "Couldn't download $1."
  verify "$DATA/$1.part" "$1"
  mv "$DATA/$1.part" "$DATA/$1"
}

BIN=""
RESOURCES=""
case "$(uname -s)" in
  Darwin)
    [ "$(uname -m)" = arm64 ] || die "Gram for macOS runs on Apple silicon only."
    for app in "/Applications/Gram.app" "$HOME/Applications/Gram.app" "$DATA/Gram.app"; do
      if [ -x "$app/Contents/MacOS/Gram" ]; then BIN="$app/Contents/MacOS/Gram"; RESOURCES="$app/Contents/Resources"; break; fi
    done
    if [ -z "$BIN" ]; then
      zip="gram_\${VERSION}_darwin-arm64_signed.zip"
      download "$zip"
      rm -rf "$DATA/Gram.app"
      ditto -x -k "$DATA/$zip" "$DATA" || die "Couldn't unpack $zip."
      rm -f "$DATA/$zip"
      BIN="$DATA/Gram.app/Contents/MacOS/Gram"
      RESOURCES="$DATA/Gram.app/Contents/Resources"
    fi
    ;;
  Linux)
    [ "$(uname -m)" = x86_64 ] || die "Gram for Linux runs on x64 only."
    if [ -x /opt/Gram/gram ]; then
      BIN=/opt/Gram/gram; RESOURCES=/opt/Gram/resources
    elif [ -n "$VERSION" ] && [ -x "$DATA/app-$VERSION/gram" ]; then
      BIN="$DATA/app-$VERSION/gram"; RESOURCES="$DATA/app-$VERSION/resources"
    else
      image="gram_\${VERSION}_x86_64.AppImage"
      download "$image"
      chmod +x "$DATA/$image"
      # Unpacked, so it needs no FUSE and starts no desktop: the host is the app's binary as Node.
      rm -rf "$DATA/squashfs-root" "$DATA/app-$VERSION"
      (cd "$DATA" && "./$image" --appimage-extract >/dev/null) || die "Couldn't unpack $image."
      mv "$DATA/squashfs-root" "$DATA/app-$VERSION"
      rm -f "$DATA/$image"
      BIN="$DATA/app-$VERSION/gram"; RESOURCES="$DATA/app-$VERSION/resources"
    fi
    ;;
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

if [ "$#" -gt 0 ] && [ -n "$1" ]; then
  printf '%s\\n' "$1" | "$SHIM" join
else
  "$SHIM" join </dev/tty
fi
`;
};
