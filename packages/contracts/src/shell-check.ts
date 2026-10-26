import * as Schema from "effect/Schema";

/**
 * Whether a `terminal.shell` value (a Windows profile, an executable name or a path) resolves to an
 * installed shell: `file` when it does, the user-facing `message` when it doesn't.
 */
export const ShellCheck = Schema.Struct({
  found: Schema.Boolean,
  file: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
});
export type ShellCheck = typeof ShellCheck.Type;
