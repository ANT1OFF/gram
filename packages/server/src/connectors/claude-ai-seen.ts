// The account's claude.ai connectors as Claude threads last reported them, so Settings can show
// them with no Claude thread running. Claude Code has no way to list them without connecting every
// one, so the only source is a session that is running anyway: its
// `mcpServerStatus` when something asks it, and each turn's `system/init`. Nothing here asks a
// session anything, and what is kept is names, states, masked addresses, ids and tool names, and
// when they were seen: never a token.

import type { ConnectorsSeen, ConnectorStatus } from "@gram/agents";
import type { SeenConnector } from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ThreadStore } from "../persistence/thread-store.ts";

/**
 * How old an entry's `seenAt` may grow while reports leave it unchanged before one is written
 * anyway: often enough for "as of" to stay near the truth, rarely enough that a busy thread's
 * turns don't each write.
 */
export const SEEN_REWRITE_MS = 5 * 60_000;

const isClaudeAi = (connector: ConnectorStatus) => connector.scope === "claudeai";

/**
 * `stored` with `seen` laid over it at `now`, or `undefined` when there is nothing to write. A
 * detailed report from a session given every connector is the whole catalogue, so a connector
 * missing from it is dropped; any other report only updates the connectors it names, since an
 * orchestrator's allowlist or a turn's init leaves the rest out without saying. One that names no
 * connector at all says nothing: claude.ai's list failed to load, or the session has none.
 */
export const mergeSeen = (
  stored: ReadonlyArray<SeenConnector>,
  seen: ConnectorsSeen,
  now: number,
): ReadonlyArray<SeenConnector> | undefined => {
  const reported = seen.connectors.filter(isClaudeAi);
  if (reported.length === 0) return undefined;
  const before = new Map(stored.map((entry) => [entry.name, entry]));
  // A turn's init names only states, so the address, id and tools an earlier report gave stay.
  const fresh = new Map(
    reported.map(({ name, status, url, claudeAi, tools }): [string, SeenConnector] => {
      const old = before.get(name);
      const id = claudeAi?.id ?? old?.id;
      const address = url ?? old?.url;
      const known = tools ?? old?.tools;
      return [
        name,
        {
          name,
          status,
          seenAt: now,
          ...(address === undefined ? {} : { url: address }),
          ...(id === undefined ? {} : { id }),
          ...(known === undefined ? {} : { tools: known }),
        },
      ];
    }),
  );
  const next =
    seen.detailed && seen.whole
      ? [...fresh.values()]
      : [
          ...stored.map((entry) => fresh.get(entry.name) ?? entry),
          ...[...fresh.values()].filter((entry) => !before.has(entry.name)),
        ];
  const changed =
    next.length !== stored.length ||
    next.some((entry) => {
      const old = before.get(entry.name);
      return (
        old === undefined ||
        old.status !== entry.status ||
        old.url !== entry.url ||
        old.id !== entry.id ||
        JSON.stringify(old.tools) !== JSON.stringify(entry.tools) ||
        (fresh.has(entry.name) && now - old.seenAt >= SEEN_REWRITE_MS)
      );
    });
  return changed ? next : undefined;
};

export interface ClaudeAiSeenShape {
  /** Lays one session's report over what is kept. Never fails: a write that does is logged. */
  readonly record: (seen: ConnectorsSeen) => Effect.Effect<void>;
  /** What is kept, as of each connector's `seenAt`. */
  readonly read: Effect.Effect<ReadonlyArray<SeenConnector>>;
}

/** Keeps and reads nothing by default, so a test's sessions write nowhere; `main.ts` provides it. */
export const ClaudeAiSeen = Context.Reference<ClaudeAiSeenShape>("@gram/server/ClaudeAiSeen", {
  defaultValue: () => ({ record: () => Effect.void, read: Effect.succeed([]) }),
});

/** Kept in the store's settings table, under its own key. */
export const ClaudeAiSeenLive: Layer.Layer<never, never, ThreadStore> = Layer.effect(
  ClaudeAiSeen,
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    return {
      record: (seen) =>
        // Most reports name no connector: a gateway or confined thread's, or one made before
        // claude.ai's list loaded.
        seen.connectors.some(isClaudeAi)
          ? Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) =>
                store.updateSeenConnectors((stored) => mergeSeen(stored, seen, now)),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("couldn't keep the claude.ai connectors seen", cause),
              ),
            )
          : Effect.void,
      read: store.getSeenConnectors,
    };
  }),
);
