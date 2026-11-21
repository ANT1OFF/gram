/**
 * The key only this page's origin holds (the server's `auth.ts`): the boot redirect hands it over in
 * the URL fragment, which no server is ever sent, and the page keeps it in its origin's own storage,
 * which a page on another port of this host can't read, as it can read the launch cookie. Every
 * request to the server carries it: a header on plain HTTP, a subprotocol on the socket.
 */

const STORAGE_KEY = "gram-origin-key";
/** As the server's `ORIGIN_KEY_FRAGMENT`, `ORIGIN_KEY_HEADER` and `ORIGIN_KEY_PROTOCOL`. */
const FRAGMENT = "gram-key=";
const HEADER = "x-gram-key";
const PROTOCOL = "gram-key.";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

const storageOf = (): Storage | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

/**
 * Keeps the key a boot redirect put in `location`'s fragment, and takes the fragment off the address
 * so it isn't left in the history or shown. Run before anything reads the address.
 */
export const takeOriginKey = (
  location: Pick<Location, "hash" | "pathname" | "search">,
  history: Pick<History, "replaceState" | "state">,
  storage: Storage | undefined = storageOf(),
): void => {
  const hash = location.hash.replace(/^#/, "");
  if (!hash.startsWith(FRAGMENT)) return;
  const key = hash.slice(FRAGMENT.length);
  if (/^[a-f0-9]{64}$/.test(key)) storage?.setItem(STORAGE_KEY, key);
  history.replaceState(history.state, "", `${location.pathname}${location.search}`);
};

/** The key this origin was handed, if it was. */
export const originKey = (storage: Storage | undefined = storageOf()): string | undefined =>
  storage?.getItem(STORAGE_KEY) ?? undefined;

/** `init` with the origin key's header added, where the page has one. */
export const withOriginKey = (init: RequestInit = {}, key = originKey()): RequestInit => {
  if (key === undefined) return init;
  const headers = new Headers(init.headers);
  headers.set(HEADER, key);
  return { ...init, headers };
};

/** The socket's subprotocols: the origin key's, where the page has one. */
export const originKeyProtocols = (key = originKey()): Array<string> | undefined =>
  key === undefined ? undefined : [`${PROTOCOL}${key}`];
