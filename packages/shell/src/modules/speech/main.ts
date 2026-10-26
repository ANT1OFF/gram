// Local NVIDIA dictation: supervises the isolated speech process, verifies model downloads,
// and answers microphone permission requests. Audio and transcripts never leave the computer.

import type { WebContents } from "electron";

import { Channels } from "../../channels.ts";
import type { SpeechModelChangedPayload } from "../../speech-process/protocol.ts";
import type { ShellIpc } from "../ipc.ts";
import type { SpeechHost, SpeechSender } from "./host.ts";
import {
  microphoneAccess,
  openMicrophoneSettings,
  requestMicrophoneAccess,
  type MediaAccess,
} from "./microphone.ts";
import type { SpeechModelStore } from "./models.ts";

export * from "./host.ts";
export * from "./microphone.ts";
export * from "./model.ts";
export { speechModelBase, openSpeechModelStore, type SpeechModelStore } from "./models.ts";
export { electronFetch, type ElectronNet } from "./net.ts";

const speechSender = (contents: WebContents): SpeechSender => ({
  postPort: (payload, port) =>
    contents.postMessage(Channels.speechPort, payload, [port as Electron.MessagePortMain]),
  crashed: (payload) => contents.send(Channels.speechCrashed, payload),
  isDestroyed: () => contents.isDestroyed(),
});

const watchIdOf = (input: unknown): string | undefined => {
  const watchId: unknown =
    typeof input === "object" && input !== null ? Reflect.get(input, "watchId") : undefined;
  return typeof watchId === "string" && /^[A-Za-z0-9-]{1,64}$/.test(watchId) ? watchId : undefined;
};

const modelOf = (input: unknown): unknown =>
  typeof input === "object" && input !== null ? Reflect.get(input, "model") : undefined;

/** Serves `models`: the store's calls, and each page's watches until it unwatches or goes away. */
type ModelAccess = Promise<SpeechModelStore> | (() => Promise<SpeechModelStore>);
const currentModels = (models: ModelAccess) => (typeof models === "function" ? models() : models);
function installModels(ipc: ShellIpc, models: ModelAccess): void {
  ipc.handle(Channels.speechModelStatus, async (input) =>
    (await currentModels(models)).status(modelOf(input)),
  );
  ipc.handle(Channels.speechModelInstall, async (input) =>
    (await currentModels(models)).install(modelOf(input)),
  );
  ipc.handle(Channels.speechModelCancel, async (input) =>
    (await currentModels(models)).cancel(modelOf(input)),
  );
  ipc.handle(Channels.speechModelRemove, async (input) =>
    (await currentModels(models)).remove(modelOf(input)),
  );

  /** Open watches by page, then by the preload's id for them. */
  const watches = new Map<number, Map<string, AbortController>>();
  ipc.on(Channels.speechModelWatch, (event, input) => {
    const watchId = watchIdOf(input);
    if (watchId === undefined) return;
    const contents = event.sender;
    let page = watches.get(contents.id);
    if (page === undefined) {
      const opened = new Map<string, AbortController>();
      watches.set(contents.id, opened);
      page = opened;
      // A reload or a closed window ends its watches, which never unwatch themselves then.
      // `did-navigate` is a new document only; the router's in-page moves fire another event.
      const end = () => {
        contents.off("destroyed", end);
        contents.off("did-navigate", end);
        for (const controller of opened.values()) controller.abort();
        watches.delete(contents.id);
      };
      contents.on("destroyed", end);
      contents.on("did-navigate", end);
    }
    page.get(watchId)?.abort();
    const controller = new AbortController();
    page.set(watchId, controller);
    void currentModels(models)
      .then((store) =>
        store.watch(
          modelOf(input),
          (answer) => {
            if (contents.isDestroyed()) return;
            contents.send(Channels.speechModelChanged, {
              watchId,
              answer,
            } satisfies SpeechModelChangedPayload);
          },
          controller.signal,
        ),
      )
      .catch(() => {
        controller.abort();
        page?.delete(watchId);
        if (!contents.isDestroyed())
          contents.send(Channels.speechModelChanged, {
            watchId,
            answer: {
              ok: false,
              error: {
                _tag: "FsError",
                path: "",
                message: "Voice model store unavailable during update recovery",
              },
            },
          } satisfies SpeechModelChangedPayload);
      });
  });
  ipc.on(Channels.speechModelUnwatch, (event, input) => {
    const watchId = watchIdOf(input);
    if (watchId === undefined) return;
    const page = watches.get(event.sender.id);
    page?.get(watchId)?.abort();
    page?.delete(watchId);
  });
}

/** Serves `speech` and `voice`: sessions on `host`, the model store, and the microphone. */
export function installSpeech(
  ipc: ShellIpc,
  options: {
    readonly host: SpeechHost;
    /** `openSpeechModelStore(…)`, opened once at start-up. */
    readonly models: ModelAccess;
    /** Electron's `systemPreferences`. */
    readonly media: MediaAccess;
    readonly platform: NodeJS.Platform;
    /** `shell.openExternal`, for the system's privacy settings. */
    readonly openExternal: (url: string) => Promise<void>;
  },
): void {
  const { host, media, platform } = options;
  installModels(ipc, options.models);
  ipc.handle(Channels.speechOpen, (input, event) => host.open(input, speechSender(event.sender)));
  ipc.handle(Channels.speechPrewarm, (input) => {
    const { modelId, performance } = (input ?? {}) as Record<string, unknown>;
    return host.prewarm(modelId, performance);
  });
  ipc.handle(Channels.speechShutdown, () => host.shutdown());
  ipc.handle(Channels.microphoneAccess, () => microphoneAccess(media, platform));
  ipc.handle(Channels.microphoneRequest, () => requestMicrophoneAccess(media, platform));
  ipc.handle(Channels.microphoneSettings, () =>
    openMicrophoneSettings({ platform, openExternal: options.openExternal }),
  );
}
