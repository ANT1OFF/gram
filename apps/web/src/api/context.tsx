import { createContext, useContext, type ReactNode } from "react";

import type { Api } from "./types";

const ApiContext = createContext<Api | null>(null);

export function ApiProvider({ api, children }: { api: Api; children: ReactNode }) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function useApi(): Api {
  const api = useContext(ApiContext);
  if (!api) throw new Error("useApi must be used within ApiProvider");
  return api;
}

/**
 * The RPC client on the page's own origin by default (`/ws`; proxied to the headless server in dev);
 * the in-memory mock with `VITE_API=mock`. Each is loaded lazily so the other stays out of the bundle
 * path.
 */
export async function createApi(): Promise<Api> {
  if (import.meta.env.VITE_API === "mock") {
    const { createMockApi } = await import("./mock");
    const speed = Number(import.meta.env.VITE_MOCK_SPEED ?? "1");
    const mock = createMockApi({ speed: Number.isFinite(speed) ? speed : 1, persist: true });
    window.gramMock = mock;
    return mock;
  }
  const { createRpcApi } = await import("./rpc");
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return createRpcApi(`${protocol}//${location.host}/ws`);
}
