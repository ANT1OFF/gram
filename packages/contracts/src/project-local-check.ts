import * as Schema from "effect/Schema";

const ProjectCheckCommand = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(16_384),
  Schema.makeFilter(
    (value) =>
      !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) ||
      "Use a single line without control, invisible format or bidirectional characters.",
  ),
);
export const ProjectCheckPreparation = Schema.Struct({
  manifest: ProjectCheckCommand,
  inputConfigSha256: Schema.optionalKey(
    Schema.String.check(Schema.makeFilter((v) => /^[a-f0-9]{64}$/.test(v) || "Expected SHA-256.")),
  ),
  sha256: Schema.String.check(
    Schema.makeFilter((v) => /^[a-f0-9]{64}$/.test(v) || "Expected SHA-256."),
  ),
});

export const ProjectLocalCheck = Schema.Struct({
  command: Schema.optionalKey(ProjectCheckCommand),
  preparation: Schema.optionalKey(ProjectCheckPreparation),
  setup: Schema.optionalKey(
    Schema.Union([ProjectCheckCommand, Schema.Struct({ source: Schema.Literal("repository") })]),
  ),
  timeoutMs: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 86_400_000 })),
  ),
});
export type ProjectLocalCheck = typeof ProjectLocalCheck.Type;
export const DEFAULT_LOCAL_CHECK_TIMEOUT_MS = 90 * 60_000;
