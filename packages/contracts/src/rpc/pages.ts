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
  Rpc.make("pages.list", {
    payload: PagesListFields,
    success: PageList,
    error: errors(InvalidState, FsError),
  }),
  Rpc.make("pages.pin", {
    payload: PagePinFields,
    success: PageMeta,
    error: errors(NotFound, InvalidState, FsError),
  }),
  Rpc.make("pages.open", {
    payload: PageOpenFields,
    success: PageOpened,
    error: errors(NotFound, InvalidState, FsError),
  }),
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
