import symbolsUrl from "./fonts/SymbolsNerdFontMono-Regular.ttf?url";
import noticesUrl from "./fonts/THIRD-PARTY-NOTICES.txt?url&no-inline";

const SYMBOLS_FAMILY = "Symbols Nerd Font Mono";
const FONT_WAIT_MS = 1_500;
let symbols: Promise<FontFace> | undefined;

/** Keep the selected text font first; only missing symbols use the bundled face. */
export const terminalFont = (family: string): string => `${family}, "${SYMBOLS_FAMILY}"`;

const loadSymbols = (): Promise<FontFace> => {
  if (symbols !== undefined) return symbols;
  // Vite emits the complete notices alongside the font, including in packaged web assets.
  if (document.head.querySelector("link[data-terminal-font-license]") === null) {
    const notice = document.createElement("link");
    notice.rel = "license";
    notice.href = noticesUrl;
    notice.dataset["terminalFontLicense"] = "";
    document.head.append(notice);
  }
  const face = new FontFace(SYMBOLS_FAMILY, `url("${symbolsUrl}")`);
  document.fonts.add(face);
  symbols = face.load().catch((error: unknown) => {
    document.fonts.delete(face);
    symbols = undefined;
    throw error;
  });
  return symbols;
};

/** Canvas does not request CSS font faces before it measures its grid. */
export async function loadTerminalFont(family: string, size: number): Promise<void> {
  await Promise.allSettled([
    Promise.resolve().then(loadSymbols),
    ...["", "bold ", "italic ", "bold italic "].map((style) =>
      Promise.resolve().then(() => document.fonts.load(`${style}${size}px ${family}`, "M")),
    ),
  ]);
}

/** A failed or stalled font request must not prevent opening/using a shell. */
export async function waitForTerminalFont(ready: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, FONT_WAIT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
