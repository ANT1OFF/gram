# Vendored from anti-slop

These rules are copied from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), which
is meant to be vendored and then owned by the project that copies it (MIT, see `LICENSE`).

- Upstream commit: `63dbb09f73438e550a6991dc6d778f979ffbf183` (2026-11-20), files from `src/`.
- Copied unchanged apart from formatting by `bun fmt`: the rules named in `index.ts`, their tests,
  and the `shared/` helpers they import.
- Local changes: `index.ts` registers only the rules Gram adopts, and each test hands Vitest's
  `describe` and `it` to `RuleTester`.

To take an upstream fix, diff the upstream file against the copy here at the commit above, apply
the change, and move the commit line forward. Add a rule by copying it with its test and helpers,
registering it in `index.ts`, and turning it on in `.oxlintrc.json` with its existing hits fixed.
