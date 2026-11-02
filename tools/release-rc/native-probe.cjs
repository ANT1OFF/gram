// Run by the packaged Gram in Node mode (ELECTRON_RUN_AS_NODE=1) from tools/release-rc/rc.mjs:
// loads the speech and PTY natives through the production app.asar and has the PTY run a shell
// that prints a marker. Arguments: <app.asar> <scratch dir> <marker> [no-speech]. With
// `no-speech`, a package without local dictation (Linux), it instead proves sherpa-onnx can't load.
const { createRequire } = require("node:module");
const path = require("node:path");

const [asar, scratch, marker, voice = "speech"] = process.argv.slice(2);
const load = createRequire(path.join(asar, "package.json"));
let speech;
if (voice === "no-speech") {
  try {
    load("sherpa-onnx-node");
    console.error("Native probe: sherpa-onnx-node loads in a package without local dictation");
    process.exit(1);
  } catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error;
  }
} else {
  speech = load("sherpa-onnx-node");
}
const pty = load("node-pty");

const child = pty.spawn("/bin/sh", ["-c", `printf ${marker}`], {
  name: "xterm",
  cwd: scratch,
  env: { PATH: "/usr/bin:/bin", HOME: scratch, TERM: "xterm" },
});
let output = "";
child.onData((chunk) => {
  output += chunk;
});
const timer = setTimeout(() => {
  console.error("Native probe: no marker within 10s");
  process.exit(1);
}, 10_000);
child.onExit(({ exitCode }) => {
  clearTimeout(timer);
  if (exitCode !== 0 || !output.includes(marker)) {
    console.error(JSON.stringify({ exitCode, output }));
    process.exit(1);
  }
  console.log(
    JSON.stringify({
      electron: process.versions.electron,
      node: process.versions.node,
      arch: process.arch,
      speechExports: speech === undefined ? null : Object.keys(speech).length,
      markerSeen: true,
    }),
  );
  console.log("NATIVE OK");
});
