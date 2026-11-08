import * as Schema from "effect/Schema";

/**
 * Whether phones and other browsers can reach this Gram over Tailscale Serve: turned on from
 * Settings, off, or fixed by `GRAM_REMOTE_ORIGIN`, which locks the switch.
 */
export const RemoteAccessMode = Schema.Literals(["off", "on", "env"]);
export type RemoteAccessMode = typeof RemoteAccessMode.Type;

/** What Gram found of Tailscale on this machine. Only `ready` can serve phones. */
export const TailscaleState = Schema.Union([
  Schema.Struct({ state: Schema.Literal("ready"), dnsName: Schema.String }),
  Schema.Struct({ state: Schema.Literal("no-https"), dnsName: Schema.String }),
  Schema.Struct({ state: Schema.Literals(["missing", "signed-out", "stopped", "error"]) }),
]);
export type TailscaleState = typeof TailscaleState.Type;

/** A paired browser. `id` is stable for its pairing and is what revoking takes. */
export const RemoteDevice = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  pairedAt: Schema.optionalKey(Schema.Number),
  lastSeenAt: Schema.optionalKey(Schema.Number),
  expiresAt: Schema.Number,
});
export type RemoteDevice = typeof RemoteDevice.Type;

/** The newest pairing link: still open, used by a device, or run out. */
export const RemotePairing = Schema.Union([
  Schema.Struct({ state: Schema.Literal("waiting"), expiresAt: Schema.Number }),
  Schema.Struct({ state: Schema.Literal("paired"), device: Schema.String }),
  Schema.Struct({ state: Schema.Literal("expired") }),
]);
export type RemotePairing = typeof RemotePairing.Type;

/** What `POST /remote/status` answers; a paired browser gets `current` and no `pairing`. */
export const RemoteAccessStatus = Schema.Struct({
  mode: RemoteAccessMode,
  tailscale: TailscaleState,
  /** The HTTPS port phones use: the one in use when on, the one Gram would pick when off. */
  port: Schema.Number,
  /** The address phones open, while on. */
  origin: Schema.optionalKey(Schema.String),
  devices: Schema.Array(RemoteDevice),
  pairing: Schema.optionalKey(RemotePairing),
  /** The asking browser's own device id, when a paired browser asks. */
  current: Schema.optionalKey(Schema.String),
  /** Why access is set on but not serving, such as the port taken by another listener. */
  problem: Schema.optionalKey(Schema.String),
});
export type RemoteAccessStatus = typeof RemoteAccessStatus.Type;

export const MAX_REMOTE_DEVICES = 8;
