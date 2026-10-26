// @vitest-environment happy-dom
import { EXAMPLE_GATEWAY, type GatewayProfile, type ProfileId } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockApi } from "@/api/mock";
import { renderWithApi } from "@/panels/test-utils";

import { GatewaysSettings, profileIdFor } from "./gateways-section";
import { chooseFromRowMenu } from "./row-menu-test-utils";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children?: ReactNode }) => <a href={to}>{children}</a>,
}));

const LITELLM = "litellm" as ProfileId;

const mockApi = () => createMockApi({ speed: 0, autoplay: false });

/** A mock with no gateway profiles. */
const emptyApi = async () => {
  const api = mockApi();
  await api.removeProfile(LITELLM);
  return api;
};

const card = (name: string) => screen.findByRole("article", { name });

afterEach(cleanup);

describe("GatewaysSettings", () => {
  it("lists profiles with their base URL, model count, default badge and key status", async () => {
    renderWithApi(<GatewaysSettings />, mockApi());
    const litellm = within(await card("Personal Gateway"));
    expect(litellm.getByText("Default")).toBeTruthy();
    expect(litellm.getByText("No API key yet")).toBeTruthy();
    expect(litellm.getByText("https://llm.example.test/v1")).toBeTruthy();
    expect(litellm.getByText("2 models")).toBeTruthy();
  });

  it("points the default gateway's helper model to AI helpers", async () => {
    const api = mockApi();
    await api.upsertProfile({
      id: "other" as ProfileId,
      name: "Other",
      baseURL: "https://other.example.test/v1",
      keyRef: "",
      models: [{ id: "m", name: "M" }],
    });
    renderWithApi(<GatewaysSettings />, api);
    const litellm = within(await card("Personal Gateway"));
    expect(
      litellm.getByText(/Gateway helper model when selected: gpt-5\.5\./).textContent,
    ).toContain("AI helpers");
    expect(litellm.getByRole("link", { name: "AI helpers" }).getAttribute("href")).toBe(
      "/settings/ai-helpers",
    );
    expect(within(await card("Other")).queryByText(/Helper model/)).toBeNull();
  });

  it("does not create or promote a built-in gateway beside an existing profile", async () => {
    const api = mockApi();
    const existing: GatewayProfile = {
      ...EXAMPLE_GATEWAY,
      baseURL: "https://elsewhere.example/v1",
      keyRef: "",
      models: [],
    };
    await api.upsertProfile(existing);
    const upsert = vi.spyOn(api, "upsertProfile");
    renderWithApi(<GatewaysSettings />, api);
    await card(existing.name);
    expect(screen.queryByRole("form", { name: "Connect the AI gateway" })).toBeNull();
    expect(upsert).not.toHaveBeenCalled();
    expect((await api.listProfiles()).find((p) => p.id === existing.id)).toMatchObject(existing);
  });

  it("asks for an explicit address and never links to placeholder key provisioning", async () => {
    const api = mockApi();
    renderWithApi(<GatewaysSettings />, api);
    fireEvent.click(await screen.findByRole("button", { name: "Add gateway" }));
    const form = within(screen.getByRole("form", { name: "Add gateway" }));
    expect(form.getByLabelText("Base URL")).toHaveProperty("value", "");
    fireEvent.change(form.getByLabelText("Base URL"), {
      target: { value: EXAMPLE_GATEWAY.baseURL },
    });
    expect(form.queryByRole("button", { name: "Get a key" })).toBeNull();
    expect(api.opened).toEqual([]);
  });

  it("adds a gateway with an id from its name and no key", async () => {
    const api = mockApi();
    const upsert = vi.spyOn(api, "upsertProfile");
    const setKey = vi.spyOn(api, "setProfileKey");
    renderWithApi(<GatewaysSettings />, api);

    fireEvent.click(await screen.findByRole("button", { name: "Add gateway" }));
    const form = within(screen.getByRole("form", { name: "Add gateway" }));
    fireEvent.change(form.getByLabelText("Name"), { target: { value: "Team Gateway" } });
    fireEvent.change(form.getByLabelText("Base URL"), {
      target: { value: "https://gw.example.test/v1" },
    });
    fireEvent.click(form.getByRole("button", { name: "Save gateway" }));

    expect(await card("Team Gateway")).toBeTruthy();
    expect(upsert).toHaveBeenCalledWith({
      id: "team-gateway",
      name: "Team Gateway",
      baseURL: "https://gw.example.test/v1",
      keyRef: "",
      models: [],
    });
    expect(setKey).not.toHaveBeenCalled();
  });

  it("adds a gateway with a key, then shows the models found and the new default", async () => {
    const api = await emptyApi();
    const setKey = vi.spyOn(api, "setProfileKey");
    renderWithApi(<GatewaysSettings />, api);

    fireEvent.click(await screen.findByRole("button", { name: "Add gateway" }));
    const form = within(screen.getByRole("form", { name: "Add gateway" }));
    fireEvent.change(form.getByLabelText("Name"), { target: { value: "Team Gateway" } });
    fireEvent.change(form.getByLabelText("Base URL"), {
      target: { value: "https://gw.example.test/v1" },
    });
    const field = form.getByLabelText("API key (optional)") as HTMLInputElement;
    expect(field.type).toBe("password");
    fireEvent.change(field, { target: { value: "sk-team-secret" } });
    fireEvent.click(form.getByRole("button", { name: "Save gateway" }));

    const team = within(await card("Team Gateway"));
    expect(
      (await team.findByRole("status")).textContent?.includes(
        "Found 3 models. This is now the default gateway.",
      ),
    ).toBe(true);
    expect(await team.findByText("Saved securely in the macOS Keychain")).toBeTruthy();
    expect(team.getByText("Default")).toBeTruthy();
    expect(setKey).toHaveBeenCalledWith("team-gateway", "sk-team-secret");
    expect(document.body.textContent).not.toContain("sk-team-secret");
  });

  it("saves a key write-only, replaces it, and removes it", async () => {
    const api = mockApi();
    const setKey = vi.spyOn(api, "setProfileKey");
    renderWithApi(<GatewaysSettings />, api);
    const litellm = within(await card("Personal Gateway"));

    const field = litellm.getByLabelText("API key") as HTMLInputElement;
    expect(field.type).toBe("password");
    expect((litellm.getByRole("button", { name: "Save key" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.change(field, { target: { value: "sk-secret-123" } });
    fireEvent.click(litellm.getByRole("button", { name: "Save key" }));

    expect(await litellm.findByText("Saved securely in the macOS Keychain")).toBeTruthy();
    expect(await litellm.findByText("Found 3 models.")).toBeTruthy();
    expect(setKey).toHaveBeenCalledWith(LITELLM, "sk-secret-123");
    expect((litellm.getByLabelText("API key") as HTMLInputElement).value).toBe("");
    expect(document.body.textContent).not.toContain("sk-secret-123");

    const replace = litellm.getByRole("button", { name: "Replace key" }) as HTMLButtonElement;
    expect(replace.disabled).toBe(true);
    fireEvent.change(litellm.getByLabelText("API key"), { target: { value: "sk-newer" } });
    expect(replace.disabled).toBe(false);
    fireEvent.click(replace);
    await waitFor(() => expect(setKey).toHaveBeenCalledWith(LITELLM, "sk-newer"));

    fireEvent.click(litellm.getByRole("button", { name: "Remove key" }));
    expect(await litellm.findByText("No API key yet")).toBeTruthy();
    expect(setKey).toHaveBeenLastCalledWith(LITELLM, "");
    expect(litellm.queryByRole("button", { name: "Remove key" })).toBeNull();
    expect(litellm.getByRole("button", { name: "Save key" })).toBeTruthy();
  });

  it("keeps a key that failed to save in its field, with the error", async () => {
    const api = mockApi();
    vi.spyOn(api, "setProfileKey").mockRejectedValueOnce(new Error("The key store is locked"));
    renderWithApi(<GatewaysSettings />, api);
    const litellm = within(await card("Personal Gateway"));

    fireEvent.change(litellm.getByLabelText("API key"), { target: { value: "sk-typed" } });
    fireEvent.click(litellm.getByRole("button", { name: "Save key" }));

    expect(await litellm.findByText("The key store is locked")).toBeTruthy();
    expect((litellm.getByLabelText("API key") as HTMLInputElement).value).toBe("sk-typed");
  });

  it("keeps the add form and its key open when the key fails to save, then retries on the same id", async () => {
    const api = await emptyApi();
    const upsert = vi.spyOn(api, "upsertProfile");
    const setKey = vi
      .spyOn(api, "setProfileKey")
      .mockRejectedValueOnce(new Error("The key store is locked"));
    renderWithApi(<GatewaysSettings />, api);

    fireEvent.click(await screen.findByRole("button", { name: "Add gateway" }));
    const form = within(screen.getByRole("form", { name: "Add gateway" }));
    fireEvent.change(form.getByLabelText("Name"), { target: { value: "Team Gateway" } });
    fireEvent.change(form.getByLabelText("Base URL"), {
      target: { value: "https://gw.example.test/v1" },
    });
    fireEvent.change(form.getByLabelText("API key (optional)"), { target: { value: "sk-typed" } });
    fireEvent.click(form.getByRole("button", { name: "Save gateway" }));

    expect(await form.findByText("The key store is locked")).toBeTruthy();
    expect((form.getByLabelText("API key (optional)") as HTMLInputElement).value).toBe("sk-typed");

    fireEvent.click(form.getByRole("button", { name: "Save gateway" }));
    await waitFor(() => expect(screen.queryByRole("form", { name: "Add gateway" })).toBeNull());
    expect(upsert.mock.calls.map(([p]) => p.id)).toEqual(["team-gateway", "team-gateway"]);
    expect(setKey).toHaveBeenLastCalledWith("team-gateway", "sk-typed");
    expect(await api.listProfiles()).toHaveLength(1);
  });

  it("says a key lives in memory only when the vault doesn't persist", async () => {
    const api = mockApi();
    await api.setProfileKey(LITELLM, "sk-x");
    vi.spyOn(api, "vaultInfo").mockResolvedValue({
      kind: "memory",
      persisted: false,
      label: "memory only, until the server stops",
    });
    renderWithApi(<GatewaysSettings />, api);
    const litellm = within(await card("Personal Gateway"));
    expect(
      await litellm.findByText("Not saved: the key is kept only while the server runs"),
    ).toBeTruthy();
    expect(litellm.queryByText(/Saved securely/)).toBeNull();
  });

  it("keeps every configured profile's key under the user's control", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    await api.upsertProfile({ ...EXAMPLE_GATEWAY, keyRef: "", models: [] });
    await api.setProfileKey(EXAMPLE_GATEWAY.id, "synthetic-test-key");
    renderWithApi(<GatewaysSettings />, api);
    const profile = within(await card(EXAMPLE_GATEWAY.name));
    const field = profile.getByLabelText<HTMLInputElement>("API key");
    expect(field.readOnly).toBe(false);
    expect(field.value).toBe("");
    expect(profile.getByRole("button", { name: "Remove key" })).toBeTruthy();
  });

  it.each([
    [
      "dpapi",
      "a file encrypted with Windows data protection for your account",
      "Encrypted with Windows data protection for your account",
    ],
    ["libsecret", "the system keyring", "Saved securely in the system keyring"],
    [
      "unencrypted",
      "an unencrypted file, as no system keyring is available",
      "Stored unencrypted: no system keyring is available, so anyone who can read your files can read the key",
    ],
  ] as const)("names the %s vault", async (kind, label, status) => {
    const api = mockApi();
    await api.setProfileKey(LITELLM, "sk-x");
    vi.spyOn(api, "vaultInfo").mockResolvedValue({ kind, persisted: true, label });
    renderWithApi(<GatewaysSettings />, api);
    const litellm = within(await card("Personal Gateway"));
    expect(await litellm.findByText(status)).toBeTruthy();
  });

  it("reports a failed model listing without failing the save", async () => {
    const api = mockApi();
    vi.spyOn(api, "setProfileKey").mockResolvedValue({ discoveryError: "401 from gw" });
    renderWithApi(<GatewaysSettings />, api);
    const litellm = within(await card("Personal Gateway"));

    fireEvent.change(litellm.getByLabelText("API key"), { target: { value: "sk-x" } });
    fireEvent.click(litellm.getByRole("button", { name: "Save key" }));
    expect(
      await litellm.findByText("The key is saved, but listing models failed: 401 from gw"),
    ).toBeTruthy();
    expect(litellm.queryByRole("alert")).toBeNull();
  });

  it("discovers models once a key is set", async () => {
    const api = mockApi();
    await api.setProfileKey(LITELLM, "sk-x");
    renderWithApi(<GatewaysSettings />, api);
    const litellm = within(await card("Personal Gateway"));

    fireEvent.click(litellm.getByRole("button", { name: "Discover models" }));
    expect(await litellm.findByText("gpt-5.6-sol")).toBeTruthy();
    expect(await litellm.findByText("3 models")).toBeTruthy();
  });

  it("shows a discovery error", async () => {
    const api = mockApi();
    await api.setProfileKey(LITELLM, "sk-x");
    vi.spyOn(api, "discoverProfileModels").mockRejectedValue(
      Object.assign(new Error("401 from llm.example.test"), { _tag: "GatewayError" }),
    );
    renderWithApi(<GatewaysSettings />, api);
    const litellm = within(await card("Personal Gateway"));

    fireEvent.click(litellm.getByRole("button", { name: "Discover models" }));
    expect((await litellm.findByRole("alert")).textContent).toBe("401 from llm.example.test");
  });

  it("disables discovery until a key is set", async () => {
    renderWithApi(<GatewaysSettings />, mockApi());
    const litellm = within(await card("Personal Gateway"));
    expect(
      (litellm.getByRole("button", { name: "Discover models" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("moves the default to another profile", async () => {
    const api = mockApi();
    const other: GatewayProfile = {
      id: "other" as ProfileId,
      name: "Other",
      baseURL: "https://other.example.test/v1",
      keyRef: "",
      models: [],
    };
    await api.upsertProfile(other);
    renderWithApi(<GatewaysSettings />, api);

    await chooseFromRowMenu(await card("Other"), "Set as default");
    expect(await within(await card("Other")).findByText("Default")).toBeTruthy();
    await waitFor(() =>
      expect(
        within(screen.getByRole("article", { name: "Personal Gateway" })).queryByText("Default"),
      ).toBeNull(),
    );
  });

  it("removes a gateway after an inline confirmation", async () => {
    const api = mockApi();
    const remove = vi.spyOn(api, "removeProfile");
    renderWithApi(<GatewaysSettings />, api);
    const litellm = within(await card("Personal Gateway"));

    await chooseFromRowMenu(await card("Personal Gateway"), "Remove…");
    expect(litellm.getByRole("group", { name: "Remove Personal Gateway" }).textContent).toContain(
      "Its stored key is deleted too.",
    );
    fireEvent.click(litellm.getByRole("button", { name: "Keep" }));
    expect(remove).not.toHaveBeenCalled();

    await chooseFromRowMenu(await card("Personal Gateway"), "Remove…");
    fireEvent.click(litellm.getByRole("button", { name: "Remove gateway" }));
    await waitFor(() =>
      expect(screen.queryByRole("article", { name: "Personal Gateway" })).toBeNull(),
    );
    expect(remove).toHaveBeenCalledWith(LITELLM);
  });

  it("imports a key from OpenCode only after consent", async () => {
    const api = mockApi();
    const importKey = vi.spyOn(api, "importProfileKey");
    renderWithApi(<GatewaysSettings />, api);
    const litellm = within(await card("Personal Gateway"));

    fireEvent.click(litellm.getByRole("button", { name: "Import key from OpenCode…" }));
    expect(litellm.getByText("~/.local/share/opencode/auth.json")).toBeTruthy();
    await waitFor(() =>
      expect(
        litellm.getByRole("group", { name: "Import key from OpenCode" }).textContent,
      ).toContain("store it in the macOS Keychain"),
    );
    fireEvent.click(litellm.getByRole("button", { name: "Cancel" }));
    expect(importKey).not.toHaveBeenCalled();

    fireEvent.click(litellm.getByRole("button", { name: "Import key from OpenCode…" }));
    fireEvent.click(litellm.getByRole("button", { name: "Import key" }));
    await waitFor(() => expect(importKey).toHaveBeenCalledWith(LITELLM));
    expect(await litellm.findByText("Saved securely in the macOS Keychain")).toBeTruthy();
  });

  it("imports gateways from the OpenCode and Codex settings while there are none", async () => {
    const api = await emptyApi();
    const seed = vi.spyOn(api, "seedProfiles");
    renderWithApi(<GatewaysSettings />, api);

    expect(await screen.findByText("No gateways yet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add gateway" })).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Import gateway profiles from OpenCode and Codex settings",
      }),
    );

    const litellm = within(await card("LiteLLM"));
    expect(litellm.getByText("No API key yet")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Added 1 gateway");
    expect(seed).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", {
        name: "Import gateway profiles from OpenCode and Codex settings",
      }),
    ).toBeNull();
  });

  it("says when there's nothing to import", async () => {
    const api = await emptyApi();
    vi.spyOn(api, "seedProfiles").mockResolvedValue({ added: 0 });
    renderWithApi(<GatewaysSettings />, api);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Import gateway profiles from OpenCode and Codex settings",
      }),
    );
    expect((await screen.findByRole("status")).textContent).toBe("Nothing to import");
    expect(screen.getByText("No gateways yet.")).toBeTruthy();
  });
});

describe("profileIdFor", () => {
  it("slugifies the name and avoids taken ids", () => {
    expect(profileIdFor("Personal Gateway!", new Set())).toBe("personal-gateway");
    expect(profileIdFor("Gateway", new Set(["gateway", "gateway-2"]))).toBe("gateway-3");
    expect(profileIdFor("   ", new Set())).toBe("gateway");
  });
});
