// Where Gram's shared-primitive rules don't apply yet. Each rule names the module that owns its
// primitive (the one place allowed to use the raw form) and the files not moved onto it yet. The
// `pending` lists only shrink: `gram.test.mjs` fails when a listed file no longer breaks its rule,
// so a file that has been moved comes off the list in the same change.

export const ALLOWLISTS = {
  "no-raw-path": {
    owners: ["packages/git/src/paths.ts"],
    pending: [],
  },
  "no-day-math": {
    owners: ["packages/server/src/zone-time.ts"],
    pending: [],
  },
  "no-adhoc-lock": {
    owners: ["packages/server/src/git/keyed-lock.ts"],
    pending: [],
  },
};
