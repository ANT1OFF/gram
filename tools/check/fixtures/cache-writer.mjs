// An invented parent Vitest cache writer; all paths belong to the regression fixture.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";

const { cache, stop } = workerData;
const stopped = new Int32Array(stop);
let n = 0;
while (!Atomics.load(stopped, 0)) {
  try {
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, `module-${n++ % 4096}`), "invented transform");
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node worker_threads has no origin argument.
    if (n === 1) parentPort.postMessage("writing");
  } catch (error) {
    // The unfixed nested Vitest removes this active cache out from under the writer.
    if (error.code !== "ENOENT") throw error;
  }
}
