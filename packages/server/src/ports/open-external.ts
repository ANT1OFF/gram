import { InvalidState, isExternalUrl } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { Opener, refuseFenced } from "../platform/opener.ts";
import type { Command } from "./pure.ts";

/** The OS command that opens `url` in the default browser, without a shell to quote through. */
export const openCommand = (platform: NodeJS.Platform, url: string): Command =>
  platform === "darwin"
    ? { file: "open", args: [url] }
    : platform === "win32"
      ? { file: "rundll32", args: ["url.dll,FileProtocolHandler", url] }
      : { file: "xdg-open", args: [url] };

/**
 * `app.openExternal`: http(s) only, launched through the `Opener`; a failure is `InvalidState`.
 * Refused outright under the desktop shell, whose own link dialog is the only way out there.
 */
export const openExternal = (
  url: string,
  shellOpensLinks = false,
): Effect.Effect<void, InvalidState> =>
  shellOpensLinks
    ? Effect.fail(new InvalidState({ message: "In the app, links open through its link dialog." }))
    : Effect.gen(function* () {
        const opener = yield* Opener;
        yield* refuseFenced(opener);
        if (!isExternalUrl(url))
          return yield* new InvalidState({ message: `Only http(s) links can be opened: ${url}` });
        yield* opener
          .launch(openCommand(process.platform, url))
          .pipe(Effect.mapError(() => new InvalidState({ message: `Couldn't open ${url}` })));
      });
