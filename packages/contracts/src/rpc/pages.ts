import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { FsError, InvalidState, NotFound } from "../errors.ts";
import {
  PageList,
  PageMeta,
  PageOpened,
  PageOpenFields,
  PagePinFields,
  PageShowOfferFields,
  PagesListFields,
  PageUnpinFields,
} from "../pages.ts";
import { errors } from "./shared.ts";

/**
 * Pinned pages (`pages.ts`): the Pages tab's list, opening one, and the user's own pin, show and
 * unpin. No agent tool calls any of these; an agent only offers a version (`offer_page_version`).
 */
export const PageRpcs = RpcGroup.make(
  /** The workspace's pinned pages, newest pin first. */
  Rpc.make("pages.list", {
    payload: PagesListFields,
    success: PageList,
    error: errors(InvalidState, FsError),
  }),
  /**
   * Pins the HTML file `threadId`'s Preview tab shows, copying its folder into Gram's state. The
   * file must be in the thread's own folders on this machine. `InvalidState` for anything else, a
   * folder past the bundle's limits included.
   */
  Rpc.make("pages.pin", {
    payload: PagePinFields,
    success: PageMeta,
    error: errors(NotFound, InvalidState, FsError),
  }),
  /** The shown version's URL on the page listener, for the shell's `gram-pages` session only. */
  Rpc.make("pages.open", {
    payload: PageOpenFields,
    success: PageOpened,
    error: errors(NotFound, InvalidState, FsError),
  }),
  /** Shows the offered `version`; `InvalidState` once another offer replaced it. */
  Rpc.make("pages.showOffer", {
    payload: PageShowOfferFields,
    success: PageMeta,
    error: errors(NotFound, InvalidState, FsError),
  }),
  Rpc.make("pages.unpin", {
    payload: PageUnpinFields,
    success: Schema.Void,
    error: errors(NotFound, InvalidState, FsError),
  }),
);
