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
 * Why whoever runs a machine says it stopped, in Gram's own words for any provider:
 * - `idle`: it paused itself with nothing to do, and starts again when work wants it;
 * - `released`: its work is over, and it is let go once idle;
 * - `reclaimed`: its compute was taken away (a spot interruption, a node drained or replaced);
 * - `requested`: someone stopped it;
 * - `failed`: it died or couldn't start.
 */
export const MachineStopCause = Schema.Literals([
  "idle",
  "released",
  "reclaimed",
  "requested",
  "failed",
]);
export type MachineStopCause = typeof MachineStopCause.Type;

/** The longest provider message a machine's state carries. */
export const MACHINE_PROVIDER_MESSAGE_MAX = 300;

/**
 * What whoever runs a provisioned machine last said of it while it is offline: where it stands
 * there (`phase`), why it stopped, the provider's own short line, and since when (epoch ms), with
 * when Gram heard it (`at`). All the provider's word; never kept across a restart of this Gram.
 */
export const MachineProviderWord = Schema.Struct({
  phase: Schema.Literals(["starting", "running", "stopped", "failed"]),
  cause: Schema.optionalKey(MachineStopCause),
  message: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(MACHINE_PROVIDER_MESSAGE_MAX)),
  ),
  since: Schema.optionalKey(Schema.Number),
  at: Schema.Number,
});
export type MachineProviderWord = typeof MachineProviderWord.Type;

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
  /**
   * Epoch ms since a thread has waited on it to be started, as whoever runs the machines starts a
   * stopped one when it is wanted; set only while it is offline and something waits.
   */
  starting: Schema.optionalKey(Schema.Number),
  /**
   * Epoch ms since its threads' folders have been put back, as near as this Gram knows (it came
   * back online then): it dialled in after a stop or on another disk and owes a resume, so no
   * session opens on it until that is done. Set only while it is online.
   */
  restoring: Schema.optionalKey(Schema.Number),
  /**
   * Epoch ms since putting its threads back has made no progress for long enough that what waits
   * on it was told so (`StopMarks.stalled`). Set only with `restoring`.
   */
  stalled: Schema.optionalKey(Schema.Number),
  /**
   * Epoch ms it was readied to stop, for a machine that then left: paused while idle, as whoever
   * runs the machines stops one with nothing to do. Set only while it is offline.
   */
  paused: Schema.optionalKey(Schema.Number),
  /** What whoever runs it last said of it (`MachineProviderWord`); set only while it is offline. */
  provider: Schema.optionalKey(MachineProviderWord),
  /**
   * The hosted server a provisioned host came through, for a worker's machine a desktop asked one
   * for: the server's own name for itself, and its mark as a `data:` image where it gave one
   * (`hosted-logo.ts`). A thread on it is said to run on that server's machine.
   */
  hosted: Schema.optionalKey(
    Schema.Struct({ name: Schema.String, logo: Schema.optionalKey(Schema.String) }),
  ),
});
export type MachineState = typeof MachineState.Type;
