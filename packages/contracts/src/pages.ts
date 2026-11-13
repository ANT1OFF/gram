// A workspace's pinned pages: HTML an agent drafted in its folder and the user pinned from the
// Preview tab. Pinning copies the page's folder into Gram's own state
// (`<dataDir>/pages/<workspaceId>/<id>/`), so nothing done in a worktree afterwards changes what was
// pinned. An agent may offer a new version (`offer_page_version`), copied the same way; the page
// keeps showing the version the user has until they choose to show the new one. Only the user pins,
// shows an offer or unpins: no agent tool does.
//
// A pinned version is a bundle: its folder, and at its root a `manifest.json` naming the entry file
// and the data the page declares it reads. Pages read nothing yet, so `reads` is always empty.
import * as Schema from "effect/Schema";
import { ThreadId, WorkspaceId } from "./ids.ts";

/** A page's id, which is also its folder's name: the same shape as a doc's. */
export const PAGE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const PageId = Schema.String.check(Schema.isPattern(PAGE_ID_PATTERN)).pipe(
  Schema.brand("PageId"),
);
export type PageId = typeof PageId.Type;

/** The bundle's manifest, at the root of every pinned version. */
export const PAGE_MANIFEST = "manifest.json";
/** The longest title kept, from the entry's `<title>` or its file name. */
export const PAGE_TITLE_MAX = 120;
/** The most files one version may hold; a folder past it is refused, not cut. */
export const PAGE_FILES_MAX = 400;
/** The most bytes one version may hold, all its files together. */
export const PAGE_BYTES_MAX = 32 * 1024 * 1024;
/** The deepest a version's folders nest under its root. */
export const PAGE_DEPTH_MAX = 8;
/** The most pages a workspace keeps; pinning past it is refused until one is unpinned. */
export const PAGES_PER_WORKSPACE_MAX = 50;
/** The most versions a page counts to. */
export const PAGE_VERSION_MAX = 1_000_000_000;
/** The longest thread or workspace id a page records. */
export const PAGE_REF_MAX = 128;
/** The latest time a `Date` can hold, in epoch ms. */
const PAGE_TIME_MAX = 8_640_000_000_000_000;

const bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const PageTime = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: PAGE_TIME_MAX }));
export const PageVersion = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: PAGE_VERSION_MAX }),
);

/**
 * A path inside a bundle as the manifest names it: `/`-separated, relative, with no empty, `.`,
 * `..` or dot-led segment and no backslash, so it can only name a file the bundle holds.
 */
export const PAGE_PATH_PATTERN = /^(?!\.)[^/\\\0]{1,255}(?:\/(?!\.)[^/\\\0]{1,255}){0,7}$/;
export const PagePath = Schema.String.check(Schema.isPattern(PAGE_PATH_PATTERN));

/**
 * The manifest: the entry the page opens at, and what it declares it reads. `reads` must be empty
 * until pages can read data; a draft whose own manifest declares a read isn't pinned.
 */
export const PageManifest = Schema.Struct({
  entry: PagePath,
  reads: Schema.Tuple([]),
});
export type PageManifest = typeof PageManifest.Type;

/** A newer version an agent offered, kept beside the one shown until the user shows it. */
export const PageOffer = Schema.Struct({
  version: PageVersion,
  /** Its entry and title, which become the page's when it is shown. */
  entry: PagePath,
  title: bounded(PAGE_TITLE_MAX),
  /** The thread that offered it, and its title then. */
  threadId: ThreadId.check(Schema.isMaxLength(PAGE_REF_MAX)),
  threadTitle: bounded(PAGE_TITLE_MAX),
  /** Epoch ms. */
  at: PageTime,
});
export type PageOffer = typeof PageOffer.Type;

/** What a pinned page is. Every field is bounded, so a decoded one is safe to show. */
export const PageMeta = Schema.Struct({
  id: PageId,
  workspaceId: WorkspaceId.check(Schema.isMaxLength(PAGE_REF_MAX)),
  title: bounded(PAGE_TITLE_MAX),
  /** The version shown. */
  version: PageVersion,
  /** Its entry, as its manifest names it. */
  entry: PagePath,
  /** The thread it was pinned from, and that thread's title then. */
  authorThreadId: ThreadId.check(Schema.isMaxLength(PAGE_REF_MAX)),
  authorTitle: bounded(PAGE_TITLE_MAX),
  /** Epoch ms of the pin. */
  pinnedAt: PageTime,
  /** Epoch ms the shown version became the shown one. */
  updatedAt: PageTime,
  /** A newer version an agent offered, while the user hasn't shown it. */
  offer: Schema.optionalKey(PageOffer),
});
export type PageMeta = typeof PageMeta.Type;

/** Newest pin first. */
export const PageList = Schema.Struct({ pages: Schema.Array(PageMeta) });
export type PageList = typeof PageList.Type;

/** A page's URL on the page listener, for the shell's `gram-pages` session, and its version. */
export const PageOpened = Schema.Struct({ url: Schema.String, version: PageVersion });
export type PageOpened = typeof PageOpened.Type;

export const PagesListFields = { workspaceId: WorkspaceId };
/** The HTML file the thread's Preview tab shows, as the tab names it. */
export const PagePinFields = { threadId: ThreadId, path: Schema.String };
export const PageOpenFields = { workspaceId: WorkspaceId, id: PageId };
/** Shows the offered `version`, which must still be the one on offer. */
export const PageShowOfferFields = { workspaceId: WorkspaceId, id: PageId, version: PageVersion };
export const PageUnpinFields = { workspaceId: WorkspaceId, id: PageId };
