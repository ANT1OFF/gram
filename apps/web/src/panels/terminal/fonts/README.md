# Terminal symbols fallback

Unmodified `SymbolsNerdFontMono-Regular.ttf` from Nerd Fonts **v3.4.0**, commit
`fa7b859994228a9c8759f99c55a8d31ee92a1b5e`.

- Size: **2,507,556 bytes**.
- SHA-256: `f0f624d9b474bea1662cf7e862d44aebe1ae1f6c7f9cb7a0ca5d0e5ac9561c60`.
- Metadata family: **Symbols Nerd Font Mono**; PostScript name **SymbolsNFM**;
  version **001.000;Nerd Fonts 3.4.0**.
- [Immutable source](https://github.com/ryanoasis/nerd-fonts/blob/fa7b859994228a9c8759f99c55a8d31ee92a1b5e/patched-fonts/NerdFontsSymbolsOnly/SymbolsNerdFontMono-Regular.ttf).
- [Complete provenance and notices](THIRD-PARTY-NOTICES.txt) retain the upstream
  MIT/OFL, component MIT/OFL/CC BY 4.0/Apache 2.0 and Font Logos Unlicense terms.

The pinned license audit's Font Logos “Unlicensed” entry is resolved by its
component's explicit **Unlicense** at v1.3.0, consistent with the pinned glyph
font's 1.3.0 / 2014–2024 metadata. The notices retain source URLs, copyrights,
reserved names and upstream modification attributions. Gram does not modify,
subset, convert or rename this font or relicense its components.

`terminal-font.ts` imports the notices as a non-inline Vite asset and exposes them
through a document `link[rel=license]` when loading the terminal. Both the font
and complete notices ship in the built web assets, including the packaged app.
Only the terminal appends this fallback; selected text fonts remain first.
