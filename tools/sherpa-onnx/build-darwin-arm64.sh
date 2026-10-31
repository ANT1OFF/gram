#!/usr/bin/env bash
# Builds sherpa-onnx's darwin-arm64 Node addon and C API from the upstream tag with text-to-speech
# off, into tools/sherpa-onnx/darwin-arm64/. The npm sherpa-onnx-darwin-arm64 package carries TTS, and
# up to 1.13.8 statically linked espeak-ng (GPL-3.0-or-later) and piper-phonemize for it; Gram only
# recognises speech, so it ships these instead (tools/sherpa-onnx/install.mjs puts them over the npm
# package on install).
#
# Flags are upstream's npm-addon-macos.yaml with SHERPA_ONNX_ENABLE_TTS=OFF. The addon gets
# node-addon.patch, which drops its TTS bindings (they call the C API's TTS functions) and the
# rpaths to this build's install dir (only @loader_path loads the dylibs). Source paths map to
# /sherpa-onnx and nothing links with a build-tree rpath, so the output neither depends on nor names
# the work dir: two builds with the same toolchain are byte-identical. BUILD-INFO records the tag,
# flags and toolchain; SHA256SUMS the files, which install.mjs checks before copying them.
# ONNX Runtime stays the npm package's libonnxruntime.dylib, the build checks it is the same file.
# Needs Xcode's command line tools, cmake, git and node.
#
#   tools/sherpa-onnx/build-darwin-arm64.sh [work dir]
#
# SHERPA_ONNX_OUT=<dir> writes elsewhere, to compare a rebuild with the committed files.
set -euo pipefail

TAG=v2.0.0
COMMIT=8abb7c8f87eae85b2e75f9a4115236c978980add
CMAKE_JS=7.4.0
NODE_ADDON_API=8.9.2
NODE_HEADERS=26.12.0 # .node-version; the addon uses Node-API only, so Electron loads it as is.
MACOS=13.0 # Electron's LSMinimumSystemVersion; cmake-js would otherwise target the build machine's.

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
OUT=${SHERPA_ONNX_OUT:-$HERE/darwin-arm64}
WORK=${1:-$(mktemp -d)}

if [[ $(uname -s) != Darwin || $(uname -m) != arm64 ]]; then
  echo "build-darwin-arm64.sh builds on an Apple silicon Mac only" >&2
  exit 1
fi

src=$WORK/sherpa-onnx
rm -rf "$src"
git clone --quiet --depth 1 --branch "$TAG" https://github.com/k2-fsa/sherpa-onnx.git "$src"
if [[ $(git -C "$src" rev-parse HEAD) != "$COMMIT" ]]; then
  echo "$TAG is no longer $COMMIT" >&2
  exit 1
fi
git -C "$src" apply "$HERE/node-addon.patch"

# Upstream's dependency downloads are pinned by SHA-256 in its cmake/ files.
FLAGS=(
  -DCMAKE_BUILD_TYPE=Release
  -DCMAKE_OSX_ARCHITECTURES=arm64
  -DCMAKE_OSX_DEPLOYMENT_TARGET="$MACOS"
  -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON
  -DBUILD_SHARED_LIBS=ON
  -DSHERPA_ONNX_ENABLE_TTS=OFF
  -DSHERPA_ONNX_ENABLE_WEBSOCKET=OFF
  -DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF
  -DSHERPA_ONNX_ENABLE_BINARY=OFF
)
ADDON_FLAGS=(
  --runtime node --runtime-version "$NODE_HEADERS" --arch arm64
  --CDCMAKE_OSX_DEPLOYMENT_TARGET="$MACOS"
)
cmake -S "$src" -B "$src/build" "${FLAGS[@]}" \
  -DCMAKE_C_FLAGS="-ffile-prefix-map=$src=/sherpa-onnx" \
  -DCMAKE_CXX_FLAGS="-ffile-prefix-map=$src=/sherpa-onnx" \
  -DCMAKE_INSTALL_PREFIX="$src/build/install"
cmake --build "$src/build" --parallel "$(sysctl -n hw.ncpu)"
cmake --install "$src/build"

addon=$src/scripts/node-addon-api
cat >"$addon/package.json" <<JSON
{
  "name": "sherpa-onnx-node-addon-build",
  "private": true,
  "dependencies": { "cmake-js": "$CMAKE_JS", "node-addon-api": "$NODE_ADDON_API" }
}
JSON
(cd "$addon" && npm install --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/)
(cd "$addon" && SHERPA_ONNX_INSTALL_DIR="$src/build/install" ./node_modules/.bin/cmake-js compile \
  "${ADDON_FLAGS[@]}")

npm_package=$ROOT/node_modules/sherpa-onnx-darwin-arm64
if ! cmp -s "$src/build/install/lib/libonnxruntime.dylib" "$npm_package/libonnxruntime.dylib"; then
  echo "the build's ONNX Runtime differs from the npm package's; run bun install, then check the pin" >&2
  exit 1
fi

rm -rf "$OUT"
mkdir -p "$OUT"
cp "$addon/build/Release/sherpa-onnx.node" "$OUT/"
cp "$src/build/install/lib/libsherpa-onnx-c-api.dylib" "$src/build/install/lib/libsherpa-onnx-cxx-api.dylib" "$OUT/"
for file in "$OUT"/*; do
  codesign --force --sign - "$file"
done

# Case matters: "OfflineSpeaker" holds "eSpeak".
if nm "$OUT"/* | grep -E 'espeak|Espeak|piper|Piper'; then
  echo "the build still holds espeak-ng or piper-phonemize symbols" >&2
  exit 1
fi
if grep -l -F "$WORK" "$OUT"/*; then
  echo "the build names its work dir" >&2
  exit 1
fi

installed() { node -p "require('$addon/node_modules/$1/package.json').version"; }
echo "${TAG#v}" >"$OUT/VERSION"
cat >"$OUT/BUILD-INFO" <<INFO
Built by tools/sherpa-onnx/build-darwin-arm64.sh; SHA256SUMS lists the files.
sherpa-onnx: https://github.com/k2-fsa/sherpa-onnx $TAG ($COMMIT) + node-addon.patch
cmake flags: ${FLAGS[*]} -DCMAKE_C_FLAGS=-ffile-prefix-map=<src>=/sherpa-onnx -DCMAKE_CXX_FLAGS=-ffile-prefix-map=<src>=/sherpa-onnx
addon: cmake-js $(installed cmake-js), node-addon-api $(installed node-addon-api), ${ADDON_FLAGS[*]}
macOS: $(sw_vers -productVersion) ($(sw_vers -buildVersion)) $(uname -m), SDK $(xcrun --show-sdk-version)
compiler: $(xcrun clang --version | head -1)
cmake: $(cmake --version | head -1)
node: $(node --version), npm $(npm --version)
libonnxruntime.dylib (the npm package's, unchanged): $(shasum -a 256 "$npm_package/libonnxruntime.dylib" | cut -d' ' -f1)
INFO
(cd "$OUT" && shasum -a 256 sherpa-onnx.node libsherpa-onnx-c-api.dylib libsherpa-onnx-cxx-api.dylib >SHA256SUMS)
cat "$OUT/BUILD-INFO" "$OUT/SHA256SUMS"
