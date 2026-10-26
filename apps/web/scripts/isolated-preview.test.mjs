import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

import { isPortFree } from "./dev-ports.mjs";
import { previewEnv } from "./isolated-preview.mjs";

const script = fileURLToPath(new URL("./isolated-preview.mjs", import.meta.url));
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), "gram-preview-test-"));
  roots.push(root);
  return root;
};
const run = (args, env, onOutput = () => {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      onOutput(child, output);
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`preview exceeded its test deadline: ${output}`));
    }, 20_000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });

it("interrupting startup cleans temporary state and retains evidence without a browser install", async () => {
  const root = temp();
  const output = join(root, "evidence");
  let signalled = false;
  const result = await run(["--capture", "--output", output], previewEnv(root), (child, text) => {
    if (!signalled && text.includes("Evidence:")) {
      signalled = true;
      child.kill("SIGTERM");
    }
  });
  expect(result.code).toBe(130);
  const meta = JSON.parse(readFileSync(join(output, "preview.json"), "utf8"));
  expect(meta.cleaned).toBe(true);
  expect(existsSync(meta.stateDir)).toBe(false);
  expect(existsSync(join(output, "initial.png"))).toBe(false);
});

it("allowlists the child environment and places config/cache/home under its temporary root", () => {
  const root = temp();
  const env = previewEnv(root, {
    ANTHROPIC_API_KEY: "synthetic-key",
    OPENAI_API_KEY: "synthetic-key",
    GH_TOKEN: "synthetic-key",
    VITE_API: "rpc",
    VITE_EXTRA_SECRET: "synthetic-key",
    GRAM_DEV_SERVER_PORT: "4317",
    NODE_OPTIONS: "--require=/synthetic/preload",
    HTTPS_PROXY: "https://example.invalid",
    CODEX_HOME: "/synthetic/real-codex",
    CLAUDE_CONFIG_DIR: "/synthetic/real-claude",
    HOME: "/synthetic/real-home",
    DISPLAY: ":0",
  });
  expect(env.HOME).toBe(join(root, "home"));
  expect(env.XDG_CONFIG_HOME).toBe(join(root, "home", ".config"));
  for (const key of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GH_TOKEN",
    "VITE_API",
    "VITE_EXTRA_SECRET",
    "GRAM_DEV_SERVER_PORT",
    "NODE_OPTIONS",
    "HTTPS_PROXY",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
  ])
    expect(env).not.toHaveProperty(key);
});

it("a taken explicit port fails without stopping the foreign listener and removes temporary state", async () => {
  const foreign = createServer((_req, res) => res.end("foreign-preview"));
  await new Promise((resolve) => foreign.listen({ port: 0, host: "localhost" }, resolve));
  const port = foreign.address().port;
  const root = temp();
  const output = join(root, "evidence");
  try {
    const result = await run(
      ["--capture", "--port", String(port), "--output", output],
      previewEnv(root),
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain(`port ${port} is served by another process`);
    expect(await (await fetch(`http://localhost:${port}`)).text()).toBe("foreign-preview");
    const meta = JSON.parse(readFileSync(join(output, "preview.json"), "utf8"));
    expect(meta.cleaned).toBe(true);
    expect(existsSync(meta.stateDir)).toBe(false);
    expect(existsSync(join(output, "initial.png"))).toBe(false);
  } finally {
    await new Promise((resolve) => foreign.close(resolve));
  }
}, 30_000);

it("a browser launch failure stops its Vite and removes state while retaining failure evidence", async () => {
  const root = temp();
  const output = join(root, "evidence");
  const result = await run(
    ["--capture", "--chromium", join(root, "missing-browser"), "--output", output],
    previewEnv(root),
  );
  expect(result.code).toBe(1);
  const meta = JSON.parse(readFileSync(join(output, "preview.json"), "utf8"));
  expect(meta.error).toContain("executable");
  expect(meta.cleaned).toBe(true);
  expect(existsSync(meta.stateDir)).toBe(false);
  expect(await isPortFree(Number(new URL(meta.origin).port))).toBe(true);
  expect(() => process.kill(meta.vitePid, 0)).toThrow();
}, 30_000);
