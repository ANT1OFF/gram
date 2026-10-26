// An animated GIF from page frames, for an agent's recording of what it did in the Preview pane.
// Dependency-free: one shared 256-colour palette chosen from the frames' most frequent colours,
// LZW-compressed frames, looping forever. Good for UI captures, not for photographs.

/** One frame of raw pixels, four bytes each, in `order`. */
export interface GifFrame {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
  /** How long it shows. */
  readonly delayMs: number;
}

export interface GifOptions {
  /** Electron's `NativeImage.toBitmap` is BGRA on the platforms Gram runs on. */
  readonly order?: "rgba" | "bgra";
}

/** A colour cut to five bits a channel, the palette's unit. */
const key15 = (r: number, g: number, b: number) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

const channels = (order: "rgba" | "bgra") => (order === "rgba" ? [0, 1, 2] : [2, 1, 0]);

/** The 256 most frequent colours across `frames`, sampled, as RGB triples. */
export function paletteOf(
  frames: readonly GifFrame[],
  order: "rgba" | "bgra" = "rgba",
): Uint8Array {
  const [ri, gi, bi] = channels(order) as [number, number, number];
  const counts = new Uint32Array(1 << 15);
  for (const frame of frames) {
    const pixels = frame.width * frame.height;
    const step = Math.max(1, Math.floor(pixels / 65_536));
    for (let p = 0; p < pixels; p += step) {
      const o = p * 4;
      counts[key15(frame.pixels[o + ri]!, frame.pixels[o + gi]!, frame.pixels[o + bi]!)]! += 1;
    }
  }
  const used = [...counts.keys()].filter((k) => counts[k]! > 0);
  used.sort((a, b) => counts[b]! - counts[a]!);
  const palette = new Uint8Array(256 * 3);
  used.slice(0, 256).forEach((k, i) => {
    // The bucket's centre, so a colour maps back near where it came from.
    palette[i * 3] = ((k >> 10) << 3) | 4;
    palette[i * 3 + 1] = (((k >> 5) & 31) << 3) | 4;
    palette[i * 3 + 2] = ((k & 31) << 3) | 4;
  });
  return palette;
}

/** Maps a five-bit colour to its nearest palette entry, remembering each answer. */
const nearest = (palette: Uint8Array) => {
  const cache = new Int16Array(1 << 15).fill(-1);
  return (k: number): number => {
    const known = cache[k]!;
    if (known >= 0) return known;
    const r = ((k >> 10) << 3) | 4;
    const g = (((k >> 5) & 31) << 3) | 4;
    const b = ((k & 31) << 3) | 4;
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 256; i++) {
      const dr = palette[i * 3]! - r;
      const dg = palette[i * 3 + 1]! - g;
      const db = palette[i * 3 + 2]! - b;
      const distance = dr * dr * 2 + dg * dg * 4 + db * db * 3;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    cache[k] = best;
    return best;
  };
};

/** GIF's variable-width LZW over 8-bit indices, as image data sub-blocks. */
export function lzw(indices: Uint8Array, minCodeSize = 8): Uint8Array {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const out: number[] = [];
  let bits = 0;
  let pending = 0;
  let size = minCodeSize + 1;
  const emit = (code: number) => {
    pending |= code << bits;
    bits += size;
    while (bits >= 8) {
      out.push(pending & 0xff);
      pending >>>= 8;
      bits -= 8;
    }
  };
  let table = new Map<number, number>();
  let next = end + 1;
  emit(clear);
  let current = indices[0] ?? 0;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]!;
    const entry = (current << 8) | k;
    const found = table.get(entry);
    if (found !== undefined) {
      current = found;
      continue;
    }
    emit(current);
    if (next === 4096) {
      emit(clear);
      table = new Map();
      next = end + 1;
      size = minCodeSize + 1;
    } else {
      if (next >= 1 << size) size += 1;
      table.set(entry, next++);
    }
    current = k;
  }
  emit(current);
  emit(end);
  if (bits > 0) out.push(pending & 0xff);
  // Sub-blocks of at most 255 bytes, then an empty one.
  const blocks: number[] = [minCodeSize];
  for (let at = 0; at < out.length; at += 255) {
    const chunk = out.slice(at, at + 255);
    blocks.push(chunk.length, ...chunk);
  }
  blocks.push(0);
  return Uint8Array.from(blocks);
}

const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];

/**
 * The GIF's parts, header first and trailer last, one frame at a time, so a caller can yield
 * between them; concatenated they are the file.
 */
export function* gifParts(
  frames: readonly GifFrame[],
  options: GifOptions = {},
): Generator<Uint8Array> {
  const order = options.order ?? "rgba";
  const [ri, gi, bi] = channels(order) as [number, number, number];
  const width = Math.max(1, ...frames.map((f) => f.width));
  const height = Math.max(1, ...frames.map((f) => f.height));
  const palette = paletteOf(frames, order);
  yield Uint8Array.from([
    ...[..."GIF89a"].map((c) => c.charCodeAt(0)),
    ...u16(width),
    ...u16(height),
    // A global table of 256 colours.
    0xf7,
    0,
    0,
  ]);
  yield palette;
  // Loop forever.
  yield Uint8Array.from([
    0x21,
    0xff,
    0x0b,
    ...[..."NETSCAPE2.0"].map((c) => c.charCodeAt(0)),
    0x03,
    0x01,
    0,
    0,
    0,
  ]);
  const map = nearest(palette);
  for (const frame of frames) {
    const pixels = frame.width * frame.height;
    const indices = new Uint8Array(pixels);
    for (let p = 0; p < pixels; p++) {
      const o = p * 4;
      indices[p] = map(key15(frame.pixels[o + ri]!, frame.pixels[o + gi]!, frame.pixels[o + bi]!));
    }
    const delay = Math.max(2, Math.round(frame.delayMs / 10));
    yield Uint8Array.from([
      // Graphic control: leave the frame in place, its delay in hundredths of a second.
      0x21,
      0xf9,
      0x04,
      0x04,
      ...u16(delay),
      0,
      0,
      // Image descriptor at the top left, using the global table.
      0x2c,
      0,
      0,
      0,
      0,
      ...u16(frame.width),
      ...u16(frame.height),
      0,
    ]);
    yield lzw(indices);
  }
  yield Uint8Array.from([0x3b]);
}

/** The whole GIF at once. */
export function encodeGif(frames: readonly GifFrame[], options: GifOptions = {}): Uint8Array {
  const parts = [...gifParts(frames, options)];
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
