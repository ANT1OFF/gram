/** Inline image bytes in supported MCP and dynamic tool result blocks. No URLs are fetched. */
export interface InlineToolImage {
  readonly mediaType: string;
  readonly data: string;
}

/**
 * Separates actual protocol image blocks from their useful metadata without mutating the result.
 * Shared by live adapters and read-only historical rendering, so saved inline bytes aren't dumped
 * into JSON. Other content, structuredContent, annotations and remote URL metadata stay intact.
 */
export function splitToolImageOutput(output: unknown): {
  output: unknown;
  images: InlineToolImage[];
} {
  const images: InlineToolImage[] = [];
  const block = (value: unknown, dynamic: boolean): unknown => {
    if (typeof value !== "object" || value === null) return value;
    const fields = value as Record<string, unknown>;
    if (
      !dynamic &&
      fields["type"] === "image" &&
      typeof fields["data"] === "string" &&
      typeof fields["mimeType"] === "string"
    ) {
      const { data, ...metadata } = fields;
      images.push({ mediaType: fields["mimeType"], data: data as string });
      return metadata;
    }
    if (dynamic && fields["type"] === "inputImage" && typeof fields["imageUrl"] === "string") {
      const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(fields["imageUrl"]);
      if (match) {
        const { imageUrl: _, ...metadata } = fields;
        images.push({ mediaType: match[1]!, data: match[2]! });
        return { ...metadata, mediaType: match[1] };
      }
    }
    return value;
  };
  if (Array.isArray(output)) return { output: output.map((value) => block(value, true)), images };
  if (typeof output === "object" && output !== null) {
    const fields = output as Record<string, unknown>;
    if (Array.isArray(fields["content"]))
      return {
        output: { ...fields, content: fields["content"].map((value) => block(value, false)) },
        images,
      };
  }
  return { output, images };
}
