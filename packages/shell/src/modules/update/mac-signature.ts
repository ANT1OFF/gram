// The publisher's Developer ID identity and macOS's signature verdict, kept in `@gram/git` so a
// joined machine's gram-host (packages/server) checks a downloaded app against the same requirement
// as the desktop updater, the signer and the release script, which import it from here.
export * from "@gram/git/mac-signature";
