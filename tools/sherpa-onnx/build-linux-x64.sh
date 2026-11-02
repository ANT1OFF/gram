#!/usr/bin/env bash
# Builds sherpa-onnx's linux-x64 Node addon and C API from the upstream tag with text-to-speech off,
# into tools/sherpa-onnx/linux-x64/: the Linux twin of build-darwin-arm64.sh. The npm
# sherpa-onnx-linux-x64 package carries TTS (up to 1.13.8 with espeak-ng, GPL-3.0-or-later, linked
# in); Gram only recognises speech, so it ships these instead (tools/sherpa-onnx/install.mjs puts
# them over the npm package on install).
#
# The build runs in a manylinux_2_28 container pinned by digest (AlmaLinux 8, glibc 2.28, GCC 14
# from gcc-toolset), so the files load on any glibc from 2.28 up, below the package's 2.34 floor,
# and every input is pinned: the image, Node by SHA-256, the sherpa-onnx commit, and upstream's
# dependency downloads, which its cmake/ files pin by SHA-256. Flags are upstream's
# npm-addon-linux-x64.yaml with SHERPA_ONNX_ENABLE_TTS=OFF, and the addon is compiled in the same
# container (upstream compiles it on the runner, which raises its glibc floor to 2.32). It gets
# node-addon.patch, which drops its TTS bindings and the rpath to this build's install dir (only
# $ORIGIN loads the libraries). Everything builds at fixed paths inside the container and source
# paths map to /sherpa-onnx, so two builds are byte-identical; the `sherpa-onnx linux-x64` CI job
# rebuilds and compares with the committed files. BUILD-INFO records the tag, flags and toolchain;
# SHA256SUMS the files, which install.mjs checks before copying them. ONNX Runtime stays the npm
# package's libonnxruntime.so: the build checks it is the same file. Needs Docker; on another
# architecture it runs the x64 image emulated (slowly).
#
#   tools/sherpa-onnx/build-linux-x64.sh
#
# SHERPA_ONNX_OUT=<dir> writes elsewhere, to compare a rebuild with the committed files.
set -euo pipefail

TAG=v2.0.0
COMMIT=8abb7c8f87eae85b2e75f9a4115236c978980add
CMAKE_JS=7.4.0
NODE_ADDON_API=8.9.2
NODE=26.12.0 # .node-version; the addon uses Node-API only, so Electron loads it as is.
NODE_SHA256=fd47865ecd6391ebb431fc815e01b9135bf83ded5cf373247e9331e196b7aded # node-v26.12.0-linux-x64.tar.xz
# quay.io/pypa/manylinux_2_28_x86_64:2026.10.10-1
IMAGE=quay.io/pypa/manylinux_2_28_x86_64@sha256:4131ddd7acb9c6c966af02fe7e71edc51e078c2d41f475966697676430bfa2ae
# The npm package whose libonnxruntime.so ships beside the build: bun.lock's integrity for it.
NPM_PACKAGE=sherpa-onnx-linux-x64@2.0.0
NPM_INTEGRITY=sha512-Pp2McNdxRIIref6+nXKgkh3yPk02zl5/9xsCIzJopypmdtCGoMBII2MMsnf9ibwnFTVTlz+lhCn6YlwV2p5RRA==
GLIBC_FLOOR=2.28   # the newest glibc symbol version the files may need
GLIBCXX_FLOOR=3.4.25 # likewise libstdc++ (GCC 8's, which gcc-toolset keeps them to)

HERE=$(cd "$(dirname "$0")" && pwd)

# On the host: run this script again inside the container, with this directory read-only and the
# output directory as the only writable mount. The work dir is the container's own /tmp/work.
if [[ ${1:-} != --in-container ]]; then
  OUT=${SHERPA_ONNX_OUT:-$HERE/linux-x64}
  mkdir -p "$OUT"
  OUT=$(cd "$OUT" && pwd)
  exec docker run --rm --platform linux/amd64 \
    --user "$(id -u):$(id -g)" --env HOME=/tmp/work/home \
    --volume "$HERE:/tools:ro" --volume "$OUT:/out" \
    "$IMAGE" bash /tools/build-linux-x64.sh --in-container
fi

mkdir -p /tmp/work/home
cd /tmp/work

# Node, for cmake-js and the npm checks.
curl --fail --silent --show-error --location --output node.tar.xz \
  "https://nodejs.org/dist/v$NODE/node-v$NODE-linux-x64.tar.xz"
echo "$NODE_SHA256  node.tar.xz" | sha256sum --check --quiet
mkdir node && tar -xJf node.tar.xz -C node --strip-components 1
export PATH=/tmp/work/node/bin:$PATH

src=/tmp/work/sherpa-onnx
git clone --quiet --depth 1 --branch "$TAG" https://github.com/k2-fsa/sherpa-onnx.git "$src"
if [[ $(git -C "$src" rev-parse HEAD) != "$COMMIT" ]]; then
  echo "$TAG is no longer $COMMIT" >&2
  exit 1
fi
git -C "$src" apply /tools/node-addon.patch

# Upstream's dependency downloads are pinned by SHA-256 in its cmake/ files.
FLAGS=(
  -DCMAKE_BUILD_TYPE=Release
  -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON
  -DBUILD_SHARED_LIBS=ON
  -DSHERPA_ONNX_ENABLE_TTS=OFF
  -DSHERPA_ONNX_ENABLE_WEBSOCKET=OFF
  -DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF
  -DSHERPA_ONNX_ENABLE_BINARY=OFF
)
ADDON_FLAGS=(--runtime node --runtime-version "$NODE" --arch x64)
cmake -S "$src" -B "$src/build" "${FLAGS[@]}" \
  -DCMAKE_C_FLAGS="-ffile-prefix-map=$src=/sherpa-onnx" \
  -DCMAKE_CXX_FLAGS="-ffile-prefix-map=$src=/sherpa-onnx" \
  -DCMAKE_INSTALL_PREFIX="$src/build/install"
cmake --build "$src/build" --parallel "$(nproc)"
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
  "${ADDON_FLAGS[@]}" --CDCMAKE_CXX_FLAGS="-ffile-prefix-map=$src=/sherpa-onnx")

# The npm package, checked against bun.lock's integrity, for its ONNX Runtime.
mkdir npm && (cd npm && npm pack --silent --registry=https://registry.npmjs.org/ "$NPM_PACKAGE" >/dev/null)
tarball=$(echo npm/*.tgz)
if [[ "sha512-$(openssl dgst -sha512 -binary "$tarball" | base64 -w0)" != "$NPM_INTEGRITY" ]]; then
  echo "$NPM_PACKAGE does not match bun.lock's integrity" >&2
  exit 1
fi
tar -xzf "$tarball" -C npm
if ! cmp -s "$src/build/install/lib/libonnxruntime.so" npm/package/libonnxruntime.so; then
  echo "the build's ONNX Runtime differs from $NPM_PACKAGE's; check the pin" >&2
  exit 1
fi

out=/tmp/work/out
mkdir "$out"
cp "$addon/build/Release/sherpa-onnx.node" "$out/"
cp "$src/build/install/lib/libsherpa-onnx-c-api.so" "$src/build/install/lib/libsherpa-onnx-cxx-api.so" "$out/"
chmod 755 "$out"/*

# Case matters: "OfflineSpeaker" holds "eSpeak". The C API's TTS functions and the C++ API's
# sherpa_onnx::cxx::OfflineTts wrapper stay as stubs that return null with TTS off; the engine's
# sherpa_onnx::OfflineTts* classes (mangled 11sherpa_onnx<length>OfflineTts...) must be gone.
if nm "$out"/* | grep -E 'espeak|Espeak|piper|Piper|11sherpa_onnx[0-9]+OfflineTts'; then
  echo "the build still holds text-to-speech, espeak-ng or piper-phonemize symbols" >&2
  exit 1
fi
if grep -l -F -e /tmp/work/ -e "$src" "$out"/*; then
  echo "the build names its work dir" >&2
  exit 1
fi
newest() { objdump -T "$out"/* | grep -oE "\\b$1_[0-9.]+" | sed "s/^$1_//" | sort -V | tail -1; }
older() { [[ $(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1) == "$2" ]]; }
glibc=$(newest GLIBC)
glibcxx=$(newest GLIBCXX)
if ! older "$glibc" "$GLIBC_FLOOR" || ! older "$glibcxx" "$GLIBCXX_FLOOR"; then
  echo "the build needs glibc $glibc and libstdc++ $glibcxx, past $GLIBC_FLOOR and $GLIBCXX_FLOOR" >&2
  exit 1
fi
for file in "$out"/*; do
  runpath=$(objdump -p "$file" | awk '$1 == "RPATH" || $1 == "RUNPATH" { print $2 }')
  if [[ $runpath != '$ORIGIN' ]]; then
    echo "$(basename "$file") searches $runpath, not only \$ORIGIN" >&2
    exit 1
  fi
done

installed() { node -p "require('$addon/node_modules/$1/package.json').version"; }
echo "${TAG#v}" >"$out/VERSION"
cat >"$out/BUILD-INFO" <<INFO
Built by tools/sherpa-onnx/build-linux-x64.sh; SHA256SUMS lists the files.
sherpa-onnx: https://github.com/k2-fsa/sherpa-onnx $TAG ($COMMIT) + node-addon.patch
cmake flags: ${FLAGS[*]} -DCMAKE_C_FLAGS=-ffile-prefix-map=<src>=/sherpa-onnx -DCMAKE_CXX_FLAGS=-ffile-prefix-map=<src>=/sherpa-onnx
addon: cmake-js $(installed cmake-js), node-addon-api $(installed node-addon-api), ${ADDON_FLAGS[*]}
image: $IMAGE
compiler: $(gcc --version | head -1)
cmake: $(cmake --version | head -1)
node: $(node --version), npm $(npm --version)
needs: glibc $glibc, libstdc++ GLIBCXX_$glibcxx
libonnxruntime.so (the npm package's, unchanged): $(sha256sum npm/package/libonnxruntime.so | cut -d' ' -f1)
INFO
(cd "$out" && sha256sum sherpa-onnx.node libsherpa-onnx-c-api.so libsherpa-onnx-cxx-api.so >SHA256SUMS)

rm -rf /out/*
cp -p "$out"/* /out/
cat /out/BUILD-INFO /out/SHA256SUMS
