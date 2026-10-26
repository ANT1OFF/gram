import * as Schema from "effect/Schema";

/** An image from the checkout for the Files panel and markdown previews, as base64. */
export const FileImage = Schema.Struct({
  path: Schema.String,
  /** `image/png`, `image/svg+xml`… */
  mediaType: Schema.String,
  /** Bytes on disk. */
  size: Schema.Int,
  /** Larger than `maxBytes`; `base64` is absent. */
  tooLarge: Schema.Boolean,
  base64: Schema.optionalKey(Schema.String),
});
export type FileImage = typeof FileImage.Type;
