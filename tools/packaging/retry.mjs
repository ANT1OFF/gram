// CI only: retry failed downloads, never an arbitrary failed build or publication.
import { spawn } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

export function isTransientDownloadFailure(output) {
  const text = stripVTControlCharacters(output);
  // Judge fatal diagnostics, not earlier progress/debug lines containing a URL or a status.
  const fatal = text
    .split("\n")
    .filter((line) => /⨯|\b(?:HTTPError|RequestError|TimeoutError|Error):/.test(line));
  if (!fatal.length) return false;
  return fatal.every(
    (line) =>
      /(?:Response code|status(?: code)?|HTTP(?:\/[\d.]+)?)[:= ]+5\d\d\b/i.test(line) ||
      /\b(?:RequestError|TimeoutError):.*(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|Client network socket disconnected)/i.test(
        line,
      ),
  );
}

export async function retryPackaging(attemptPackage, wait = setTimeout, log = console.error) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await attemptPackage();
    if (result.code === 0) return 0;
    if (result.signal || attempt === 3 || !isTransientDownloadFailure(result.output))
      return result.code || 1;
    const delay = attempt * 10_000;
    log(`Packaging download failed; retrying attempt ${attempt + 1}/3 in ${delay / 1000}s`);
    await wait(delay);
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const [source, target] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ]) {
      source.on("data", (chunk) => {
        target.write(chunk);
        output = (output + chunk.toString()).slice(-1_000_000);
      });
    }
    // Forward cancellation to this child only; a cancelled job must never start another build.
    let cancelled;
    const cancel = (signal) => {
      cancelled = signal;
      child.kill(signal);
    };
    const terminate = () => cancel("SIGTERM");
    const interrupt = () => cancel("SIGINT");
    process.once("SIGTERM", terminate);
    process.once("SIGINT", interrupt);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      process.removeListener("SIGTERM", terminate);
      process.removeListener("SIGINT", interrupt);
      resolve({ code, signal: cancelled || signal, output });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (!command) throw new Error("Expected a packaging command");
  process.exitCode = await retryPackaging(() => run(command, args));
}
