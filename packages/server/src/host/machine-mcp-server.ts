/**
 * The variable that gives every agent session a joined machine opens one more MCP server, the
 * machine's own (`machineMcpServerFrom`). Whatever starts the host sets it, such as a platform
 * that runs a relay to its own MCP server beside the host.
 */
export const MACHINE_MCP_SERVER_ENV = "GRAM_HOST_MCP_SERVER";

/** A server's name as the agents' configs take one: Codex makes it a TOML key. */
const NAME = /^[A-Za-z0-9_-]{1,64}$/;

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

export interface MachineMcpServer {
  readonly name: string;
  readonly url: string;
}

/**
 * The MCP server `value` (`GRAM_HOST_MCP_SERVER`, JSON `{"name":"…","url":"…"}`) names, or why it
 * isn't one. Unset or empty: none, and no error. The address is a remote (streamable HTTP) server
 * reached with no credential of Gram's: `https:`, or `http:` on loopback only, with no user or
 * password in it, since the agents' configs and logs show it.
 */
export const machineMcpServerFrom = (
  value: string | undefined,
): { readonly server: MachineMcpServer | undefined; readonly error?: string } => {
  if (value === undefined || value.trim() === "") return { server: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { server: undefined, error: "isn't JSON" };
  }
  if (typeof parsed !== "object" || parsed === null)
    return { server: undefined, error: "isn't an object" };
  const { name, url } = parsed as Record<string, unknown>;
  if (typeof name !== "string" || !NAME.test(name))
    return { server: undefined, error: "names no server (letters, digits, _ and -, at most 64)" };
  if (typeof url !== "string") return { server: undefined, error: "has no url" };
  let address: URL;
  try {
    address = new URL(url);
  } catch {
    return { server: undefined, error: "has a url that isn't one" };
  }
  if (address.username !== "" || address.password !== "")
    return { server: undefined, error: "has a url with a user or password in it" };
  const secure = address.protocol === "https:";
  const local = address.protocol === "http:" && LOOPBACK.has(address.hostname);
  if (!secure && !local)
    return { server: undefined, error: "has a url that is neither https: nor http: on loopback" };
  return { server: { name, url: address.href } };
};
