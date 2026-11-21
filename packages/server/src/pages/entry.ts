import {
  checkoutRoots,
  effectiveCheckout,
  InvalidState,
  isLocalHost,
  type NotFound,
  previewFileFragment,
  previewFileKind,
  type Thread,
} from "@gram/contracts";
import * as Effect from "effect/Effect";

import { previewTarget } from "../fs/files.ts";
import { pageFolderCheck } from "../preview/files.ts";

const OUTSIDE = "is outside this thread's folders; a page is pinned from a folder of the thread's";

/** The real path of the HTML file `path` names in `thread`'s folders, for a pin or an offer. */
export const pageEntryOf = (
  thread: Thread,
  path: string,
): Effect.Effect<string, InvalidState | NotFound> =>
  Effect.gen(function* () {
    const file = previewFileFragment(path).path;
    if (previewFileKind(file) !== "html") {
      return yield* new InvalidState({ message: `${file} isn't an HTML file` });
    }
    if (!isLocalHost(effectiveCheckout(thread))) {
      return yield* new InvalidState({
        message: "Pages are pinned from threads on this computer, not a joined machine",
      });
    }
    const roots = [...checkoutRoots(thread), ...(thread.additionalDirectories ?? [])];
    const { target } = yield* previewTarget(file, roots, {
      allows: Effect.succeed(false),
      refusal: OUTSIDE,
    });
    return yield* pageFolderCheck(target, false, roots);
  });
