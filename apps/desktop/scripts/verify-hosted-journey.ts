#!/usr/bin/env bun
// The packaged app's hosted journey, end to end, against the test hosted server
// (packages/shell/src/modules/device/hosted-fake.ts) on loopback: hosted features turned on from
// Settings → Machines → Hosted servers, a sign-in whose grant lists workspaces and runs work sent
// to it but lends no device, a workspace whose orchestrator (the echo fake) sends one worker
// there, its approval card answered, and the worker's final reply arriving in the orchestrator's
// chat. It runs the app with `--journey`, which keeps the echo fake agents a packaged build
// otherwise drops, under the environment the smoke uses, and drives its window over the DevTools
// protocol. The person's browser is a stub `xdg-open` that follows the server's redirect back to
// the app, so nothing outside this run is reached. Linux only, under Xvfb:
//
//   xvfb-run -a bun apps/desktop/scripts/verify-hosted-journey.ts <the packaged app's executable>
//
// It prints `JOURNEY OK` and exits 0, or says which step failed and exits 1, leaving the app's
// log and a screenshot of the window in the run's folder, whose path it prints.
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type Page } from "playwright";

import { fakeServer } from "../../../packages/shell/src/modules/device/hosted-fake.ts";

const app = process.argv[2];
if (app === undefined) throw new Error("Name the packaged app's executable");

const work = mkdtempSync(join(tmpdir(), "gram-hosted-journey-"));
for (const dir of ["stubs", "home", "tmp", "electron", "gram"]) mkdirSync(join(work, dir));
console.log(`run folder: ${work}`);

/** A free loopback port for the window's DevTools endpoint. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        resolve(typeof address === "object" && address !== null ? address.port : 0),
      );
    });
  });

// The repository the workspace works in: its remote is one the test server reaches.
const repo = join(work, "shop");
mkdirSync(repo);
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
git("init", "-q", "-b", "main");
writeFileSync(join(repo, "README.md"), "# shop\n");
git("add", ".");
git("-c", "user.name=Journey", "-c", "user.email=journey@example.invalid", "commit", "-qm", "init");
git("remote", "add", "origin", "https://github.com/example/shop.git");

// The test server: it lists one workspace and runs work sent to it, and lends no device.
const fake = fakeServer();
Object.assign(fake.state, { lendsDevices: false, importScope: false, givesThreads: false });
const REPLY = "Done: the README says shop.";
fake.state.waitAnswer = {
  status: 200,
  body: {
    happened: true,
    reason: "reply",
    messages: [],
    latest: "m-2",
    reply: REPLY,
    thread: { title: "Read the README", state: "done", working: false, turns: 1 },
  },
};
const origin = await fake.start();

// No agent CLI or GitHub login is reached, and the browser only follows the sign-in back.
for (const cli of ["claude", "codex", "gh"]) {
  writeFileSync(join(work, "stubs", cli), "#!/bin/sh\nexit 127\n");
  chmodSync(join(work, "stubs", cli), 0o755);
}
writeFileSync(
  join(work, "stubs", "xdg-open"),
  `#!/bin/sh
back=$(curl -s -o /dev/null -w '%{redirect_url}' "$1")
[ -n "$back" ] && curl -s -o /dev/null "$back" &
exit 0
`,
);
chmodSync(join(work, "stubs", "xdg-open"), 0o755);

const port = await freePort();
const child = spawn(
  app,
  [
    "--journey",
    "--password-store=basic",
    `--user-data-dir=${join(work, "electron")}`,
    `--remote-debugging-port=${port}`,
    ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
  ],
  {
    env: {
      PATH: `${join(work, "stubs")}:/usr/bin:/bin`,
      DISPLAY: process.env["DISPLAY"] ?? "",
      XAUTHORITY: process.env["XAUTHORITY"] ?? "",
      HOME: join(work, "home"),
      TMPDIR: join(work, "tmp"),
      XDG_CONFIG_HOME: join(work, "xdg-config"),
      XDG_DATA_HOME: join(work, "xdg-data"),
      XDG_CACHE_HOME: join(work, "xdg-cache"),
      CODEX_HOME: join(work, "codex"),
      CLAUDE_CONFIG_DIR: join(work, "claude"),
      GH_CONFIG_DIR: join(work, "gh"),
      GRAM_DATA_DIR: join(work, "gram"),
      GRAM_FAKE_AGENT: "1",
      GRAM_FAKE_AGENT_REPLY: "echo",
      CI: "1",
      LANG: "C.UTF-8",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let log = "";
child.stdout.on("data", (chunk) => (log += chunk));
child.stderr.on("data", (chunk) => (log += chunk));
let exited: number | null | undefined;
child.on("exit", (code) => (exited = code));

/**
 * Answers a dialog the operating system draws, as the person would with the keyboard: it waits
 * for the window titled `title`, focuses it and presses `keys` (xdotool's names). Main owns these
 * windows, so the page can't answer them; that is why they are dialogs.
 */
const answerDialog = async (title: string, keys: readonly string[]) => {
  for (let tries = 0; tries < 30; tries += 1) {
    let found = "";
    try {
      found = execFileSync("xdotool", ["search", "--name", `^${title}$`], {
        encoding: "utf8",
        env: process.env,
      }).trim();
    } catch {
      found = "";
    }
    const window = found.split("\n").at(-1);
    if (window !== undefined && window !== "") {
      execFileSync("xdotool", ["windowfocus", "--sync", window]);
      await Bun.sleep(300);
      execFileSync("xdotool", ["key", "--window", window, ...keys]);
      return;
    }
    await Bun.sleep(500);
  }
  throw new Error(`no "${title}" dialog showed`);
};

/** Whether the DevTools endpoint lists the app's window. */
const shown = (targets: unknown): boolean =>
  Array.isArray(targets) &&
  targets.some(
    (each: { type?: string; url?: string }) =>
      each.type === "page" && /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(each.url ?? ""),
  );

let page: Page | undefined;
const fail = async (step: string, error: unknown) => {
  console.error(
    `JOURNEY FAIL at ${step}: ${error instanceof Error ? error.message : String(error)}`,
  );
  await page?.screenshot({ path: join(work, "window.png") }).catch(() => undefined);
  writeFileSync(join(work, "app.log"), log);
  console.error(`the app's log: ${join(work, "app.log")}`);
  child.kill("SIGTERM");
  fake.server.close();
  process.exit(1);
};

let step = "the app opens its window";
const at = (next: string) => {
  step = next;
  console.log(`- ${next}`);
};
try {
  at(step);
  // The window first: a connection made before it shows misses it.
  let ready = false;
  for (let tries = 0; !ready && tries < 120; tries += 1) {
    if (exited !== undefined) throw new Error(`the app exited with ${exited}`);
    ready = shown(
      await fetch(`http://127.0.0.1:${port}/json/list`)
        .then((response) => response.json())
        .catch(() => undefined),
    );
    if (!ready) await Bun.sleep(1000);
  }
  if (!ready) throw new Error("no window shows the app");
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((each) => /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(each.url()));
  if (page === undefined) throw new Error("the window isn't reachable");
  const base = new URL(page.url()).origin;
  page.setDefaultTimeout(30_000);
  await page.getByTestId("app-shell").or(page.locator("#root > *")).first().waitFor();

  at("hosted features are turned on from Hosted servers");
  await page.goto(`${base}/settings/hosted-servers`);
  await page.getByRole("button", { name: "Turn on hosted features" }).click();

  at("the sign-in lists the workspace and says it runs sent work");
  await page.getByLabel("Server address").fill(origin);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  // A server not signed in to before is accepted in main's own dialog; Cancel is its default.
  await answerDialog("Sign in to a server", ["shift+Tab", "Return"]);
  const allows = page.getByTestId("hosted-allows");
  await allows.waitFor();
  const said = (await allows.textContent()) ?? "";
  if (!said.startsWith("Runs work sent from here")) throw new Error(`it allows "${said}"`);
  if (said.includes("borrow")) throw new Error(`a grant without lending says "${said}"`);
  await page.getByText("Platform", { exact: false }).first().waitFor();

  at("a workspace with an orchestrator is made in the repository");
  await page.goto(`${base}/new-workspace`);
  const sheet = page.getByRole("form", { name: "New workspace" });
  await sheet.getByPlaceholder("~/code/repo or owner/repo").fill(repo);
  await sheet.getByRole("button", { name: "Add", exact: true }).last().click();
  await sheet.getByRole("button", { name: "Remove shop" }).waitFor();
  await sheet.getByLabel("What should it work on?").fill("Look after the shop");
  await sheet.getByRole("button", { name: /^Start/ }).click();
  await page.getByText("echo: Look after the shop", { exact: true }).waitFor();
  const thread = page.url();

  at("the workspace lets its orchestrator send workers");
  await page.goto(`${base}/settings/workspaces`);
  await page
    .getByRole("listitem", { name: "Workspace shop" })
    .getByTestId("workspace-link")
    .click();
  const sendWork = page.getByTestId("send-work");
  await sendWork.getByRole("switch").click();
  await page
    .locator('[data-testid="send-work"][data-value="on"]')
    .waitFor()
    .catch(async () => {
      // A change that waits on a confirmation is saved from it.
      await page!
        .getByRole("button", { name: /^(Save|Confirm|Turn on)/ })
        .first()
        .click();
      await page!.locator('[data-testid="send-work"][data-value="on"]').waitFor();
    });

  at("the orchestrator sends a worker, and its card names where and on what");
  await page.goto(thread);
  const brief = {
    project: "shop",
    title: "Read the README",
    feature: "readme",
    brief: "Read README.md and say what it says.",
    clientRequestId: "journey-1",
  };
  const composer = page.getByLabel("Message", { exact: true });
  await composer.fill(`/call send_worker ${JSON.stringify(brief)}`);
  await composer.press("Enter");
  const card = page.getByText("Send worker to Example?").first();
  await card.waitFor();
  await page.getByText("Claude · example-model").first().waitFor();

  at("the approval sends it");
  await page
    .getByRole("button", { name: /^(Allow|Approve|Send)/ })
    .first()
    .click();
  await page
    .getByText(/echo: send_worker → .*threadId/)
    .first()
    .waitFor();
  if (fake.state.started.length !== 1) throw new Error(`${fake.state.started.length} starts`);

  at("the worker's final reply reaches the orchestrator's chat");
  // It wakes the orchestrator with a digest that carries it; the echo fake answers with the
  // digest itself, which the chat shows as an update that opens on what it said.
  const update = page
    .getByTestId("update-block")
    .filter({ hasText: "Orchestration digest" })
    .last();
  await update.waitFor({ timeout: 90_000 });
  await update.getByTestId("update-block-toggle").click();
  await update.getByText(REPLY, { exact: false }).first().waitFor();

  console.log("JOURNEY OK");
  await browser.close().catch(() => undefined);
  child.kill("SIGTERM");
  fake.server.close();
  process.exit(0);
} catch (error) {
  await fail(step, error);
}
