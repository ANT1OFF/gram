import * as Schema from "effect/Schema";
import { HostId } from "./ids.ts";

/**
 * Why Tailscale on this computer lets no machine dial in while access over it is on: it is missing,
 * signed out, stopped, without HTTPS certificates or not answering, or Gram couldn't set up its
 * Serve listener (`serve`).
 */
export const TailscaleDown = Schema.Literals([
  "missing",
  "signed-out",
  "stopped",
  "no-https",
  "error",
  "serve",
]);
export type TailscaleDown = typeof TailscaleDown.Type;

/**
 * Why a machine is offline, as this Gram last saw it: the last reason it dropped or was refused
 * since this Gram started, that access over Tailscale is off or down here, or that it hasn't
 * dialled since. Times are epoch ms. Nothing of a dial itself (its signature, nonce or key) is here.
 */
export const MachineOffline = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("never") }),
  Schema.Struct({ kind: Schema.Literal("tailscale-off") }),
  Schema.Struct({ kind: Schema.Literal("tailscale-down"), cause: TailscaleDown }),
  Schema.Struct({ kind: Schema.Literal("unconfirmed"), at: Schema.Number }),
  Schema.Struct({ kind: Schema.Literal("bad-signature"), at: Schema.Number }),
  /** Its clock against this machine's: positive when it is ahead. */
  Schema.Struct({ kind: Schema.Literal("clock"), at: Schema.Number, skewMs: Schema.Number }),
  Schema.Struct({
    kind: Schema.Literal("mismatch"),
    at: Schema.Number,
    protocol: Schema.Number,
    release: Schema.optionalKey(Schema.String),
    missing: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  Schema.Struct({ kind: Schema.Literal("no-hello"), at: Schema.Number }),
  Schema.Struct({ kind: Schema.Literal("lost"), at: Schema.Number }),
  Schema.Struct({ kind: Schema.Literal("moved"), at: Schema.Number }),
]);
export type MachineOffline = typeof MachineOffline.Type;

/** How a machine got in: joined by a person with a link, or registered by a control plane's key. */
export const MachineKind = Schema.Literals(["joined", "provisioned"]);
export type MachineKind = typeof MachineKind.Type;

/**
 * A confirmed machine as a thread that runs on it shows it, on every client: its name, how it got
 * in, and whether it is dialled in now. Far less than Settings → Machines lists, which stays the
 * local app's: no fingerprint, sign-in, tools, SSH target or update.
 */
export const MachineState = Schema.Struct({
  id: HostId,
  name: Schema.String,
  kind: MachineKind,
  /** Set while it is connected. */
  onlineSince: Schema.optionalKey(Schema.Number),
  /** Why it is offline; set only while it isn't connected. */
  offline: Schema.optionalKey(MachineOffline),
});
export type MachineState = typeof MachineState.Type;
