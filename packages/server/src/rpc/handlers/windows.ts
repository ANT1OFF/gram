import type { ThreadId, WindowPlacement, WindowPlacements } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { AppActivity } from "../../git/activity.ts";
import { ThreadVisibility } from "../../git/visibility.ts";
import { currentReader } from "../../embedding/readable-by.ts";
import type { Handlers } from "./common.ts";

/**
 * Whose windows a caller's are: its signed-in person's, or the one key of a server everyone
 * shares as one (the desktop's, or callers with no person). A window is known by this and its id.
 */
const ownerKey = Effect.map(currentReader, (reader) =>
  reader === undefined ? "server" : `person:${reader.subject ?? ""}`,
);

/** A window's key in the registry: its owner and its id. */
const keyOf = (owner: string, windowId: string) => `${owner}\u0000${windowId}`;

interface Registration {
  readonly placement: WindowPlacement;
  /** Whose window it is (`ownerKey`): only that caller's stream shows it, or its reports change it. */
  readonly owner: string;
  /** The watch that registered it, so a reconnect's newer watch isn't forgotten by the old one. */
  readonly token: object;
  readonly sidebarCollapsed?: boolean;
  /** A renderer that reports neither is assumed to be on screen and in use. */
  readonly visible?: boolean;
  readonly focused?: boolean;
  /** The thread in its focused pane; `null` for an empty pane. */
  readonly focusedThreadId?: ThreadId | null;
}

/**
 * Which window shows which thread, for the sidebar's "open in another window" markers. In memory
 * only: a window is known while its watch stream is open. Each change also updates which threads'
 * git chips are on screen (`ThreadVisibility`) and whether anyone is looking at the app at all
 * (`AppActivity`), when those are provided.
 */
export const makeWindowPlacements = Effect.gen(function* () {
  const windows = new Map<string, Registration>();
  const changes = yield* PubSub.sliding<true>(1);
  const visibility = yield* Effect.serviceOption(ThreadVisibility);
  const activity = yield* Effect.serviceOption(AppActivity);
  /** `owner`'s windows: no one else's window or thread ids are shown to them. */
  const snapshot = (owner: string): WindowPlacements => ({
    windows: [...windows.values()].filter((w) => w.owner === owner).map((w) => w.placement),
  });
  const changed = PubSub.publish(changes, true).pipe(
    Effect.andThen(
      Option.isNone(visibility)
        ? Effect.void
        : Effect.suspend(() =>
            visibility.value.update(
              [...windows.values()].map((w) => ({
                threadIds: w.placement.threadIds,
                sidebarCollapsed: w.sidebarCollapsed === true,
                visible: w.visible !== false,
                focused: w.focused !== false,
                ...(w.focusedThreadId == null ? {} : { focusedThreadId: w.focusedThreadId }),
              })),
            ),
          ),
    ),
    Effect.andThen(
      Option.isNone(activity)
        ? Effect.void
        : Effect.suspend(() =>
            activity.value.setWindows(
              [...windows.values()].map((w) => ({
                visible: w.visible !== false,
                focused: w.focused !== false,
              })),
            ),
          ),
    ),
  );

  const watch = (windowId: string, name: string): Stream.Stream<WindowPlacements> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const owner = yield* ownerKey;
        const key = keyOf(owner, windowId);
        const wakes = yield* PubSub.subscribe(changes);
        const token = {};
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const threadIds = windows.get(key)?.placement.threadIds ?? [];
            windows.set(key, { placement: { windowId, name, threadIds }, owner, token });
          }).pipe(Effect.andThen(changed)),
          () =>
            Effect.sync(() => {
              if (windows.get(key)?.token === token) windows.delete(key);
            }).pipe(Effect.andThen(changed)),
        );
        return Stream.concat(
          Stream.fromIterable([snapshot(owner)]),
          Stream.fromSubscription(wakes).pipe(Stream.map(() => snapshot(owner))),
        );
      }),
    );

  const report = (
    windowId: string,
    threadIds: ReadonlyArray<ThreadId>,
    /** What the renderer said about itself; a field it left out keeps its last reported value. */
    state: Pick<Registration, "sidebarCollapsed" | "visible" | "focused" | "focusedThreadId"> = {},
  ) =>
    Effect.gen(function* () {
      const key = keyOf(yield* ownerKey, windowId);
      const current = windows.get(key);
      if (current === undefined) return;
      const { sidebarCollapsed, visible, focused, focusedThreadId } = state;
      windows.set(key, {
        ...current,
        placement: { ...current.placement, threadIds },
        ...(sidebarCollapsed === undefined ? {} : { sidebarCollapsed }),
        ...(visible === undefined ? {} : { visible }),
        ...(focused === undefined ? {} : { focused }),
        ...(focusedThreadId === undefined ? {} : { focusedThreadId }),
      });
      yield* changed;
    });

  return { watch, report };
});

/** `windows.watch` / `windows.report`. */
export const windowsHandlers = Effect.gen(function* () {
  const placements = yield* makeWindowPlacements;
  return {
    "windows.watch": ({ windowId, name }) => placements.watch(windowId, name),
    "windows.report": ({
      windowId,
      threadIds,
      sidebarCollapsed,
      visible,
      focused,
      focusedThreadId,
    }) =>
      placements.report(windowId, threadIds, {
        ...(sidebarCollapsed === undefined ? {} : { sidebarCollapsed }),
        ...(visible === undefined ? {} : { visible }),
        ...(focused === undefined ? {} : { focused }),
        ...(focusedThreadId === undefined ? {} : { focusedThreadId }),
      }),
  } satisfies Partial<Handlers>;
});
