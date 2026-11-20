// Shipped in the app as app.asar/out/server/native-probe.js, and run by the packaged Gram with that
// path as its first argument (entry.ts: its RunAsNode fuse is off, so it runs no script
// from outside) from tools/release-rc/rc.mjs, and on Linux from verify-package.mjs and CI: loads
// the speech and PTY natives through the production app.asar and has the PTY run a shell that
// prints a marker. Arguments: <app.asar> <scratch dir> <marker> [watch], then on Linux Chromium's
// switches. With `watch` (the Linux package) it also proves that @parcel/watcher, which only that
// package carries, reports a file change. It ends itself: Electron's main process never does.
//
// Any caller can start the binary with this file's path, so nothing it is handed chooses code:
// the natives load from the app.asar this file is in, never from a folder the caller names (the
// first argument must be that same app.asar, or the probe refuses), and the marker is a plain
// word the shell is handed as an argument, never as script.
const { createRequire } = require("node:module");
const path = require("node:path");

// In Electron's main process an uncaught error is a dialog; here it is a failed probe.
process.on("uncaughtException", (error) => {
  console.error(error);
  process.exit(1);
});

const refuse = (why) => {
  console.error(`Native probe: ${why}`);
  process.exit(1);
};

/** The same path, however it is spelled; false when either can't be found. */
const same = (a, b) => {
  if (path.resolve(a) === path.resolve(b)) return true;
  try {
    const { realpathSync } = require("node:fs");
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
};

const [asar, scratch, marker, watch] = process.argv.slice(2);
// This file is app.asar/out/server/native-probe.js.
const ownAsar = path.resolve(__dirname, "..", "..");
if (typeof asar !== "string" || !same(asar, ownAsar))
  refuse(`it loads only the app.asar it ships in (${ownAsar})`);
if (typeof marker !== "string" || !/^[A-Za-z0-9_]{1,64}$/.test(marker))
  refuse("the marker is letters, digits and underscores only");
if (typeof scratch !== "string" || !path.isAbsolute(scratch))
  refuse("the scratch folder is an absolute path");
const load = createRequire(path.join(ownAsar, "package.json"));
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

const child = pty.spawn("/bin/sh", ["-c", 'printf %s "$1"', "sh", marker], {
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
    process.stdout.write("", () => process.exit(0));
  });
});
