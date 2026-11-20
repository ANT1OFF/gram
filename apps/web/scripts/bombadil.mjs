// `bun run --filter @gram/web bombadil`: Bombadil's random exploration of the mock web app, the
// report-only trial in docs/VERIFICATION.md#random-exploration-trial. It builds the e2e preview
// bundle, serves it on 127.0.0.1 behind the e2e token check, and runs `bombadil browser test` with
// `bombadil/spec.ts` in Playwright's Chromium. Bombadil's exit code is this script's: 0 when the
// time ran out with every property holding, 2 on a violation, 1 on an error. The log, the trace and
// any violation text go to apps/web/bombadil-out/ (gitignored); on GitHub Actions the violation
// text also goes to the job summary.
//
// `--seed` builds the replayable mock (src/api/mock-modes): a seeded random, a clock that moves one
// step per input, and no animation, so `--reproduce` and `--shrink` of its trace take the same path.
// `--faults` builds the fault profile, which slows or fails that share of the mock's api calls.
// Each run records its modes in run.json beside the trace, and a reproduction or a shrink of that
// trace builds the same app from it.
import { spawn } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

import { buildForPreview, spawnVitePreview, startE2eServer } from "./e2e-server.mjs";

const webDir = fileURLToPath(new URL("..", import.meta.url));

const HELP = `Usage: bun run --filter @gram/web bombadil [flags]

  --time-limit <t>   how long to explore (or shrink), as Bombadil takes it: 90s, 10m (default 90s)
  --keep-going       explore to the time limit instead of stopping at the first violation
  --skip-build       serve the existing bundle instead of building it again
  --output <dir>     where the log, trace and violations go (default apps/web/bombadil-out)
  --spec <file>      the properties to check (default bombadil/spec.ts)

  --seed <n>         the replayable mock, seeded with n: same seed and inputs, same states
  --replayable       the replayable mock with a seed drawn now (printed, and kept in run.json)
  --faults <rate>    slow or fail that share of mock api calls, 0 < rate <= 1
  --fault-seed <n>   the fault profile's seed (default: drawn now, printed, kept in run.json)

  --reproduce <trace>  replay a trace instead of exploring; the modes come from its run.json
  --shrink <trace>     search for a shorter trace with the same violation (Bombadil's, experimental)

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

/** A seed flag's value: a non-negative 32-bit integer. */
export function parseSeed(raw, flag) {
  const value = Number(raw);
  if (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(value) || value > 0xffffffff)
    throw new Error(`${flag} takes a non-negative integer, not "${raw}"`);
  return value;
}

/** A `--faults` value: a share of calls in (0, 1]. */
export function parseRate(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 1)
    throw new Error(`--faults takes a rate in (0, 1], not "${raw}"`);
  return value;
}

/**
 * The run's mock modes, from the flags, else the run.json beside a trace being replayed. `null`
 * fields are off. A seed asked for but not given is drawn here, so it can be printed and kept.
 */
export function resolveModes(values, recorded) {
  const from = recorded ?? {};
  const seed =
    values.seed !== undefined
      ? parseSeed(values.seed, "--seed")
      : values.replayable
        ? randomInt(0, 2 ** 31)
        : (from.seed ?? null);
  const faults = values.faults !== undefined ? parseRate(values.faults) : (from.faults ?? null);
  const faultSeed =
    faults === null
      ? null
      : values["fault-seed"] !== undefined
        ? parseSeed(values["fault-seed"], "--fault-seed")
        : (from.faultSeed ?? randomInt(0, 2 ** 31));
  return { seed, faults, faultSeed };
}

/** The build env for `modes`: the replayable mock and the fault profile are build-time flags. */
export function modeEnv(modes) {
  return {
    ...(modes.seed === null
      ? {}
      : { VITE_MOCK_DETERMINISTIC: "1", VITE_MOCK_SEED: String(modes.seed) }),
    ...(modes.faults === null
      ? {}
      : { VITE_MOCK_FAULTS: String(modes.faults), VITE_MOCK_FAULT_SEED: String(modes.faultSeed) }),
  };
}

const describeModes = (modes) =>
  [
    modes.seed === null ? "the mock" : `the replayable mock, seed ${modes.seed}`,
    ...(modes.faults === null ? [] : [`faults at ${modes.faults}, fault seed ${modes.faultSeed}`]),
  ].join(", with ");

function readRecorded(trace) {
  const path = join(dirname(trace), "run.json");
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8"));
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
      spec: { type: "string" },
      seed: { type: "string" },
      replayable: { type: "boolean", default: false },
      faults: { type: "string" },
      "fault-seed": { type: "string" },
      reproduce: { type: "string" },
      shrink: { type: "string" },
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
  if (values.reproduce !== undefined && values.shrink !== undefined)
    throw new Error("--reproduce and --shrink each replay a trace: give one");
  const replaying = values.reproduce ?? values.shrink;
  const replayed = replaying === undefined ? undefined : resolvePath(replaying);
  if (replayed !== undefined && !existsSync(replayed)) throw new Error(`No trace at ${replayed}`);
  const recorded = replayed === undefined ? undefined : readRecorded(replayed);
  const modes = resolveModes(values, recorded);
  // A recorded spec is relative to apps/web, so a trace from CI replays in a local checkout.
  const spec =
    values.spec !== undefined
      ? resolvePath(values.spec)
      : resolvePath(webDir, recorded?.spec ?? "bombadil/spec.ts");
  const mode =
    values.reproduce !== undefined ? "reproduce" : values.shrink !== undefined ? "shrink" : "test";

  const output = values.output;
  mkdirSync(output, { recursive: true });
  // A replay writes beside what it replays, never over it.
  const logPath = join(output, mode === "test" ? "run.log" : `${mode}.log`);
  const tracePath = join(output, mode === "shrink" ? "shrunk.bin" : "trace.bin");
  const violationsPath = join(
    output,
    mode === "test" ? "violations.txt" : `${mode}-violations.txt`,
  );
  const written =
    mode === "reproduce" ? [logPath, violationsPath] : [logPath, tracePath, violationsPath];
  for (const path of written) {
    if (path === replayed)
      throw new Error(`--output would overwrite the trace being replayed: ${path}`);
    rmSync(path, { force: true });
  }

  // Its own bundle, so a replayable or faulty build never lands in the e2e lane's; the stamp
  // says which modes it was built for, so `--skip-build` can't replay on the wrong one.
  const distDir = "dist-bombadil";
  const stamp = join(webDir, distDir, "bombadil-modes.json");
  const built = JSON.stringify(modeEnv(modes));
  console.log(`Running ${describeModes(modes)}.`);
  if (!values["skip-build"]) {
    console.log("Building the mock app…");
    await buildForPreview({ ...process.env, ...modeEnv(modes) }, distDir);
    writeFileSync(stamp, built);
  } else if (!existsSync(stamp) || readFileSync(stamp, "utf8") !== built) {
    throw new Error(`--skip-build: ${distDir} was built for other modes; build it again`);
  }
  if (mode === "test")
    writeFileSync(
      join(output, "run.json"),
      `${JSON.stringify({ ...modes, spec: relative(webDir, spec), timeLimit: values["time-limit"] }, null, 2)}\n`,
    );
  const server = await startE2eServer({
    token: randomUUID(),
    spawnServer: (port, token) => spawnVitePreview(port, token, process.env, distDir),
  });
  let child;
  const stop = (signal) => {
    if (child && child.exitCode === null && child.signalCode === null) signalGroup(child, signal);
  };
  const onSignal = () => stop("SIGTERM");
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    console.log(
      mode === "test"
        ? `Exploring ${server.origin}/ for ${values["time-limit"]}; log in ${logPath}`
        : `${mode === "reproduce" ? "Reproducing" : "Shrinking"} ${replayed}; log in ${logPath}`,
    );
    // The same browser options for a test and its replays: Bombadil's replay needs them equal.
    const browser = [
      "--headless",
      // F1 in the evaluation: with coverage instrumentation the app never renders.
      "--instrument-javascript",
      "",
      "--width",
      "1440",
      "--height",
      "900",
      // GitHub's Ubuntu runners refuse Chromium's user-namespace sandbox, as Playwright assumes.
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    ];
    const args =
      mode === "test"
        ? [
            "browser",
            "test",
            `${server.origin}/`,
            spec,
            ...browser,
            "--time-limit",
            values["time-limit"],
            "--output-path",
            tracePath,
            ...(values["keep-going"] ? [] : ["--exit-on-violation"]),
          ]
        : mode === "reproduce"
          ? ["browser", "test", `${server.origin}/`, spec, ...browser, "--reproduce", replayed]
          : [
              "browser",
              "shrink",
              `${server.origin}/`,
              spec,
              ...browser,
              "--trace",
              replayed,
              "--time-limit",
              values["time-limit"],
              "--output-path",
              tracePath,
              "--output-path-overwrite",
            ];
    const log = createWriteStream(logPath);
    child = spawn(binary, args, {
      cwd: webDir,
      env: { ...process.env, CHROME: chrome },
      // Its own process group, so stopping it reaches the Chrome it starts and nothing else.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
          `## Bombadil found a violation\n\nReport-only trial, on ${describeModes(modes)}; the trace and its run.json are in this run's artifacts.\n\n\`\`\`\n${found}\n\`\`\`\n`,
        );
    }
    if (!found && code !== 0 && process.env["GITHUB_STEP_SUMMARY"])
      appendFileSync(
        process.env["GITHUB_STEP_SUMMARY"],
        `## Bombadil exited ${code}\n\nNo violation text in its output; see the job log.\n`,
      );
    console.log(`Bombadil exited ${code}${found ? `; violations in ${violationsPath}` : ""}`);
    if (mode === "test" && found && modes.seed !== null)
      console.log(
        `Replay it: bun run --filter @gram/web bombadil -- --reproduce ${tracePath}\n` +
          `Shrink it: bun run --filter @gram/web bombadil -- --shrink ${tracePath} --time-limit 5m\n` +
          `(${describeModes(modes)}, from ${join(output, "run.json")})`,
      );
    if (mode === "shrink" && code === 0 && existsSync(tracePath))
      console.log(`The shorter trace: ${tracePath}`);
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
