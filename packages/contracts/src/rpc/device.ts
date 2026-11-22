import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import {
  DEVICE_COMMAND_MAX_BYTES,
  DeviceExecEvent,
  DeviceHello,
  DeviceListResult,
  DeviceReadResult,
  DeviceRelativePath,
  DeviceRequestBy,
} from "../device.ts";
import { PositiveInt } from "./shared.ts";

/**
 * Everything a personal device serves, and all of it. This is its own group, not `HostRpcs` with
 * calls removed: a call that isn't here doesn't exist on a device's connection, and a new host
 * call never appears on one by default. The control plane is the client; the desktop app's main
 * process serves. No call changes the device's settings, folders or software, and every request
 * is asked of the person before it does anything (`docs/design/personal-device.md`).
 */
export const DeviceRpcs = RpcGroup.make(
  Rpc.make("device.hello", { success: DeviceHello }),
  Rpc.make("device.exec", {
    payload: {
      ...DeviceRequestBy,
      cwd: Schema.optionalKey(DeviceRelativePath),
      command: Schema.String.check(Schema.isMaxLength(DEVICE_COMMAND_MAX_BYTES)),
      timeoutMs: Schema.optionalKey(PositiveInt),
      /** Why the agent says it wants this. Untrusted text, shown as the agent's own claim. */
      reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
    },
    success: DeviceExecEvent,
    stream: true,
  }),
  Rpc.make("device.files.list", {
    payload: { ...DeviceRequestBy, path: DeviceRelativePath, limit: PositiveInt },
    success: DeviceListResult,
  }),
  Rpc.make("device.files.read", {
    payload: { ...DeviceRequestBy, path: DeviceRelativePath, maxBytes: PositiveInt },
    success: DeviceReadResult,
  }),
  Rpc.make("device.cancel", { payload: { requestId: DeviceRequestBy.requestId } }),
  Rpc.make("device.token", {
    success: Schema.Struct({ accessToken: Schema.RedactedFromValue(Schema.String) }),
  }),
);
