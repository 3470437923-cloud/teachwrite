/**
 * 内置平台预设（Base URL 内置、可改）。
 *
 * 裁决依据：`docs/DECISIONS.md` D-006（三平台预设、URL 内置）、D-008（模型 id 不写死，
 * 真实清单靠「检测连接」调 `/models` 拉取）、D-019/D-021（余额只 DeepSeek 官方有）。
 * 接口事实来源：DeepSeek 官方文档（`docs/DECISIONS.md` 附录 A）。
 *
 * ⚠️ 硅基流动的 Anthropic 端点与「是否接受 thinking 参数」**未经实测**：
 * 端点一律留空、思考参数按平台过滤不发（`[待实测]`，见 KNOWN-LIMITS KL-DF-07）。
 */

import type { ProviderPlatform } from "../prefs";

/** 平台预设：URL 与能力提示；不含价格与用量口径（人民币估算已裁决不做） */
export interface PlatformPreset {
  id: ProviderPlatform;
  /** 设置页显示名 */
  label: string;
  /** OpenAI 兼容端点（自定义平台为空串：由用户自填） */
  baseUrl: string;
  /** Anthropic 格式端点（空串 = 未确认支持，需用户自填） */
  anthropicBaseUrl: string;
  /** 建议模型（仅作输入提示；真实清单以 /models 拉取结果为准） */
  suggestedModels: readonly string[];
  /** 设置页说明文案 */
  hint: string;
}

const DEEPSEEK_PRESET: PlatformPreset = {
  id: "deepseek",
  label: "DeepSeek 官方",
  baseUrl: "https://api.deepseek.com",
  anthropicBaseUrl: "https://api.deepseek.com/anthropic",
  suggestedModels: ["deepseek-flash", "deepseek-v4-pro"],
  hint: "官方直连：1M 上下文 / 384K 输出，支持思考模式与余额查询。",
};

const SILICONFLOW_PRESET: PlatformPreset = {
  id: "siliconflow",
  label: "硅基流动",
  baseUrl: "https://api.siliconflow.cn/v1",
  anthropicBaseUrl: "",
  suggestedModels: [],
  hint: "聚合平台：模型清单以「检测连接」拉取为准，不提供余额查询。",
};

const CUSTOM_PRESET: PlatformPreset = {
  id: "custom",
  label: "自定义 API",
  baseUrl: "",
  anthropicBaseUrl: "",
  suggestedModels: [],
  hint: "自填端点，OpenAI / Anthropic 协议二选一。",
};

/** 三个内置入口（顺序即设置页展示顺序） */
export const PLATFORM_PRESETS: readonly PlatformPreset[] = [
  DEEPSEEK_PRESET,
  SILICONFLOW_PRESET,
  CUSTOM_PRESET,
];

/** 取平台预设；类型上是封闭联合，`find` 必然命中，兜底走自定义以免调用方处理 undefined */
export function presetOf(platform: ProviderPlatform): PlatformPreset {
  return PLATFORM_PRESETS.find((p) => p.id === platform) ?? CUSTOM_PRESET;
}

/** 平台显示名 */
export function platformLabel(platform: ProviderPlatform): string {
  return presetOf(platform).label;
}

/**
 * 该平台是否原生支持 DeepSeek 的思考参数。
 * 只有官方直连为 true；自定义端点需用户在配置里显式声明（`Provider.supportsThinking`）。
 */
export function platformSupportsThinking(platform: ProviderPlatform): boolean {
  return platform === "deepseek";
}

/** 该平台是否提供余额查询（`GET /user/balance`，仅 DeepSeek 官方有，见附录 A §6） */
export function platformSupportsBalance(platform: ProviderPlatform): boolean {
  return platform === "deepseek";
}