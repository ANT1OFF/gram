import { AppRpcs } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { diagnosticsHandlers } from "../../diagnostics/handler.ts";
import { issueHandlers } from "../../issues/handler.ts";
import { launchChecksHandlers } from "../../launch-checks/handler.ts";
import { agentSupportHandlers } from "../../agent-support/handler.ts";
import { appHandlers } from "./app.ts";
import { logDefects } from "./common.ts";
import { windowsHandlers } from "./windows.ts";
import { usageHandlers } from "../../usage/handler.ts";

/**
 * The app group's handler layer: the event feed, windows, diagnostics, issues and launch checks.
 * Apart from `app.ts`, which the diagnostics and issues handlers import.
 */
export const AppHandlersLive = AppRpcs.toLayer(
  Effect.gen(function* () {
    const handlers = {
      ...(yield* usageHandlers),
      ...(yield* appHandlers),
      ...(yield* windowsHandlers),
      ...(yield* diagnosticsHandlers),
      ...(yield* launchChecksHandlers),
      ...(yield* agentSupportHandlers),
      ...(yield* issueHandlers),
    };
    return AppRpcs.of(logDefects(AppRpcs, handlers));
  }),
);
