import { type Checkout, hostOf, type HostId, isLocalHost } from "@gram/contracts";

/** A thread's checkout on a joined machine, where its check runs through that machine's host. */
export interface MachineCheckSite {
  readonly hostId: HostId;
  /** The checkout's folder there. */
  readonly path: string;
  /** The machine's clone it was made from. */
  readonly repoRoot?: string | undefined;
}

/** Where a check runs: a folder of this machine's repository, or a joined machine's checkout. */
export type CheckSite = string | MachineCheckSite;

/**
 * Where the check of `checkout`'s thread runs: `here`, a folder on this machine, for a checkout on
 * this machine; the checkout itself on the joined machine it is on.
 */
export const checkSiteOf = (
  checkout: Pick<Checkout, "path" | "repoRoot" | "hostId">,
  here: string,
): CheckSite =>
  isLocalHost(checkout)
    ? here
    : {
        hostId: hostOf(checkout),
        path: checkout.path,
        ...(checkout.repoRoot === undefined ? {} : { repoRoot: checkout.repoRoot }),
      };
