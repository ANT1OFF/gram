import { describe, expect, it } from "vitest";

import {
  isNoticeActionLabel,
  NOTICE_BODY_ROWS,
  NOTICE_ROW_CHARS,
  noticeBodyFits,
  noticePlain,
  noticeRows,
} from "./notice.ts";

describe("notice fit", () => {
  it("fits a short command and its extras whole", () => {
    expect(noticeBodyFits("git push -u origin feat/mail-trigger")).toBe(true);
    expect(noticeBodyFits("npm test\ntimeout: 120000")).toBe(true);
  });

  it("counts wrapped rows, wide characters twice", () => {
    expect(noticeRows("x".repeat(NOTICE_ROW_CHARS))).toBe(1);
    expect(noticeRows("x".repeat(NOTICE_ROW_CHARS + 1))).toBe(2);
    expect(noticeRows("界".repeat(NOTICE_ROW_CHARS / 2 + 1))).toBe(2);
    expect(noticeRows("a\nb\nc")).toBe(3);
  });

  it("refuses a body the banner would cut", () => {
    expect(noticeBodyFits("x".repeat(NOTICE_ROW_CHARS * NOTICE_BODY_ROWS))).toBe(true);
    expect(noticeBodyFits("x".repeat(NOTICE_ROW_CHARS * NOTICE_BODY_ROWS + 1))).toBe(false);
    expect(noticeBodyFits("ls\nrm -rf build\necho done")).toBe(false);
  });

  it("refuses characters that hide or reorder the command", () => {
    for (const hidden of [
      "echo ok‮; rm -rf ~",
      "echo ok​",
      "echo\tok",
      "echo ok\r",
      "echo ⁦ok⁩",
      "a b",
    ]) {
      expect(noticePlain(hidden)).toBe(false);
      expect(noticeBodyFits(hidden)).toBe(false);
    }
    expect(noticePlain("git commit -m 'café ✓'")).toBe(true);
  });

  it("knows the answering labels exactly", () => {
    for (const label of ["Allow", "Allow 2", "Allow 99", "Merge"])
      expect(isNoticeActionLabel(label)).toBe(true);
    for (const label of ["Allow 1", "Allow 100", "Allow always", "Deny", "Open", "allow", 3])
      expect(isNoticeActionLabel(label)).toBe(false);
  });
});
