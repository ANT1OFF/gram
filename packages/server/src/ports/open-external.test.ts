import { describe, expect, it } from "@effect/vitest";
import { InvalidState } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { Opener, type OpenerShape } from "../platform/opener.ts";
import { openCommand, openExternal } from "./open-external.ts";

describe("openExternal", () => {
  it("picks a shell-free opener per platform", () => {
    expect(openCommand("darwin", "http://localhost:3000")).toEqual({
      file: "open",
      args: ["http://localhost:3000"],
    });
    expect(openCommand("win32", "http://localhost:3000")).toEqual({
      file: "rundll32",
      args: ["url.dll,FileProtocolHandler", "http://localhost:3000"],
    });
    expect(openCommand("linux", "http://localhost:3000").file).toBe("xdg-open");
  });

  it.effect("opens http(s) through the injected opener and refuses anything else", () =>
    Effect.gen(function* () {
      const opened: Array<string> = [];
      const opener: OpenerShape = {
        launch: ({ args }) => {
          const url = args.at(-1) ?? "";
          return url.includes("broken")
            ? Effect.fail(new InvalidState({ message: "no browser" }))
            : Effect.sync(() => void opened.push(url));
        },
      };
      const run = (url: string) =>
        openExternal(url).pipe(Effect.provideService(Opener, opener), Effect.flip);

      yield* openExternal("http://localhost:3000").pipe(Effect.provideService(Opener, opener));
      expect(opened).toEqual(["http://localhost:3000"]);
      expect(yield* run("file:///etc/hosts")).toMatchObject({ _tag: "InvalidState" });
      expect(yield* run("http://broken.test")).toMatchObject({
        _tag: "InvalidState",
        message: "Couldn't open http://broken.test",
      });
      expect(opened).toHaveLength(1);

      // Under the desktop shell nothing opens here, so a page can't go around its link dialog.
      expect(
        yield* openExternal("https://organization.example.invalid/", true).pipe(
          Effect.provideService(Opener, opener),
          Effect.flip,
        ),
      ).toMatchObject({ _tag: "InvalidState" });
      expect(opened).toHaveLength(1);
    }),
  );
});
