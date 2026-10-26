#!/usr/bin/env node
// The `gh` of the stable release tool's tests: `gh auth status` and `gh api`, sent to the
// synthetic GitHub at FAKE_GITHUB (fake-github.mjs). Like gh, it authenticates with GH_TOKEN when
// set, otherwise with the login in GH_CONFIG_DIR (a `fake-login` file holding a token). With
// FAKE_GH_DROP_RESPONSE it can lose a request's answer after the server applied it. Each call
// appends its arguments, whether GH_TOKEN was set and the variables named like a token, to
// FAKE_GH_LOG.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const origin = process.env.FAKE_GITHUB;
if (process.env.FAKE_GH_LOG)
  appendFileSync(
    process.env.FAKE_GH_LOG,
    `${JSON.stringify({
      args,
      ghToken: Boolean(process.env.GH_TOKEN),
      tokenVariables: Object.keys(process.env).filter((key) => /TOKEN/.test(key)),
    })}\n`,
  );
const login = () => {
  const file = join(process.env.GH_CONFIG_DIR ?? "/nonexistent", "fake-login");
  return existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
};
const token = process.env.GH_TOKEN || login();
// Like gh, a GH_HOST elsewhere sends the request (and its token) there; here that just fails.
if (process.env.GH_HOST && process.env.GH_HOST !== "github.com") {
  process.stderr.write(`fake gh: would have called ${process.env.GH_HOST}\n`);
  process.exit(3);
}

if (args[0] === "auth" && args[1] === "status") {
  if (token) process.exit(0);
  process.stderr.write("You are not logged into any GitHub hosts. To log in, run: gh auth login\n");
  process.exit(1);
}
if (args[0] !== "api") {
  process.stderr.write(`fake gh: unsupported command ${args.join(" ")}\n`);
  process.exit(2);
}

let method;
let input;
const headers = {};
const fields = {};
let endpoint;
for (let i = 1; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--hostname") i++;
  else if (arg === "--paginate") continue;
  else if (arg === "-X" || arg === "--method") method = args[++i];
  else if (arg === "-H" || arg === "--header") {
    const [key, ...value] = args[++i].split(":");
    headers[key.trim().toLowerCase()] = value.join(":").trim();
  } else if (arg === "--input") input = args[++i];
  else if (arg === "-f" || arg === "--raw-field" || arg === "-F" || arg === "--field") {
    const typed = arg === "-F" || arg === "--field";
    const [key, ...rest] = args[++i].split("=");
    const raw = rest.join("=");
    fields[key] = !typed
      ? raw
      : raw.startsWith("@")
        ? readFileSync(raw.slice(1), "utf8")
        : raw === "true" || raw === "false"
          ? raw === "true"
          : /^\d+$/.test(raw)
            ? Number(raw)
            : raw;
  } else if (endpoint === undefined) endpoint = arg;
  else {
    process.stderr.write(`fake gh: unexpected ${arg}\n`);
    process.exit(2);
  }
}
const url = /^https?:\/\//.test(endpoint)
  ? endpoint
      .replace(/^https:\/\/api\.github\.com/, origin)
      .replace(/^https:\/\/uploads\.github\.com/, `${origin}/uploads`)
  : `${origin}/${endpoint.replace(/^\//, "")}`;
const body = input
  ? readFileSync(input)
  : Object.keys(fields).length
    ? JSON.stringify(fields)
    : undefined;
const response = await fetch(url, {
  method: method ?? (body ? "POST" : "GET"),
  headers: {
    ...headers,
    ...(token ? { authorization: `token ${token}` } : {}),
    ...(input ? {} : body ? { "content-type": "application/json" } : {}),
  },
  body,
});
const out = Buffer.from(await response.arrayBuffer());
// A lost answer: the server applied the request, but gh reports a failure, as on a dropped
// connection. FAKE_GH_DROP_RESPONSE is a pattern matched against the arguments.
if (
  process.env.FAKE_GH_DROP_RESPONSE &&
  new RegExp(process.env.FAKE_GH_DROP_RESPONSE).test(args.join(" "))
) {
  process.stderr.write("gh: read tcp: connection reset by peer\n");
  process.exit(1);
}
if (response.status >= 400) {
  let message = out.toString("utf8");
  try {
    message = JSON.parse(message).message;
  } catch {}
  process.stderr.write(`gh: ${message} (HTTP ${response.status})\n`);
  process.exit(1);
}
process.stdout.write(out);
