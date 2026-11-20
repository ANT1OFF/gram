// `bun run drive`: reach a feature of the mock UI by its name in docs/features.json and keep what
// it shows: a screenshot, an aria snapshot (the cheap way to read a screen), the browser's errors
// and, with --video, a recording. One Vite server for the run, one fresh browser context per
// feature. Gram's verify drivers set GRAM_VERIFY_EVIDENCE_DIR; the files and `manifest.json` go
// there. Otherwise they go to a new folder under apps/web/drive-out/ (gitignored).
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

import { spawnVite, startE2eServer } from "./e2e-server.mjs";
import { describeLocator, findFeature, loadUiFeatures, reach, seedMock } from "./feature-ui.mjs";
import { previewEnv } from "./isolated-preview.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export const HELP = `Usage: bun run drive <feature>... [flags]
       bun run drive --all | --list

Reaches each feature of the mock UI the way docs/features.json's "ui" block says, and keeps
<slug>.png, <slug>.aria.yml (the feature's accessibility tree) and, with --video, <slug>.webm.
A feature is named by its slug, its name, or a word only it has ("memory", "settings-agents").

  --list            print each feature's slug, route and where to find it, and exit
  --all             reach every feature; exits 1 if any is not where the map says
  --no-shot         skip the screenshots (aria snapshots only: the cheapest run)
  --video           record each feature's reach as <slug>.webm
  --full            snapshot the whole page, not only the feature's region
  --mode <mode>     dark (default) or light
  --size <WxH>      window in CSS px (default 1440x900)
  --output <dir>    a new folder for the evidence (default: GRAM_VERIFY_EVIDENCE_DIR, else a new
                    folder under apps/web/drive-out/)
  --chromium <path> a Chromium to use (default: GRAM_E2E_CHROMIUM, else Playwright's own)

Prints one line per feature and the evidence folder. Read the .aria.yml files before pictures.`;

/** @param {string} value */
function parseSize(value) {
  const [width, height] = value.split("x").map(Number);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 320 || height < 320)
    throw new Error("--size is <width>x<height>, each at least 320, such as 1440x900");
  return { width, height };
}

/** @param {string | undefined} explicit */
function evidenceDir(explicit) {
  if (explicit) {
    const dir = resolve(explicit);
    mkdirSync(dir, { recursive: false });
    return dir;
  }
  const fromGram = process.env["GRAM_VERIFY_EVIDENCE_DIR"];
  if (fromGram) {
    mkdirSync(fromGram, { recursive: true });
    return resolve(fromGram);
  }
  const base = join(REPO, "apps/web/drive-out");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `${new Date().toISOString().slice(0, 19).replace(/:/g, "")}-`));
}

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: args.filter((arg) => arg !== "--"),
    allowPositionals: true,
    options: {
      list: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      "no-shot": { type: "boolean", default: false },
      video: { type: "boolean", default: false },
      full: { type: "boolean", default: false },
      mode: { type: "string", default: "dark" },
      size: { type: "string", default: "1440x900" },
      output: { type: "string" },
      chromium: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return console.log(HELP);
  const features = loadUiFeatures(REPO);
  if (values.list) {
    for (const feature of features)
      console.log(`${feature.slug.padEnd(34)} ${feature.ui.route.padEnd(22)} ${feature.ui.where}`);
    return;
  }
  if (values.mode !== "dark" && values.mode !== "light") throw new Error("--mode is dark or light");
  const viewport = parseSize(values.size);
  if (!values.all && positionals.length === 0)
    throw new Error("name a feature, or pass --all or --list (--help has the flags)");
  const chosen = values.all ? features : positionals.map((query) => findFeature(features, query));

  const output = evidenceDir(values.output);
  const root = mkdtempSync(join(tmpdir(), "gram-drive-state-"));
  const env = previewEnv(root);
  const executablePath = values.chromium ?? process.env["GRAM_E2E_CHROMIUM"];
  const events = join(output, "browser.jsonl");
  const log = (event) => appendFileSync(events, `${JSON.stringify(event)}\n`);
  /** @type {{file: string, caption: string, kind: string}[]} */
  const items = [];
  const results = [];
  let server, browser, child;
  const stop = () => {
    if (child?.exitCode === null && child?.signalCode === null) child.kill();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    server = await startE2eServer({
      token: randomUUID(),
      startPort: 5190,
      spawnServer: (port, token) => {
        child = spawnVite(port, token, env, undefined, { isolatedDir: root });
        return child;
      },
    });
    browser = await chromium.launch({
      env,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      ...(executablePath ? { executablePath: resolve(executablePath) } : {}),
    });
    for (const feature of chosen) {
      const started = Date.now();
      const videoDir = values.video ? mkdtempSync(join(root, "video-")) : undefined;
      const context = await browser.newContext({
        viewport,
        colorScheme: values.mode,
        reducedMotion: "reduce",
        serviceWorkers: "block",
        ...(videoDir ? { recordVideo: { dir: videoDir, size: viewport } } : {}),
      });
      // Nothing leaves the machine: the mock needs only its own origin.
      await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === server.origin
          ? route.continue()
          : route.abort("blockedbyclient"),
      );
      await context.addInitScript(seedMock, { scenario: feature.ui.scenario ?? "realistic" });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => {
        errors.push(error.message);
        log({ feature: feature.slug, kind: "pageerror", message: error.message });
      });
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        errors.push(message.text());
        log({
          feature: feature.slug,
          kind: "console",
          text: message.text(),
          url: message.location().url,
        });
      });
      const result = { feature: feature.slug, name: feature.name, ok: false, files: [] };
      try {
        const { state } = await reach(page, server.origin, feature.ui);
        await page.evaluate(() => document.fonts.ready);
        const snapshot = values.full
          ? await page.locator("body").ariaSnapshot()
          : await state.ariaSnapshot();
        writeFileSync(join(output, `${feature.slug}.aria.yml`), `${snapshot}\n`);
        result.files.push(`${feature.slug}.aria.yml`);
        items.push({
          file: `${feature.slug}.aria.yml`,
          caption: `${feature.name}: ${describeLocator(values.full ? { role: "main" } : (feature.ui.state ?? feature.ui.landmark))}`,
          kind: "snapshot",
        });
        if (!values["no-shot"]) {
          await page.screenshot({ path: join(output, `${feature.slug}.png`) });
          result.files.push(`${feature.slug}.png`);
          items.push({ file: `${feature.slug}.png`, caption: feature.name, kind: "screenshot" });
        }
        result.ok = true;
      } catch (error) {
        result.error = error.message;
        if (!page.isClosed()) {
          await page
            .screenshot({ path: join(output, `${feature.slug}.failed.png`) })
            .catch(() => {});
          result.files.push(`${feature.slug}.failed.png`);
          items.push({
            file: `${feature.slug}.failed.png`,
            caption: `${feature.name}, not reached: ${error.message}`,
            kind: "screenshot",
          });
        }
      }
      const video = page.video();
      await context.close();
      if (video) {
        const file = `${feature.slug}.webm`;
        renameSync(await video.path(), join(output, file));
        result.files.push(file);
        items.push({ file, caption: `${feature.name}, reached`, kind: "video" });
      }
      result.errors = errors.length;
      result.ms = Date.now() - started;
      results.push(result);
      const status = result.ok ? "ok  " : "FAIL";
      console.log(
        `${status} ${feature.slug.padEnd(34)} ${String(result.ms).padStart(6)} ms` +
          (errors.length ? `  ${errors.length} browser errors` : "") +
          (result.error ? `\n     ${result.error}` : ""),
      );
    }
  } finally {
    await browser?.close();
    await server?.stop();
    rmSync(root, { recursive: true, force: true });
    if (results.some((result) => result.errors))
      items.push({ file: "browser.jsonl", caption: "Browser errors", kind: "log" });
    writeFileSync(join(output, "manifest.json"), `${JSON.stringify({ items }, null, 2)}\n`);
    writeFileSync(join(output, "drive.json"), `${JSON.stringify({ results }, null, 2)}\n`);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  const failed = results.filter((result) => !result.ok).length;
  console.log(`${results.length - failed} of ${results.length} reached. Evidence: ${output}`);
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(`drive: ${error.message}`);
    process.exitCode ||= 1;
  });
