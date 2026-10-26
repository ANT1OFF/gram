import { run, type RpcContext } from "../rpc-client";
import type { KeybindingsApi } from "./types";

/** `KeybindingsApi` over the RPC client. */
export const keybindingsRpc = ({ client }: RpcContext): KeybindingsApi => ({
  getKeybindings: () => run(client["keybindings.get"](undefined)),
  setKeybindings: (bindings) => run(client["keybindings.set"]({ bindings })),
});
