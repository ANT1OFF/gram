// The read-only update check of tools/release-stable/stable.mjs: what an install of `--current`
// would be offered on each channel, through the app's own feed (apps/desktop/src/main/update/
// native-feed.ts) from `--source`. Run with Bun, which resolves the feed's imports.
//
//   bun update-check.mjs --source <checkout> --feed private|public --repo <owner/name>
//                        --current <version> [--simulate-publish <tag>]
//                        [--api <origin>] [--web <origin>]
//
// The private feed is the app's `gh` feed, through your own `gh` login, which sees drafts; every
// call here is a GET, and anything else throws. `--simulate-publish` shows a draft as GitHub would serve it once published (draft false,
// a publication time); nothing on GitHub changes. The public feed reads anonymously: no `gh`, no
// credentials. Downloads are refused either way. Prints one JSON line per channel.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    feed: { type: "string" },
    repo: { type: "string" },
    current: { type: "string" },
    "simulate-publish": { type: "string" },
    api: { type: "string" },
    web: { type: "string" },
  },
});
const { source, feed, repo, current } = values;
if (!source || !["private", "public"].includes(feed ?? "") || !repo || !current)
  throw new Error("update-check needs --source, --feed private|public, --repo and --current.");
const simulate = values["simulate-publish"];
if (simulate && feed !== "private")
  throw new Error("--simulate-publish needs the private feed: drafts are invisible anonymously.");

const { createGhFeed, createPublicFeed } = await import(
  pathToFileURL(resolve(source, "apps/desktop/src/main/update/native-feed.ts")).href
);

/** gh, refusing anything but a read. */
const readOnlyGh = async (args, options) => {
  const write = args.some((arg, i) =>
    ["-X", "--method"].includes(arg)
      ? !/^GET$/i.test(args[i + 1] ?? "")
      : /^(-f|-F|--field|--raw-field|--input)$/.test(arg),
  );
  if (write || !["api", "auth"].includes(args[0]))
    throw new Error(`update-check refuses gh ${args.join(" ")}: it only reads.`);
  const r = spawnSync("gh", args, {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: 16 * 1024 ** 2,
  });
  let stdout = r.stdout ?? "";
  if (simulate && r.status === 0 && args.at(-1) === `repos/${repo}/releases?per_page=30`) {
    const list = JSON.parse(stdout).map((release) =>
      release.tag_name === simulate && release.draft
        ? { ...release, draft: false, published_at: new Date().toISOString() }
        : release,
    );
    stdout = JSON.stringify(list);
  }
  return { status: r.error ? null : r.status, stdout, stderr: r.stderr ?? String(r.error ?? "") };
};

/** An anonymous GET: no cookies, no Authorization header. */
const anonymousFetch = async (url, { accept, maxBytes, redirect }) => {
  const response = await fetch(url, { headers: { accept }, redirect, credentials: "omit" });
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > maxBytes) throw new Error(`${url} is over ${maxBytes} bytes.`);
  return { status: response.status, body: body.toString("utf8") };
};

/** Marks the result lines, apart from anything a dependency prints. */
const RESULT = "GRAM-UPDATE-CHECK";

const temp = mkdtempSync(join(tmpdir(), "gram-update-check-"));
try {
  for (const channel of ["stable", "prerelease"]) {
    const releases =
      feed === "private"
        ? createGhFeed({ gh: readOnlyGh, repo, tempDir: temp, currentVersion: current })
        : createPublicFeed({
            fetch: anonymousFetch,
            repo,
            currentVersion: current,
            ...(values.api ? { api: values.api } : {}),
            ...(values.web ? { web: values.web } : {}),
          });
    const info = await releases.latest(channel);
    const picked = releases.picked();
    process.stdout.write(
      `${RESULT} ${JSON.stringify(
        info.version === current || !picked
          ? { channel, status: "upToDate", version: current }
          : {
              channel,
              status: "available",
              version: info.version,
              tag: picked.tag,
              zip: { id: picked.zip.id, name: picked.zip.name, digest: picked.zip.digest },
              manifest: { id: picked.manifest.id, name: picked.manifest.name },
              url: feed === "public" ? releases.assetUrl(picked.zip).href : undefined,
            },
      )}\n`,
    );
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
