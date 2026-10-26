import { run, type RpcContext } from "../rpc-client";
import type { SettingsApi } from "./types";

/** `SettingsApi` over the RPC client. */
export const settingsRpc = ({ client }: RpcContext): SettingsApi => ({
  getSettings: () => run(client["settings.get"](undefined)),
  updateSettings: (patch) => run(client["settings.set"]({ patch })),
  listPalettes: () => run(client["palettes.list"](undefined)),
  upsertPalette: (palette) => run(client["palettes.upsert"]({ palette })),
  removePalette: (paletteId) => run(client["palettes.remove"]({ paletteId })),
});
