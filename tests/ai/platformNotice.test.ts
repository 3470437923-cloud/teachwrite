/**
 * 平台选择提示（D-022）：文案逐字锁 + 形态 + 「不再提示」语义。
 * 文案是用户给定的，改了这句就等于改了产品语气 —— 所以在这里逐字钉住。
 */
import { describe, expect, it } from "vitest";
import {
  DEEPSEEK_READY_TEXT,
  NOTICE_BUBBLE_MS,
  THIRD_PARTY_NOTICE_TEXT,
  platformNoticeFor,
} from "../../src/core/ai/platformNotice";

describe("平台提示", () => {
  it("DeepSeek 官方 → 非阻塞气泡，文案逐字", () => {
    expect(platformNoticeFor("deepseek", false)).toEqual({ kind: "bubble", text: "吃白饭的大肥鱼已就位" });
    expect(DEEPSEEK_READY_TEXT).toBe("吃白饭的大肥鱼已就位");
  });

  it("硅基流动 / 自定义 → 确认弹窗，文案逐字（含标点与英文大小写）", () => {
    const expected =
      "本软件为DeepSeek官方API进行了许多项目优化，如选择其它API，您可能无法享受到诸如用量显示、思考模式开关等便利功能。";
    expect(THIRD_PARTY_NOTICE_TEXT).toBe(expected);
    expect(platformNoticeFor("siliconflow", false)).toEqual({ kind: "dialog", text: expected });
    expect(platformNoticeFor("custom", false)).toEqual({ kind: "dialog", text: expected });
  });

  it("勾过「不再提示」后两个平台都不再提示", () => {
    expect(platformNoticeFor("deepseek", true)).toBeNull();
    expect(platformNoticeFor("siliconflow", true)).toBeNull();
    expect(platformNoticeFor("custom", true)).toBeNull();
  });

  it("气泡时长落在 2.5–3s（D-022 口径）", () => {
    expect(NOTICE_BUBBLE_MS).toBeGreaterThanOrEqual(2500);
    expect(NOTICE_BUBBLE_MS).toBeLessThanOrEqual(3000);
  });
});