import type { SpeechFetch } from "./download.ts";

/** The part of Electron's `net` module the store uses; the server has no Electron types. */
export interface ElectronNet {
  request(options: { url: string; redirect: "manual" }): ElectronRequest;
}

interface ElectronRequest {
  setHeader(name: string, value: string): void;
  on(
    event: "redirect",
    listener: (
      status: number,
      method: string,
      location: string,
      headers: Record<string, string[]>,
    ) => void,
  ): void;
  on(event: "response", listener: (response: ElectronResponse) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  abort(): void;
  end(): void;
}

interface ElectronResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[]>;
  on(event: "data", listener: (chunk: Buffer) => void): void;
  on(event: "end", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  pause(): void;
  resume(): void;
}

const headersOf = (raw: Record<string, string | string[]>): Headers => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw))
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  return headers;
};

/**
 * A `SpeechFetch` over Electron's `net.request`, which is Chromium's network stack: the system
 * proxy, PAC/WPAD, Kerberos and the keychain's TLS roots all apply, as Node's `fetch` doesn't apply
 * them. Its `net.fetch` can't stop at a redirect (`redirect: "manual"` throws "Redirect was
 * cancelled"), so this answers a redirect with its status and `location` without following it.
 */
export const electronFetch =
  (net: ElectronNet): SpeechFetch =>
  (url, init) =>
    new Promise((resolve, reject) => {
      const request = net.request({ url, redirect: "manual" });
      for (const [name, value] of Object.entries(init.headers)) request.setHeader(name, value);
      const onAbort = () => {
        request.abort();
        reject(init.signal.reason);
      };
      if (init.signal.aborted) return onAbort();
      init.signal.addEventListener("abort", onAbort, { once: true });
      request.on("redirect", (status, _method, location, headers) => {
        init.signal.removeEventListener("abort", onAbort);
        request.abort();
        const answer = headersOf(headers);
        answer.set("location", location);
        resolve(new Response(null, { status, headers: answer }));
      });
      request.on("response", (response) => {
        let open = true;
        const finish = () => {
          open = false;
          init.signal.removeEventListener("abort", onAbort);
        };
        const body = new ReadableStream<Uint8Array>(
          {
            start(controller) {
              response.on("data", (chunk) => {
                if (!open) return;
                controller.enqueue(new Uint8Array(chunk));
                // Held while the reader is behind, so a slow disk never queues the model in memory.
                if ((controller.desiredSize ?? 1) <= 0) response.pause();
              });
              response.on("end", () => {
                if (!open) return;
                finish();
                controller.close();
              });
              response.on("error", (error) => {
                if (!open) return;
                finish();
                controller.error(error);
              });
              init.signal.addEventListener(
                "abort",
                () => {
                  if (!open) return;
                  finish();
                  controller.error(init.signal.reason);
                },
                { once: true },
              );
            },
            pull() {
              response.resume();
            },
            // The reader gave up (a full disk, an oversized file): stop the transfer with it.
            cancel() {
              finish();
              request.abort();
            },
          },
          new CountQueuingStrategy({ highWaterMark: 16 }),
        );
        resolve(
          new Response(body, { status: response.statusCode, headers: headersOf(response.headers) }),
        );
      });
      request.on("error", (error) => {
        init.signal.removeEventListener("abort", onAbort);
        reject(error);
      });
      request.end();
    });
