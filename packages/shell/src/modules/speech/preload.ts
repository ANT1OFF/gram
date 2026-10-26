import type { DesktopBridge } from "@gram/contracts/desktop-bridge";

import { Channels } from "../../channels.ts";
import type { PreloadIpc } from "../../preload.ts";
import type {
  SpeechCrashPayload,
  SpeechModelChangedPayload,
  SpeechModelWatchPayload,
  SpeechPortPayload,
} from "../../speech-process/protocol.ts";
import { createSpeechRelay, type RelayWindow } from "./relay.ts";

/**
 * The speech module's bridge half: local dictation, the model store and
 * the microphone permission. Each session's port arrives from main and goes to the page through
 * the relay (`relay.ts`), which is set up here, before the page can open a session.
 */
export function speechPreload(ipc: PreloadIpc, window: RelayWindow): Pick<DesktopBridge, "speech"> {
  const relay = createSpeechRelay(window);
  ipc.subscribeWithPorts<SpeechPortPayload>(Channels.speechPort, (payload, ports) => {
    const port = ports[0];
    if (port !== undefined) relay.attach(payload.sessionId, port, "local");
  });
  ipc.subscribe<SpeechCrashPayload>(Channels.speechCrashed, (payload) =>
    relay.crashed(payload.sessionId, payload.message),
  );
  return {
    speech: {
      open: (request) => ipc.invoke(Channels.speechOpen, request),
      prewarm: (modelId, performance) =>
        ipc.invoke(Channels.speechPrewarm, { modelId, performance }),
      microphoneAccess: () => ipc.invoke(Channels.microphoneAccess),
      requestMicrophoneAccess: () => ipc.invoke(Channels.microphoneRequest),
      openMicrophoneSettings: () => ipc.invoke(Channels.microphoneSettings),
      shutdown: () => ipc.invoke(Channels.speechShutdown),
      models: {
        status: (model) => ipc.invoke(Channels.speechModelStatus, { model }),
        install: (model) => ipc.invoke(Channels.speechModelInstall, { model }),
        cancel: (model) => ipc.invoke(Channels.speechModelCancel, { model }),
        remove: (model) => ipc.invoke(Channels.speechModelRemove, { model }),
        watch: (model, callback) => {
          const watchId = crypto.randomUUID();
          const off = ipc.subscribe<SpeechModelChangedPayload>(
            Channels.speechModelChanged,
            (payload) => {
              if (payload.watchId === watchId) callback(payload.answer);
            },
          );
          ipc.send(Channels.speechModelWatch, { watchId, model } satisfies SpeechModelWatchPayload);
          return () => {
            off();
            ipc.send(Channels.speechModelUnwatch, { watchId } satisfies SpeechModelWatchPayload);
          };
        },
      },
    },
  };
}
