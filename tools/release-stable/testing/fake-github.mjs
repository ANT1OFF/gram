// A synthetic GitHub for the stable release tool's tests: the slice of the REST API, the upload
// host and the release download URLs the tool and the app's feeds use, in memory. Writes need a
// token the repository accepts; anonymous reads never see drafts or draft assets. `fake-gh.mjs`
// is the `gh` that talks to it.
//
// The tool runs `gh` synchronously, so the server runs in a process of its own
// (`spawnFakeGitHub`), and the tests read and seed it through `/_fake/*`.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/** Publishes a draft: a publication time, the tag on its target, and latest unless told not to. */
const publish = (repo, release, makeLatest) => {
  release.draft = false;
  release.published_at = new Date().toISOString();
  if (!repo.tags.has(release.tag_name))
    repo.tags.set(
      release.tag_name,
      /^[0-9a-f]{40}$/.test(release.target_commitish) ? release.target_commitish : repo.head,
    );
  if (makeLatest !== "false" && !release.prerelease) repo.latestId = release.id;
};

/**
 * Starts the server. `repos` maps `owner/name` to `{ private, tokens, head, fullName? }`: the
 * tokens that may write it, its default branch's commit and, for a renamed one, the name it
 * answers with. Returns its origin, the state and a request log.
 */
async function startFakeGitHub(repos) {
  const state = new Map(
    Object.entries(repos).map(([name, repo]) => [
      name,
      { ...repo, releases: [], tags: new Map(), latestId: undefined },
    ]),
  );
  const log = [];
  let nextId = 1000;
  let origin = "";

  const view = (repo, release) => ({
    id: release.id,
    tag_name: release.tag_name,
    target_commitish: release.target_commitish,
    name: release.name,
    body: release.body,
    draft: release.draft,
    prerelease: release.prerelease,
    published_at: release.published_at,
    html_url: `${origin}/${repo}/releases/tag/${release.tag_name}`,
    upload_url: `${origin}/uploads/repos/${repo}/releases/${release.id}/assets{?name,label}`,
    assets: release.assets.map(({ bytes: _bytes, ...asset }) => asset),
  });

  const server = createServer(async (req, res) => {
    // No keep-alive: a client reusing a socket the server just timed out reads ECONNRESET.
    res.setHeader("connection", "close");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, origin);
    const token = /^(?:token|Bearer) (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

    if (parts[0] === "_fake") {
      if (parts[1] === "state")
        return json(res, 200, {
          log,
          repos: Object.fromEntries(
            [...state].map(([name, repo]) => [
              name,
              {
                latestId: repo.latestId ?? null,
                tags: Object.fromEntries(repo.tags),
                releases: repo.releases.map((r) => view(name, r)),
              },
            ]),
          ),
        });
      if (parts[1] === "seed") {
        const seeded = seed(JSON.parse(body.toString("utf8")));
        return json(res, 201, view(seeded.repo, seeded.release));
      }
    }
    log.push({ method: req.method, path: url.pathname, token: token ?? null });

    // Release downloads on the web origin: published releases only, never with credentials.
    if (parts[2] === "releases" && parts[3] === "download") {
      const repo = state.get(`${parts[0]}/${parts[1]}`);
      const release = repo?.releases.find((r) => r.tag_name === parts[4] && !r.draft);
      const asset = release?.assets.find((a) => a.name === parts[5]);
      if (!asset) return json(res, 404, { message: "Not Found" });
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(asset.bytes);
    }

    const upload = parts[0] === "uploads";
    const path = upload ? parts.slice(1) : parts;
    if (path[0] !== "repos") return json(res, 404, { message: "Not Found" });
    const name = `${path[1]}/${path[2]}`;
    const repo = state.get(name);
    if (!repo) return json(res, 404, { message: "Not Found" });
    const authorized = token !== undefined && repo.tokens.includes(token);
    if (repo.private && !authorized) return json(res, 404, { message: "Not Found" });
    const write = req.method !== "GET";
    if (write && !authorized)
      return json(res, token ? 403 : 401, {
        message: token ? "Resource not accessible" : "Requires authentication",
      });
    const rest = path.slice(3);
    const visible = (release) => authorized || !release.draft;
    const findRelease = (id) => repo.releases.find((r) => r.id === Number(id) && visible(r));

    if (rest.length === 0)
      return json(res, 200, {
        // A renamed repository answers its old name with its new one.
        full_name: repo.fullName ?? name,
        private: repo.private,
        default_branch: "main",
      });
    if (rest[0] === "commits" && rest[1] === "main") return json(res, 200, { sha: repo.head });
    if (rest[0] === "git" && rest[1] === "ref" && rest[2] === "tags") {
      const sha = repo.tags.get(rest[3]);
      return sha
        ? json(res, 200, { ref: `refs/tags/${rest[3]}`, object: { type: "commit", sha } })
        : json(res, 404, { message: "Not Found" });
    }
    if (rest[0] === "tags" && req.method === "GET")
      return json(
        res,
        200,
        [...repo.tags].map(([tag, sha]) => ({ name: tag, commit: { sha } })),
      );
    if (rest[0] !== "releases") return json(res, 404, { message: "Not Found" });

    if (upload && req.method === "POST" && rest[2] === "assets") {
      const release = findRelease(rest[1]);
      if (!release) return json(res, 404, { message: "Not Found" });
      const assetName = url.searchParams.get("name");
      if (release.assets.some((a) => a.name === assetName))
        return json(res, 422, { message: "already_exists" });
      const asset = {
        id: nextId++,
        name: assetName,
        size: body.length,
        digest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
        browser_download_url: `${origin}/${name}/releases/download/${release.tag_name}/${assetName}`,
        bytes: body,
      };
      release.assets.push(asset);
      const { bytes: _bytes, ...shown } = asset;
      return json(res, 201, shown);
    }
    if (req.method === "GET" && rest.length === 1)
      return json(
        res,
        200,
        repo.releases
          .filter(visible)
          .toReversed()
          .map((r) => view(name, r)),
      );
    if (req.method === "GET" && rest[1] === "latest") {
      const latest = repo.releases.find((r) => r.id === repo.latestId && !r.draft);
      return latest ? json(res, 200, view(name, latest)) : json(res, 404, { message: "Not Found" });
    }
    if (req.method === "GET" && rest[1] === "assets") {
      const release = repo.releases.find(
        (r) => visible(r) && r.assets.some((a) => a.id === Number(rest[2])),
      );
      const asset = release?.assets.find((a) => a.id === Number(rest[2]));
      if (!asset) return json(res, 404, { message: "Not Found" });
      if (req.headers.accept === "application/octet-stream") {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        return res.end(asset.bytes);
      }
      const { bytes: _bytes, ...shown } = asset;
      return json(res, 200, shown);
    }
    if (req.method === "GET" && rest.length === 2) {
      const release = findRelease(rest[1]);
      return release
        ? json(res, 200, view(name, release))
        : json(res, 404, { message: "Not Found" });
    }
    const fields = body.length ? JSON.parse(body.toString("utf8")) : {};
    if (req.method === "POST" && rest.length === 1) {
      if (repo.releases.some((r) => r.tag_name === fields.tag_name))
        return json(res, 422, { message: "already_exists" });
      const release = {
        id: nextId++,
        tag_name: fields.tag_name,
        target_commitish: fields.target_commitish ?? "main",
        name: fields.name ?? "",
        body: fields.body ?? "",
        draft: fields.draft === true,
        prerelease: fields.prerelease === true,
        published_at: null,
        assets: [],
      };
      repo.releases.push(release);
      if (!release.draft) publish(repo, release, fields.make_latest);
      return json(res, 201, view(name, release));
    }
    if (req.method === "PATCH" && rest.length === 2) {
      const release = findRelease(rest[1]);
      if (!release) return json(res, 404, { message: "Not Found" });
      for (const key of ["tag_name", "target_commitish", "name", "body", "prerelease"])
        if (key in fields) release[key] = fields[key];
      if (fields.draft === true) {
        release.draft = true;
        if (repo.latestId === release.id) repo.latestId = undefined;
      } else if (fields.draft === false && release.draft)
        publish(repo, release, fields.make_latest);
      return json(res, 200, view(name, release));
    }
    return json(res, 404, { message: "Not Found" });
  });

  /** Adds a release with `assets` (`{ name, base64 }`), as if cut earlier. */
  const seed = ({
    repo: repoName,
    tag,
    draft = false,
    prerelease = false,
    latest = true,
    target,
    assets = [],
  }) => {
    const repo = state.get(repoName);
    const release = {
      id: nextId++,
      tag_name: tag,
      target_commitish: target ?? repo.head,
      name: tag,
      body: "",
      draft,
      prerelease,
      published_at: draft ? null : new Date().toISOString(),
      assets: assets.map(({ name, base64 }) => {
        const bytes = Buffer.from(base64, "base64");
        return {
          id: nextId++,
          name,
          size: bytes.length,
          digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          bytes,
        };
      }),
    };
    repo.releases.push(release);
    if (!draft) {
      repo.tags.set(tag, release.target_commitish);
      if (latest && !prerelease) repo.latestId = release.id;
    }
    return { repo: repoName, release };
  };

  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    close: () => new Promise((done) => server.close(done)),
  };
}

/**
 * Runs the server in a child process with `repos` (see startFakeGitHub). Returns its origin,
 * `state()` and `seed(release)` through `/_fake/*`, and `close()`.
 */
export async function spawnFakeGitHub(repos) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), JSON.stringify(repos)], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const origin = await new Promise((done, reject) => {
    child.once("exit", (code) => reject(new Error(`fake GitHub exited ${code}`)));
    child.stdout.once("data", (chunk) => done(chunk.toString("utf8").trim()));
  });
  const call = async (path, body) => {
    const response = await fetch(`${origin}/_fake/${path}`, {
      method: body ? "POST" : "GET",
      body: body ? JSON.stringify(body) : undefined,
    });
    return response.json();
  };
  return {
    origin,
    state: () => call("state"),
    seed: (release) => call("seed", release),
    close: () =>
      new Promise((done) => {
        child.once("exit", done);
        child.kill();
      }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startFakeGitHub(JSON.parse(process.argv[2] ?? readFileSync(0, "utf8")));
  process.stdout.write(`${server.origin}\n`);
}
