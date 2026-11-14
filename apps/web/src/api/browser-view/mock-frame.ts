import type { BrowserViewEvent } from "@gram/contracts";

type Frame = Extract<BrowserViewEvent, { type: "frame" }>;

const WIDTH = 1280;
const HEIGHT = 800;

const ROWS = [
  ["INV-2041", "Northwind Traders", "12 Jun 2026", "Paid", "4 280,00"],
  ["INV-2040", "Fjord Logistics", "11 Jun 2026", "Overdue", "12 900,00"],
  ["INV-2039", "Aurora Design", "9 Jun 2026", "Paid", "1 150,00"],
  ["INV-2038", "Kite & Sons", "8 Jun 2026", "Draft", "640,00"],
  ["INV-2037", "Northwind Traders", "5 Jun 2026", "Paid", "4 280,00"],
  ["INV-2036", "Harbour Coffee", "3 Jun 2026", "Overdue", "310,00"],
  ["INV-2035", "Lumen Labs", "2 Jun 2026", "Paid", "8 400,00"],
  ["INV-2034", "Fjord Logistics", "29 May 2026", "Paid", "12 900,00"],
] as const;

const STATE_COLOURS: Record<string, readonly [string, string]> = {
  Paid: ["#dcfce7", "#166534"],
  Overdue: ["#fee2e2", "#991b1b"],
  Draft: ["#e5e7eb", "#374151"],
};

const sans = (size: number, weight = 400) => `${weight} ${size}px system-ui, sans-serif`;

let cached: Frame | undefined;

/**
 * A frame for the mock server's page: a made-up invoices list with its Filters menu open, drawn
 * once. Where there is no canvas (a unit test), a frame with no picture.
 */
export const mockPageFrame = (): Frame => {
  if (cached !== undefined) return cached;
  const blank: Frame = { type: "frame", jpeg: "", width: WIDTH, height: HEIGHT };
  if (typeof document === "undefined") return blank;
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const g = canvas.getContext("2d");
  if (g === null) return blank;
  const text = (words: string, x: number, y: number, font: string, colour: string) => {
    g.font = font;
    g.fillStyle = colour;
    g.fillText(words, x, y);
  };
  const box = (x: number, y: number, w: number, h: number, r: number, fill: string) => {
    g.beginPath();
    g.roundRect(x, y, w, h, r);
    g.fillStyle = fill;
    g.fill();
  };
  g.fillStyle = "#f8fafc";
  g.fillRect(0, 0, WIDTH, HEIGHT);
  // The site's own bar.
  g.fillStyle = "#0f172a";
  g.fillRect(0, 0, WIDTH, 56);
  text("Ledgerly", 32, 36, sans(18, 700), "#ffffff");
  text("Dashboard", 160, 35, sans(14), "#94a3b8");
  text("Invoices", 260, 35, sans(14, 600), "#ffffff");
  text("Customers", 344, 35, sans(14), "#94a3b8");
  text("Reports", 446, 35, sans(14), "#94a3b8");
  box(WIDTH - 64, 12, 32, 32, 16, "#334155");
  // The heading and its controls.
  text("Invoices", 32, 112, sans(28, 700), "#0f172a");
  text("8 of 214 shown", 32, 138, sans(14), "#64748b");
  box(WIDTH - 172, 84, 140, 40, 8, "#2563eb");
  text("New invoice", WIDTH - 146, 109, sans(14, 600), "#ffffff");
  box(32, 164, 104, 36, 8, "#e2e8f0");
  text("Filters", 60, 187, sans(14, 600), "#0f172a");
  box(148, 164, 280, 36, 8, "#ffffff");
  g.strokeStyle = "#cbd5e1";
  g.lineWidth = 1;
  g.strokeRect(148.5, 164.5, 280, 36);
  text("Search invoices", 164, 187, sans(14), "#94a3b8");
  // The table.
  box(32, 220, WIDTH - 64, 44 + ROWS.length * 52, 10, "#ffffff");
  const columns = [56, 220, 560, 800, 1100] as const;
  ["Number", "Customer", "Issued", "State", "Amount"].forEach((name, i) =>
    text(name, columns[i]!, 248, sans(12, 600), "#64748b"),
  );
  ROWS.forEach((row, r) => {
    const y = 264 + r * 52;
    g.fillStyle = "#e2e8f0";
    g.fillRect(32, y, WIDTH - 64, 1);
    row.forEach((cell, i) => {
      if (i === 3) {
        const [fill, ink] = STATE_COLOURS[cell]!;
        box(columns[i]! - 10, y + 14, 78, 26, 13, fill);
        text(cell, columns[i]!, y + 32, sans(13, 600), ink);
      } else text(cell, columns[i]!, y + 32, sans(14, i === 0 ? 600 : 400), "#0f172a");
    });
  });
  // The Filters menu, open.
  g.shadowColor = "rgba(15, 23, 42, 0.18)";
  g.shadowBlur = 24;
  g.shadowOffsetY = 8;
  box(32, 208, 240, 196, 10, "#ffffff");
  g.shadowColor = "transparent";
  text("State", 52, 238, sans(12, 600), "#64748b");
  ["Paid", "Overdue", "Draft"].forEach((name, i) => {
    const y = 252 + i * 34;
    box(52, y, 18, 18, 4, i === 1 ? "#2563eb" : "#e2e8f0");
    text(name, 82, y + 14, sans(14), "#0f172a");
  });
  text("Clear filters", 52, 384, sans(13, 600), "#2563eb");
  cached = {
    type: "frame",
    jpeg: canvas.toDataURL("image/jpeg", 0.9).replace(/^data:image\/jpeg;base64,/, ""),
    width: WIDTH,
    height: HEIGHT,
  };
  return cached;
};
