import * as Schema from "effect/Schema";

const AppToolsHeaders = Schema.Record(
  Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/)),
  Schema.String.check(Schema.isMaxLength(8192)),
);
/** The most an app-tool call or answer carries, as text: a tool's whole result fits. */
export const HOST_APP_TOOLS_MOST_CHARS = 8 * 1024 * 1024;

/** An app-tool call a session made on the host, as it carries it (`host.appTools.requests`). */
export const HostAppToolsRequest = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9-]{8,64}$/)),
  method: Schema.Literals(["POST", "GET", "DELETE"]),
  headers: AppToolsHeaders,
  body: Schema.String.check(Schema.isMaxLength(HOST_APP_TOOLS_MOST_CHARS)),
  /**
   * The session gave up on the call `id` names before it was answered (its connection closed):
   * the control plane stops answering it, as it does a session that hangs up on it there.
   */
  cancel: Schema.optionalKey(Schema.Literal(true)),
});
export type HostAppToolsRequest = typeof HostAppToolsRequest.Type;

/** The control plane's answer to one (`host.appTools.answer`). */
export const HostAppToolsAnswer = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9-]{8,64}$/)),
  status: Schema.Int,
  headers: AppToolsHeaders,
  body: Schema.String.check(Schema.isMaxLength(HOST_APP_TOOLS_MOST_CHARS)),
});
export type HostAppToolsAnswer = typeof HostAppToolsAnswer.Type;
