#!/usr/bin/env node
// Derive committed native/browser icons and a size preview from the SVG app icon masters.
// Reuse pinned Electron: an offscreen window rasterises each SVG, nativeImage resamples it.
// No image API or additional dependency; Linux needs a display (run it under xvfb-run).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const require = createRequire(import.meta.url);
const BUILD = path.resolve(import.meta.dirname, "../build");
const ASSETS = path.resolve(import.meta.dirname, "../assets");
const WEB = path.resolve(import.meta.dirname, "../../web/public");
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
/** Every icon Settings offers, in its order; the first is the bundled default. Keep in sync with APP_ICONS. */
const ICONS = ["gift", "fanout", "blade", "glass"];
/** The PNG each alternate ships at for the Dock and taskbar: the Dock's largest tile at 2×. */
const ALTERNATE_SIZE = 512;

function main() {
  if (!process.versions.electron) {
    if (process.argv.slice(2).length !== 0) throw new Error("generate:icon takes no arguments");
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gram-icons-"));
    try {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawnSync(
        require("electron"),
        [
          import.meta.filename,
          `--user-data-dir=${scratch}`,
          // Chromium refuses to start sandboxed as root, as in a Linux container.
          ...(process.platform === "linux" ? ["--no-sandbox"] : []),
        ],
        {
          env,
          stdio: "inherit",
        },
      );
      if (child.error) throw child.error;
      process.exitCode = child.status ?? 1;
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  } else {
    // Electron adds its own command-line flags; only the Node entrypoint validates arguments.
    const { app, BrowserWindow, nativeImage } = require("electron");
    app.disableHardwareAcceleration();
    // Each master closes its window before the next opens; that is not the app quitting.
    app.on("window-all-closed", () => {});
    app
      .whenReady()
      .then(() => generate(BrowserWindow, nativeImage))
      .then(
        () => app.exit(0),
        (error) => {
          console.error(error);
          app.exit(1);
        },
      );
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(width, height, rgba) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++)
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Renders one 1024px SVG master, transparent outside its tile, in an offscreen window. */
async function rasterise(BrowserWindow, nativeImage, file) {
  const svg = fs.readFileSync(file, "utf8");
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1024,
    useContentSize: true,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true, javascript: false },
  });
  try {
    const page = `<style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`;
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
    const { width, height } = image.getSize();
    if (width !== 1024 || height !== 1024)
      throw new Error(`${file} rendered at ${width}×${height}`);
    const bitmap = image.toBitmap();
    if (bitmap[3] !== 0 || bitmap[(512 * 1024 + 512) * 4 + 3] !== 255)
      throw new Error(`${file} needs transparent corners and an opaque tile`);
    return nativeImage.createFromBuffer(image.toPNG());
  } finally {
    win.destroy();
  }
}

/** macOS icon family of PNG representations, as `iconutil` writes them, so any platform can build it. */
function icns(master) {
  const types = [
    ["icp4", 16],
    ["icp5", 32],
    ["ic11", 32],
    ["ic12", 64],
    ["ic07", 128],
    ["ic13", 256],
    ["ic08", 256],
    ["ic14", 512],
    ["ic09", 512],
    ["ic10", 1024],
  ];
  const entries = types.map(([type, size]) => {
    const bytes = master.resize({ width: size, height: size, quality: "best" }).toPNG();
    const head = Buffer.alloc(8);
    head.write(type, 0, "latin1");
    head.writeUInt32BE(bytes.length + 8, 4);
    return Buffer.concat([head, bytes]);
  });
  const head = Buffer.alloc(8);
  head.write("icns", 0, "latin1");
  head.writeUInt32BE(8 + entries.reduce((sum, entry) => sum + entry.length, 0), 4);
  return Buffer.concat([head, ...entries]);
}

function ico(images) {
  const sizes = SIZES.filter((size) => size <= 256);
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, i) => {
    const bytes = images.get(size).toPNG();
    const entry = 6 + 16 * i;
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(bytes.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += bytes.length;
  });
  return Buffer.concat([header, ...sizes.map((size) => images.get(size).toPNG())]);
}

// Numeric labels in the contact sheet, independent of installed fonts or renderer state.
const DIGITS = [
  ["111", "101", "101", "101", "111"],
  ["010", "110", "010", "010", "111"],
  ["111", "001", "111", "100", "111"],
  ["111", "001", "111", "001", "111"],
  ["101", "101", "111", "001", "001"],
  ["111", "100", "111", "001", "111"],
  ["111", "100", "111", "101", "111"],
  ["111", "001", "010", "010", "010"],
  ["111", "101", "111", "101", "111"],
  ["111", "101", "111", "001", "111"],
];

/** One light and one dark row per icon, at actual pixel sizes; 512 is shown at 50%. */
function preview(sets) {
  const width = 1120;
  const height = 320 * 2 * sets.length;
  const rgba = Buffer.alloc(width * height * 4);
  const pixel = (x, y, color) => rgba.set([...color, 255], (y * width + x) * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      pixel(x, y, Math.floor(y / 320) % 2 === 0 ? [240, 240, 240] : [35, 38, 42]);
  for (let row = 0; row < sets.length * 2; row++) {
    const images = sets[Math.floor(row / 2)];
    let left = 32;
    for (const size of [16, 32, 64, 128, 256, 512]) {
      const shown = Math.min(size, 256); // 512 is shown at 50%; others at their actual pixel size.
      const bitmap = images.get(size).toBitmap();
      const top = row * 320 + 32;
      for (let y = 0; y < shown; y++) {
        for (let x = 0; x < shown; x++) {
          const from = (Math.floor((y * size) / shown) * size + Math.floor((x * size) / shown)) * 4;
          const to = ((top + y) * width + left + x) * 4;
          const alpha = bitmap[from + 3] / 255;
          for (let c = 0; c < 3; c++)
            rgba[to + c] = Math.round(bitmap[from + 2 - c] + rgba[to + c] * (1 - alpha));
        }
      }
      for (const [index, digit] of [...String(size)].entries()) {
        DIGITS[Number(digit)].forEach((line, y) => {
          [...line].forEach((bit, x) => {
            if (bit === "1")
              for (let dy = 0; dy < 2; dy++)
                for (let dx = 0; dx < 2; dx++)
                  pixel(
                    left + index * 8 + x * 2 + dx,
                    top + 270 + y * 2 + dy,
                    row % 2 ? [230, 230, 230] : [40, 40, 40],
                  );
          });
        });
      }
      left += shown + 40;
    }
  }
  return png(width, height, rgba);
}

async function generate(BrowserWindow, nativeImage) {
  const sets = [];
  for (const id of ICONS) {
    const master = await rasterise(
      BrowserWindow,
      nativeImage,
      path.join(ASSETS, "app-icons", `${id}.svg`),
    );
    sets.push(
      new Map(
        SIZES.map((size) => [size, master.resize({ width: size, height: size, quality: "best" })]),
      ),
    );
  }
  const images = sets[0];
  fs.writeFileSync(path.join(BUILD, "icon.png"), images.get(1024).toPNG());
  fs.writeFileSync(path.join(BUILD, "icon.ico"), ico(images));
  fs.writeFileSync(path.join(BUILD, "icon.icns"), icns(images.get(1024)));
  fs.writeFileSync(path.join(WEB, "favicon.ico"), ico(images));
  fs.writeFileSync(path.join(WEB, "gram-icon.png"), images.get(256).toPNG());
  // Every icon, for Settings to show and for the shell to put in the Dock or taskbar.
  fs.mkdirSync(path.join(WEB, "app-icons"), { recursive: true });
  ICONS.forEach((id, i) =>
    fs.writeFileSync(path.join(WEB, "app-icons", `${id}.png`), sets[i].get(ALTERNATE_SIZE).toPNG()),
  );
  fs.writeFileSync(path.join(ASSETS, "gram-icon-preview.png"), preview(sets));
  console.log("wrote native icons, browser icons, app-icons/ and assets/gram-icon-preview.png");
}

main();
