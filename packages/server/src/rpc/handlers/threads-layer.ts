import { ThreadRpcs } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { babysitHandlers } from "../../babysit/handler.ts";
import { searchHandlers } from "../../search/handler.ts";
import { threadWakeHandlers } from "../../wakes/thread-wakes.ts";
import { checkoutUseHandlers } from "./checkout-use.ts";
import { closedThreadHandlers } from "./closed-threads.ts";
import { logDefects } from "./common.ts";
import { sidebarHandlers } from "./sidebar.ts";
import { threadHandlers } from "./threads.ts";

/**
 * The threads group's handler layer: the thread handlers and the files beside them that serve a
 * thread's search, babysitting, close and reopen, sidebar row and wakes.
 */
export const ThreadHandlersLive = ThreadRpcs.toLayer(
  Effect.gen(function* () {
    const handlers = {
      ...(yield* threadHandlers),
      ...(yield* searchHandlers),
      ...(yield* babysitHandlers),
      ...(yield* closedThreadHandlers),
      ...(yield* checkoutUseHandlers),
      ...(yield* sidebarHandlers),
      ...(yield* threadWakeHandlers),
    };
    return ThreadRpcs.of(logDefects(ThreadRpcs, handlers));
  }),
);
