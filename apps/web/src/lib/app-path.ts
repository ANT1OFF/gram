let basePath = "";

/** `input` as the router takes it: `/w/acme`, with no trailing slash; the root is `""`. */
export const basePathOf = (input: string | undefined): string => {
  if (input === undefined || input === "" || input === "/") return "";
  if (!input.startsWith("/") || input.startsWith("//") || /[?#]/.test(input))
    throw new Error(`gram: the base path must be a path on this origin, not "${input}"`);
  return input.replace(/\/+$/, "");
};

export const setAppBasePath = (input: string | undefined): void => {
  basePath = basePathOf(input);
};

export const appBasePath = (): string => basePath;

/** `pathname` without the base path, as the router's own paths read: `/t/<id>`. */
export const withoutBasePath = (pathname: string): string => {
  if (basePath === "") return pathname;
  if (pathname === basePath) return "/";
  return pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname;
};

/** The window's path as the app's routes name it, whatever path the app is served under. */
export const appPathname = (): string => withoutBasePath(window.location.pathname);
