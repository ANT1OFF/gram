import * as Schema from "effect/Schema";
import { HostId } from "./ids.ts";

/**
 * The machine a checkout lives on and its agents run on. Today every host is this machine, so
 * every record is `local`; a paired machine gets a stable id derived from its own key. A path is
 * only meaningful on its host, which is why code that reaches into a checkout takes a
 * `CheckoutRef` rather than a bare path.
 */
export const LOCAL_HOST_ID = HostId.make("local");

/** A checkout's place: the host it lives on and its path there. */
export const CheckoutRef = Schema.Struct({ hostId: HostId, path: Schema.String });
export type CheckoutRef = typeof CheckoutRef.Type;

/** A record's host, where an absent one is this machine: everything written before hosts were. */
export const hostOf = (record: { readonly hostId?: HostId | undefined }): HostId =>
  record.hostId ?? LOCAL_HOST_ID;

/** `true` when the record is on this machine. */
export const isLocalHost = (record: { readonly hostId?: HostId | undefined }): boolean =>
  hostOf(record) === LOCAL_HOST_ID;

/** A checkout's `CheckoutRef`. */
export const checkoutRef = (checkout: {
  readonly path: string;
  readonly hostId?: HostId | undefined;
}): CheckoutRef => ({ hostId: hostOf(checkout), path: checkout.path });

/** Two refs name the same place: the same host, and the same path compared as given. */
export const sameCheckoutRef = (a: CheckoutRef, b: CheckoutRef): boolean =>
  a.hostId === b.hostId && a.path === b.path;

/** No host by that id is paired, or it is not connected now. */
export class HostUnavailable extends Schema.TaggedError<HostUnavailable>()("HostUnavailable", {
  hostId: HostId,
  message: Schema.String,
}) {}

const MACHINE_PROJECT = "gram-host:";

/**
 * The project a joined machine's one-off threads belong to: one per machine, its root this key
 * rather than a folder, so no path on that machine is ever taken for one on this disk. Each such
 * thread's own folder is its checkout, with the machine's `hostId`.
 */
export const machineProjectRoot = (hostId: HostId): string => `${MACHINE_PROJECT}${hostId}`;

/** The joined machine a project stands for (`machineProjectRoot`); `undefined` for a folder here. */
export const machineOfProject = (project: { readonly root: string }): HostId | undefined =>
  project.root.startsWith(MACHINE_PROJECT) && project.root.length > MACHINE_PROJECT.length
    ? HostId.make(project.root.slice(MACHINE_PROJECT.length))
    : undefined;

/** A project that is a folder on this machine, not a joined machine's (`machineProjectRoot`). */
export const isFolderProject = (project: { readonly root: string }): boolean =>
  machineOfProject(project) === undefined;
