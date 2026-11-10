import { isIP } from "node:net";

/**
 * Provisioned hosts: for a Gram that something else runs and places work on (a self-hosted or
 * embedded install), where hosts are made by that system rather than joined by a person. Such a
 * host makes its key itself (`gram-host provision`), the control plane registers the public half,
 * and the host dials a listener of its own over ordinary TLS: no Tailscale, no join link and no
 * fingerprint to confirm. A dial is signed exactly as a joined machine's is, and the host protocol
 * it then speaks is the same.
 */

/** The environment that turns the provisioned-host listener on; all unset, there is none. */
export const PROVISIONED_ORIGIN_ENV = "GRAM_PROVISIONED_ORIGIN";
export const PROVISIONED_PORT_ENV = "GRAM_PROVISIONED_PORT";
export const PROVISIONED_LISTEN_HOST_ENV = "GRAM_PROVISIONED_LISTEN_HOST";
export const PROVISIONED_TLS_CERT_ENV = "GRAM_PROVISIONED_TLS_CERT";
export const PROVISIONED_TLS_KEY_ENV = "GRAM_PROVISIONED_TLS_KEY";

const NOT_AN_ORIGIN =
  "A provisioned-host address must be one canonical https:// origin, such as https://gram.internal:8443.";

/**
 * The address provisioned hosts dial, which every dial is signed for: one canonical `https:`
 * origin, nothing after the host and port. Never `http:`, so a dial's signed headers and what it
 * serves are never sent in the clear. A tailnet address is refused: that one is for joined
 * machines, and the two never share an address.
 */
export const provisionedOrigin = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(NOT_AN_ORIGIN);
  }
  if (value !== url.origin || url.protocol !== "https:" || url.hostname === "")
    throw new Error(NOT_AN_ORIGIN);
  if (url.hostname.endsWith(".ts.net"))
    throw new Error("A provisioned-host address can't be a tailnet address.");
  return value;
};

/** Where the server listens for provisioned hosts, and the certificate it shows them. */
export interface ProvisionedHostsConfig {
  /** What hosts dial and sign for, `https://<name>[:port]`. */
  readonly origin: string;
  /** The port the listener binds, which the origin's port reaches (directly or mapped). */
  readonly port: number;
  /** The address it binds: every interface unless told otherwise. */
  readonly listenHost: string;
  /** PEM files: the certificate chain for the origin's name, and its private key. */
  readonly certFile: string;
  readonly keyFile: string;
}

/**
 * The listener's config from the environment: undefined when none of it is set, and an error when
 * only part is, so a typo never leaves a listener half configured or silently off.
 */
export const provisionedHostsFrom = (
  env: Record<string, string | undefined>,
): ProvisionedHostsConfig | undefined => {
  const set = (name: string) => {
    const value = env[name];
    return value === undefined || value === "" ? undefined : value;
  };
  const origin = set(PROVISIONED_ORIGIN_ENV);
  const port = set(PROVISIONED_PORT_ENV);
  const listenHost = set(PROVISIONED_LISTEN_HOST_ENV);
  const certFile = set(PROVISIONED_TLS_CERT_ENV);
  const keyFile = set(PROVISIONED_TLS_KEY_ENV);
  if ([origin, port, listenHost, certFile, keyFile].every((value) => value === undefined))
    return undefined;
  if (origin === undefined || certFile === undefined || keyFile === undefined)
    throw new Error(
      `Provisioned hosts need ${PROVISIONED_ORIGIN_ENV}, ${PROVISIONED_TLS_CERT_ENV} and ${PROVISIONED_TLS_KEY_ENV} together.`,
    );
  const url = new URL(provisionedOrigin(origin));
  const bound = port ?? (url.port === "" ? "443" : url.port);
  if (!/^[0-9]{1,5}$/.test(bound) || Number(bound) < 1 || Number(bound) > 65535)
    throw new Error(`${PROVISIONED_PORT_ENV} must be a port from 1 to 65535.`);
  if (listenHost !== undefined && isIP(listenHost) === 0)
    throw new Error(`${PROVISIONED_LISTEN_HOST_ENV} must be an IP address to listen on.`);
  return {
    origin,
    port: Number(bound),
    listenHost: listenHost ?? "0.0.0.0",
    certFile,
    keyFile,
  };
};
