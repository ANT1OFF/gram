// Run by the packaged Gram in Node mode (ELECTRON_RUN_AS_NODE=1) from tools/release-rc/rc.mjs, and
// on Linux from verify-package.mjs and CI: loads the speech and PTY natives through the production
// app.asar and has the PTY run a shell that prints a marker. Arguments: <app.asar> <scratch dir>
// <marker> [watch]. With `watch` (the Linux package) it also proves that @parcel/watcher, which
// only that package carries, reports a file change.
const { createRequire } = require("node:module");
const path = require("node:path");

const [asar, scratch, marker, watch] = process.argv.slice(2);
const load = createRequire(path.join(asar, "package.json"));
const speech = load("sherpa-onnx-node");
const pty = load("node-pty");

/** Watches `scratch` through the packaged @parcel/watcher until it sees a file appear. */
const watchedAFile = async () => {
  let subscription;
  const seen = new Promise((resolve) => {
    load("@parcel/watcher")
      .subscribe(scratch, (error, events) => {
        if (error) throw error;
        if (events.some((event) => event.path.endsWith("watched"))) resolve(subscription);
      })
      .then((value) => {
        subscription = value;
        require("node:fs").writeFileSync(path.join(scratch, "watched"), "");
      });
  });
  await (await seen).unsubscribe();
};
const watching = watch === "watch" ? watchedAFile() : Promise.resolve();

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
  if (exitCode !== 0 || !output.includes(marker)) {
    console.error(JSON.stringify({ exitCode, output }));
    process.exit(1);
  }
  void watching.then(() => {
    clearTimeout(timer);
    console.log(
      JSON.stringify({
        electron: process.versions.electron,
        node: process.versions.node,
        arch: process.arch,
        speechExports: Object.keys(speech).length,
        markerSeen: true,
      }),
    );
    console.log("NATIVE OK");
  });
});
