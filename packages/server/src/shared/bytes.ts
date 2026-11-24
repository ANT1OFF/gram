/**
 * The chunks of a byte stream (a fetch body, a file's read stream) as `Uint8Array`s, which their
 * platform types leave as `any`. Leaving the loop early cancels the stream.
 */
export async function* bytesOf(
  chunks: AsyncIterable<unknown> | Iterable<unknown>,
): AsyncGenerator<Uint8Array> {
  for await (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError("A byte stream gave something else.");
    yield chunk;
  }
}
