import { resubscribing } from "../connection";
import { iterate, run, type RpcContext } from "../rpc-client";
import type { AppApi } from "./types";

/** `AppApi` over the RPC client. */
export const appRpc = ({ client, connection }: RpcContext): AppApi => ({
  usageOverview: (query) => run(client["app.usageOverview"](query)),
  watchWindows: (window, signal) =>
    resubscribing((s) => iterate(client["windows.watch"](window), s), connection, signal),
  reportWindow: (windowId, threadIds, state = {}) =>
    run(
      client["windows.report"]({
        windowId,
        threadIds: [...threadIds],
        ...(state.visible === undefined ? {} : { visible: state.visible }),
        ...(state.focusedThreadId === undefined ? {} : { focusedThreadId: state.focusedThreadId }),
        ...(state.focused === undefined ? {} : { focused: state.focused }),
      }),
    ),
  diagnostics: () => run(client["app.diagnostics"](undefined)),
  diagnosticsReport: (logLines) =>
    run(client["app.diagnosticsReport"](logLines === undefined ? {} : { logLines })),
  openLogsFolder: () => run(client["app.openLogsFolder"](undefined)),
  launchChecks: (refresh) =>
    run(client["app.launchChecks"](refresh === undefined ? {} : { refresh })),
  previewIssue: (draft) => run(client["issues.preview"](draft)),
  fileIssue: (draft) => run(client["issues.file"](draft)),
  openExternal: (externalUrl) => run(client["app.openExternal"]({ url: externalUrl })),
});
