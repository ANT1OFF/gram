import { describe, expect, it } from "vitest";

import { encodeGif, lzw, paletteOf, type GifFrame } from "./gif.ts";

/** A plain GIF LZW decoder, independent of the encoder, for the round trip. */
function unlzw(blocks: Uint8Array): number[] {
  const minCodeSize = blocks[0]!;
  const data: number[] = [];
  for (let at = 1; blocks[at]! > 0; at += blocks[at]! + 1)
    data.push(...blocks.slice(at + 1, at + 1 + blocks[at]!));
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  let size = minCodeSize + 1;
  let table: number[][] = [];
  const reset = () => {
    table = Array.from({ length: clear }, (_, i) => [i]);
    table.push([], []);
    size = minCodeSize + 1;
  };
  reset();
  const out: number[] = [];
  let bit = 0;
  let previous: number[] | undefined;
  for (;;) {
    let code = 0;
    for (let i = 0; i < size; i++, bit++) code |= ((data[bit >> 3]! >> (bit & 7)) & 1) << i;
    if (code === clear) {
      reset();
      previous = undefined;
      continue;
    }
    if (code === end) return out;
    const entry = code < table.length ? table[code]! : [...previous!, previous![0]!];
    out.push(...entry);
    if (previous !== undefined && table.length < 4096) table.push([...previous, entry[0]!]);
    if (table.length === 1 << size && size < 12) size += 1;
    previous = entry;
  }
}

const solid = (width: number, height: number, rgba: readonly number[], delayMs = 100): GifFrame => {
  const pixels = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) pixels.set(rgba, p * 4);
  return { width, height, pixels, delayMs };
};

describe("lzw", () => {
  it("round-trips short, repetitive and table-filling inputs", () => {
    const noisy = Uint8Array.from({ length: 40_000 }, (_, i) => (i * 7919 + (i >> 3) * 31) % 256);
    for (const input of [
      Uint8Array.from([0]),
      Uint8Array.from([1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2]),
      Uint8Array.from({ length: 10_000 }, (_, i) => i % 3),
      noisy,
    ])
      expect(unlzw(lzw(input))).toEqual([...input]);
  });
});

describe("encodeGif", () => {
  it("writes a looping GIF89a whose frames decode to the nearest palette colours", () => {
    const red = solid(4, 3, [250, 10, 10, 255], 250);
    const blue = solid(4, 3, [10, 10, 250, 255], 40);
    const gif = encodeGif([red, blue]);
    expect(String.fromCharCode(...gif.slice(0, 6))).toBe("GIF89a");
    expect([gif[6], gif[7], gif[8], gif[9]]).toEqual([4, 0, 3, 0]);
    expect(String.fromCharCode(...gif.slice(13 + 768 + 3, 13 + 768 + 14))).toBe("NETSCAPE2.0");
    expect(gif.at(-1)).toBe(0x3b);
    const palette = paletteOf([red, blue]);
    // First frame: graphic control (25 hundredths), descriptor, then its image data.
    let at = 13 + 768 + 19;
    const frames: number[][] = [];
    const delays: number[] = [];
    while (gif[at] === 0x21) {
      delays.push(gif[at + 4]! | (gif[at + 5]! << 8));
      at += 8;
      expect(gif[at]).toBe(0x2c);
      at += 10;
      const start = at;
      at += 1;
      while (gif[at]! > 0) at += gif[at]! + 1;
      at += 1;
      frames.push(unlzw(gif.slice(start, at)));
    }
    expect(delays).toEqual([25, 4]);
    const colour = (index: number) => Array.from(palette.slice(index * 3, index * 3 + 3));
    expect(frames.map((f) => f.length)).toEqual([12, 12]);
    expect(colour(frames[0]![0]!)).toEqual([252, 12, 12]);
    expect(colour(frames[1]![0]!)).toEqual([12, 12, 252]);
  });

  it("reads Electron's BGRA bitmaps in their own order", () => {
    const bgraRed = solid(2, 2, [10, 10, 250, 255]);
    const palette = paletteOf([bgraRed], "bgra");
    expect(Array.from(palette.slice(0, 3))).toEqual([252, 12, 12]);
    expect(encodeGif([bgraRed], { order: "bgra" }).at(-1)).toBe(0x3b);
  });
});
