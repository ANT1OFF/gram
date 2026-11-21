import { configure } from "@testing-library/dom";
import { beforeEach } from "vitest";

if (typeof window !== "undefined") {
  const local = window.localStorage;
  const session = window.sessionStorage;
  beforeEach(() => {
    local.clear();
    session.clear();
  });

  const cancel = window.Animation?.prototype.cancel;
  if (cancel) {
    window.Animation.prototype.cancel = function (this: Animation) {
      this.finished.catch(() => {});
      cancel.call(this);
    };
  }

  const response = window.Response?.prototype as
    | (Response & { bytes?: () => Promise<Uint8Array> })
    | undefined;
  if (response && typeof response.bytes !== "function") {
    response.bytes = async function (this: Response) {
      return new Uint8Array(await this.arrayBuffer());
    };
  }
}

configure({ asyncUtilTimeout: 5000 });
