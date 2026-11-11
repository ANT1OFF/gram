/**
 * Where the server answers: `/`, the page's own origin, unless an app in front of Gram mounted this
 * one against a server at another path (`setServerBase`). The socket and the few plain HTTP calls
 * all go through here, so one mount talks to one server.
 */
let base = "/";

/**
 * `input` as a base that ends in `/`: a path on the page's origin (`/cells/acme/`) or a whole
 * `http(s)` URL. Anything else is refused, rather than sent somewhere it wasn't meant to go.
 */
export const serverBaseOf = (input: string | undefined): string => {
  if (input === undefined || input === "" || input === "/") return "/";
  const absolute = /^https?:\/\//i.test(input);
  if (!absolute && !input.startsWith("/"))
    throw new Error(`gram: the server's base must be a path or an http(s) URL, not "${input}"`);
  if (!absolute && input.startsWith("//"))
    throw new Error(`gram: the server's base must name its scheme, not "${input}"`);
  if (/[?#]/.test(input))
    throw new Error(`gram: the server's base takes no query or fragment, not "${input}"`);
  return input.endsWith("/") ? input : `${input}/`;
};

export const setServerBase = (input: string | undefined): void => {
  base = serverBaseOf(input);
};

/** `path` (`/machines/join`, `/?boot=0`) on the server this window talks to. */
export const serverUrl = (path: string): string =>
  base === "/" ? path : `${base}${path.replace(/^\//, "")}`;

/** The RPC socket's URL, for a page at `location`. */
export const socketUrl = (location: { protocol: string; host: string }): string => {
  const path = serverUrl("/ws");
  if (/^https?:\/\//i.test(path)) return path.replace(/^http/i, "ws");
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${path}`;
};
