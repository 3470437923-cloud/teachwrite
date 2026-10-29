/**
 * 平台选择提示（D-022）：文案与形态的**唯一来源**。
 *
 * 用户给定文案，逐字使用，不得改写（含标点与英文大小写）：
 *   · DeepSeek 官方 → 非阻塞气泡「吃白饭的大肥鱼已就位」（2.5–3s 自动消失）
 *   · 硅基流动 / 自定义 → 确认弹窗 + 「不再提示」勾选 + 「仍要使用」/「换回 DeepSeek」
 *
 * 放在 core 而不是组件里：文案与形态要能被单测逐字锁住（组件层没有 DOM 测试设施）。
 */

import type { ProviderPlatform } from "../prefs";

export type PlatformNoticeKind = "bubble" | "dialog";

export interface PlatformNotice {
  kind: PlatformNoticeKind;
  text: string;
}

/** DeepSeek 官方：就位气泡（逐字） */
export const DEEPSEEK_READY_TEXT = "吃白饭的大肥鱼已就位";

/** 其它平台：能力差异提醒（逐字，用户给定） */
export const THIRD_PARTY_NOTICE_TEXT =
  "本软件为DeepSeek官方API进行了许多项目优化，如选择其它API，您可能无法享受到诸如用量显示、思考模式开关等便利功能。";

/** 气泡自动消失时长（D-022：2.5–3s） */
export const NOTICE_BUBBLE_MS = 2700;

/**
 * 选平台时该弹什么提示；已勾选「不再提示」则什么都不弹（返回 null）。
 * 注意：勾选后 DeepSeek 的就位气泡也不再出现——用户要的是"别再提示我"。
 */
export function platformNoticeFor(platform: ProviderPlatform, dismissed: boolean): PlatformNotice | null {
  if (dismissed) return null;
  if (platform === "deepseek") return { kind: "bubble", text: DEEPSEEK_READY_TEXT };
  return { kind: "dialog", text: THIRD_PARTY_NOTICE_TEXT };
}