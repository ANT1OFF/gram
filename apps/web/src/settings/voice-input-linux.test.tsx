// @vitest-environment happy-dom
import { VOICE_UNSUPPORTED_NOTE, voiceSupported } from "@gram/contracts";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createMockApi } from "@/api/mock";
import { renderWithApi } from "@/panels/test-utils";

import { VoiceInputSwitch } from "./voice-input-section";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "gram");
});

describe("voiceSupported", () => {
  it("is false on Linux alone", () => {
    expect(voiceSupported("linux")).toBe(false);
    for (const platform of ["darwin", "win32", undefined]) {
      expect(voiceSupported(platform)).toBe(true);
    }
  });
});

describe("VoiceInputSwitch off on Linux", () => {
  it("is switched off and says why", async () => {
    Object.assign(window, { gram: { platform: "linux" } });
    renderWithApi(
      <VoiceInputSwitch label="Voice input" description="Dictate." />,
      createMockApi({ speed: 0, autoplay: false }),
    );
    expect(await screen.findByText(`Dictate. ${VOICE_UNSUPPORTED_NOTE}`)).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>("switch").disabled).toBe(true);
  });
});
