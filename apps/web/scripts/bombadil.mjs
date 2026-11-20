// `bun run --filter @gram/web bombadil`: Bombadil's random exploration of the mock web app, the
// report-only trial in docs/VERIFICATION.md#random-exploration-trial. It builds the e2e preview
// bundle, serves it on 127.0.0.1 behind the e2e token check, and runs `bombadil browser test` with
// `bombadil/spec.ts` in Playwright's Chromium. Bombadil's exit code is this script's: 0 when the
// time ran out with every property holding, 2 on a violation, 1 on an error. The log, the trace and
// any violation text go to apps/web/bombadil-out/ (gitignored); on GitHub Actions the violation
// text also goes to the job summary.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

import { buildForPreview, spawnVitePreview, startE2eServer } from "./e2e-server.mjs";

const webDir = fileURLToPath(new URL("..", import.meta.url));

const HELP = `Usage: bun run --filter @gram/web bombadil [flags]

  --time-limit <t>   how long to explore, as Bombadil takes it: 90s, 10m (default 90s)
  --keep-going       explore to the time limit instead of stopping at the first violation
  --skip-build       serve the existing dist-e2e bundle instead of building it again
  --output <dir>     where the log, trace and violations go (default apps/web/bombadil-out)

CHROME selects the browser; the default is Playwright's installed Chromium. Coverage
instrumentation is off (--instrument-javascript ""): with it on, the app never renders.`;

/** Bombadil's own binary, run directly rather than through its Node wrapper, so stopping it works. */
function bombadilBinary() {
  const names = {
    "darwin-arm64": "bombadil-darwin-arm64",
    "linux-arm64": "bombadil-linux-arm64",
    "linux-x64": "bombadil-linux-x64",
  };
  const name = names[`${process.platform}-${process.arch}`];
  if (!name) throw new Error(`Bombadil has no binary for ${process.platform}-${process.arch}`);
  for (let dir = webDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules/@antithesishq/bombadil/binaries", name);
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir)
      throw new Error("@antithesishq/bombadil isn't installed: run bun install");
  }
}

/** The text of each violation in Bombadil's output, from "<name> was violated:" to the run's end. */
export function violations(log) {
  const lines = log.split("\n").filter((line) => !/^\[\S+ (WARN|INFO|DEBUG) /.test(line));
  const start = lines.findIndex((line) => line.endsWith(" was violated:"));
  if (start === -1) return "";
  const end = lines.findIndex((line, index) => index > start && line.startsWith("Test finished"));
  return lines
    .slice(start, end === -1 ? undefined : end)
    .join("\n")
    .trim();
}

/** Signals the process group `child` leads: Bombadil and the Chrome it started, nothing else. */
function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== "--"),
    options: {
      "time-limit": { type: "string", default: "90s" },
      "keep-going": { type: "boolean", default: false },
      "skip-build": { type: "boolean", default: false },
      output: { type: "string", default: join(webDir, "bombadil-out") },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const binary = bombadilBinary();
  const chrome = process.env["CHROME"] || chromium.executablePath();
  if (!existsSync(chrome))
    throw new Error(
      `No Chromium at ${chrome}: run bun run playwright install chromium in apps/web`,
    );
  const output = values.output;
  mkdirSync(output, { recursive: true });
  const logPath = join(output, "run.log");
  const tracePath = join(output, "trace.bin");
  const violationsPath = join(output, "violations.txt");
  for (const path of [logPath, tracePath, violationsPath]) rmSync(path, { force: true });

  if (!values["skip-build"]) {
    console.log("Building the mock app…");
    await buildForPreview();
  }
  const server = await startE2eServer({
    token: randomUUID(),
    spawnServer: (port, token) => spawnVitePreview(port, token),
  });
  let child;
  const stop = (signal) => {
    if (child && child.exitCode === null && child.signalCode === null) signalGroup(child, signal);
  };
  const onSignal = () => stop("SIGTERM");
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    console.log(`Exploring ${server.origin}/ for ${values["time-limit"]}; log in ${logPath}`);
    const log = createWriteStream(logPath);
    child = spawn(
      binary,
      [
        "browser",
        "test",
        `${server.origin}/`,
        join(webDir, "bombadil/spec.ts"),
        "--headless",
        // F1 in the evaluation: with coverage instrumentation the app never renders.
        "--instrument-javascript",
        "",
        "--width",
        "1440",
        "--height",
        "900",
        "--time-limit",
        values["time-limit"],
        "--output-path",
        tracePath,
        ...(values["keep-going"] ? [] : ["--exit-on-violation"]),
        // GitHub's Ubuntu runners refuse Chromium's user-namespace sandbox, as Playwright assumes.
        ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      ],
      {
        cwd: webDir,
        env: { ...process.env, CHROME: chrome },
        // Its own process group, so stopping it reaches the Chrome it starts and nothing else.
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        log.write(chunk);
        process.stdout.write(chunk);
      });
    }
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
    });
    await new Promise((resolve) => log.end(resolve));
    // Bombadil has exited; whatever it left of its Chrome is still in its group.
    signalGroup(child, "SIGKILL");
    const found = violations(readFileSync(logPath, "utf8"));
    if (found) {
      appendFileSync(violationsPath, `${found}\n`);
      const summary = process.env["GITHUB_STEP_SUMMARY"];
      if (summary)
        appendFileSync(
          summary,
          `## Bombadil found a violation\n\nReport-only trial; the trace is in this run's artifacts.\n\n\`\`\`\n${found}\n\`\`\`\n`,
        );
    }
    if (!found && code !== 0 && process.env["GITHUB_STEP_SUMMARY"])
      appendFileSync(
        process.env["GITHUB_STEP_SUMMARY"],
        `## Bombadil exited ${code}\n\nNo violation text in its output; see the job log.\n`,
      );
    console.log(`Bombadil exited ${code}${found ? `; violations in ${violationsPath}` : ""}`);
    return code;
  } finally {
    stop("SIGKILL");
    await server.stop();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
