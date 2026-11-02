// @vitest-environment happy-dom
import { DEFAULT_SETTINGS, microphoneOpensUnasked } from "@gram/contracts";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createMockApi } from "@/api/mock";
import { MockSpeechBridge } from "@/api/mock-speech-bridge";
import { renderWithApi } from "@/panels/test-utils";
import { useServerSettings } from "@/settings-sync/store";

import { VoiceInputSection, VoiceInputSwitch } from "./voice-input-section";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "gram");
});

/** The desktop bridge on Linux, whose microphone permission always reads `unknown`. */
const onLinux = () => {
  const speech = new MockSpeechBridge();
  speech.access = "unknown";
  Object.assign(window, { gram: { platform: "linux", speech } });
};

describe("microphoneOpensUnasked", () => {
  it("is true once granted, and on Linux, which never asks", () => {
    expect(microphoneOpensUnasked("granted", "darwin")).toBe(true);
    expect(microphoneOpensUnasked("unknown", "linux")).toBe(true);
    expect(microphoneOpensUnasked("not-determined", "darwin")).toBe(false);
    expect(microphoneOpensUnasked("denied", "win32")).toBe(false);
    // A status macOS or Windows adds later isn't taken as a grant.
    expect(microphoneOpensUnasked("unknown", "darwin")).toBe(false);
  });
});

describe("voice input on Linux", () => {
  it("can be switched on", async () => {
    onLinux();
    useServerSettings.setState({ settings: DEFAULT_SETTINGS });
    renderWithApi(
      <VoiceInputSwitch label="Voice input" description="Dictate." />,
      createMockApi({ speed: 0, autoplay: false, persist: false }),
    );
    expect(await screen.findByText("Dictate.")).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>("switch").disabled).toBe(false);
  });

  it("says where the microphone comes from instead of a permission", async () => {
    onLinux();
    useServerSettings.setState({
      settings: { ...DEFAULT_SETTINGS, experimental: { voiceInput: true } },
    });
    renderWithApi(
      <VoiceInputSection />,
      createMockApi({ speed: 0, autoplay: false, persist: false }),
    );
    expect(await screen.findByText(/through PipeWire or PulseAudio/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open System Settings" })).toBeNull();
  });
});
