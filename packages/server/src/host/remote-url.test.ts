import { describe, expect, it } from "vitest";
import { redactUrlCredentials } from "./remote-url.ts";

describe("repository failure redaction", () => {
  it("keeps a credential-free URL and an email later on its line", () => {
    const message = "Couldn't clone https://git.example.test/acme/widgets: ask user@example.test";
    expect(redactUrlCredentials(message)).toBe(message);
  });
  it("redacts only URL userinfo, including encoded credentials", () => {
    const message =
      "ssh://user:invented%40password@git.example.test/acme/widgets and https://user:invented@git.example.test/acme/other";
    expect(redactUrlCredentials(message)).toBe(
      "ssh://[redacted]@git.example.test/acme/widgets and https://[redacted]@git.example.test/acme/other",
    );
  });
});
