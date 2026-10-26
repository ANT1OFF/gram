import {
  InvalidState,
  MCP_SERVER_NAME_PATTERN,
  EXAMPLE_MCP_HOST,
  type CatalogueAccess,
  type CatalogueServer,
  type ConnectorCatalogue,
  type McpTarget,
} from "@gram/contracts";
import type { Proc } from "@gram/git";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { createHash } from "node:crypto";

/** The platform's own rule for a server's name, which is also its path. */
const PLATFORM_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The group every EXAMPLE user is in, which an open server is assigned to. */
const EVERYONE_GROUP = "SYS_(MCP)_(All Users)";

export interface McpCatalogueShape {
  readonly read: Effect.Effect<ConnectorCatalogue, InvalidState>;
}

/** The catalogue reader; the default reads nothing, so tests never reach GitHub. */
export const McpCatalogue = Context.Reference<McpCatalogueShape>("@gram/server/McpCatalogue", {
  defaultValue: () => ({
    read: Effect.fail(new InvalidState({ message: "The MCP catalogue isn't available here." })),
  }),
});

const catalogueUrl = (id: string) => `https://${EXAMPLE_MCP_HOST}/${id}`;

/**
 * The redirect address Codex signs in with for `url`, which the platform registers per server:
 * the first 9 bytes of the URL's SHA-256, base64url. A URL differing by so much as a trailing
 * slash gets another, which is why the catalogue writes the URL exactly.
 */
export const codexRedirect = (url: string) =>
  `http://127.0.0.1/callback/${createHash("sha256").update(url).digest().subarray(0, 9).toString("base64url")}`;

/** Entra ignores a loopback redirect's port, so Claude Code's random one matches any of these. */
const CLAUDE_REDIRECT = /^http:\/\/localhost(?::\d+)?\/callback$/;

/** A `README.md` table row's title and description, by the server's id from its docs link. */
export const readmeEntries = (
  readme: string,
): ReadonlyMap<string, { readonly title: string; readonly description?: string }> => {
  const entries = new Map<string, { title: string; description?: string }>();
  for (const line of readme.split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    const id = /\]\(mcp\/([a-z0-9-]+)\/README\.md\)/.exec(line)?.[1];
    if (!line.trimStart().startsWith("|") || id === undefined || cells.length < 4) continue;
    const title = cells[1]!.replace(/\*\*/g, "").trim();
    const description = cells[2]!.trim();
    entries.set(id, {
      title: title === "" ? id : title,
      ...(description === "" ? {} : { description }),
    });
  }
  return entries;
};

/** The list items under `key:` in a small YAML file, as plain strings. */
const yamlList = (text: string, key: string, item: RegExp): ReadonlyArray<string> => {
  const lines = text.split("\n");
  const start = lines.findIndex(
    (line) => line.trimEnd() === `${key}:` || line.trim() === `${key}:`,
  );
  if (start === -1) return [];
  const indent = /^\s*/.exec(lines[start]!)![0].length;
  const out: Array<string> = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") continue;
    if (/^\s*/.exec(line)![0].length <= indent && !line.trimStart().startsWith("-")) break;
    const match = item.exec(line);
    if (match?.[1] !== undefined) out.push(match[1].replace(/^['"]|['"]$/g, ""));
  }
  return out;
};

/** Who the app's `base.yml` assigns, by group name. */
export const accessOf = (base: string): CatalogueAccess => {
  const groups = yamlList(base, "role_assignments", /^\s*-\s*name:\s*(.+?)\s*$/);
  return { everyone: groups.includes(EVERYONE_GROUP), groups };
};

/** The agents whose sign-in the app's `auth.yml` has no redirect address for. */
export const signInUnsupportedBy = (auth: string, url: string): ReadonlyArray<McpTarget> => {
  const redirects = yamlList(auth, "public_client_reply_urls", /^\s*-\s*(\S+)\s*$/);
  const accepts: Readonly<Record<McpTarget, boolean>> = {
    claude: redirects.some((uri) => CLAUDE_REDIRECT.test(uri)),
    codex: redirects.includes(codexRedirect(url)),
  };
  return (["claude", "codex"] as const).filter((target) => !accepts[target]);
};

/** Whether `auth.yml` is the production app for `url`, not some other app under the name. */
const servesUrl = (auth: string, url: string) =>
  yamlList(auth, "identifier_uris", /^\s*-\s*(\S+)\s*$/).includes(url);

interface ServersRepo {
  readonly readme: string;
  readonly ids: ReadonlyArray<string>;
}

type AppFiles = ReadonlyMap<string, { readonly auth?: string; readonly base?: string }>;

/**
 * The catalogue from what the two repositories hold. Without the apps repository (`apps`
 * undefined) every server directory with a README row is listed, without access or sign-in
 * support; with it, only those with a production app for their URL.
 */
export const catalogueFrom = (
  servers: ServersRepo,
  apps: AppFiles | undefined,
): ReadonlyArray<CatalogueServer> => {
  const described = readmeEntries(servers.readme);
  return servers.ids
    .filter((id) => PLATFORM_ID.test(id) && MCP_SERVER_NAME_PATTERN.test(id))
    .flatMap((id): ReadonlyArray<CatalogueServer> => {
      const url = catalogueUrl(id);
      const about = described.get(id);
      const base = {
        id,
        title: about?.title ?? id,
        ...(about?.description === undefined ? {} : { description: about.description }),
        url,
      };
      if (apps === undefined) return about === undefined ? [] : [base];
      const app = apps.get(id);
      if (app?.auth === undefined || !servesUrl(app.auth, url)) return [];
      return [
        {
          ...base,
          ...(app.base === undefined ? {} : { access: accessOf(app.base) }),
          signInUnsupported: signInUnsupportedBy(app.auth, url),
        },
      ];
    })
    .toSorted((a, b) => a.title.localeCompare(b.title));
};

/** Public catalogue adapter is pending; manual MCP configuration is available. */
export const McpCatalogueLive: Layer.Layer<never, never, Proc> = Layer.empty;
