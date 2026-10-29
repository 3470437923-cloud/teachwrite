/**
 * 内置平台预设：URL 内置、模型 id 不写死、能力标记只认官方直连（DECISIONS D-006 / D-008）。
 * 事实来源为 DeepSeek 官方文档（docs/DECISIONS.md 附录 A），断言值逐字对齐。
 */
import { describe, expect, it } from "vitest";
import {
  PLATFORM_PRESETS,
  platformLabel,
  platformSupportsBalance,
  platformSupportsThinking,
  presetOf,
} from "../../src/core/ai/platforms";

describe("内置平台预设", () => {
  it("三个入口、顺序即展示顺序、id 唯一", () => {
    expect(PLATFORM_PRESETS.map((p) => p.id)).toEqual(["deepseek", "siliconflow", "custom"]);
    expect(new Set(PLATFORM_PRESETS.map((p) => p.id)).size).toBe(3);
  });

  it("DeepSeek 官方：双端点 + 建议模型逐字对齐文档", () => {
    const ds = presetOf("deepseek");
    expect(ds.baseUrl).toBe("https://api.deepseek.com");
    expect(ds.anthropicBaseUrl).toBe("https://api.deepseek.com/anthropic");
    expect(ds.suggestedModels).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
  });

  it("硅基流动：只内置 OpenAI 端点，Anthropic 端点留空（[待实测]），模型不写死", () => {
    const sf = presetOf("siliconflow");
    expect(sf.baseUrl).toBe("https://api.siliconflow.cn/v1");
    expect(sf.anthropicBaseUrl).toBe("");
    expect(sf.suggestedModels).toHaveLength(0);
  });

  it("自定义平台：不内置任何 URL 与模型（由用户自填）", () => {
    const c = presetOf("custom");
    expect(c.baseUrl).toBe("");
    expect(c.anthropicBaseUrl).toBe("");
    expect(c.suggestedModels).toHaveLength(0);
  });

  it("思考参数与余额查询都只有官方直连为 true", () => {
    expect(platformSupportsThinking("deepseek")).toBe(true);
    expect(platformSupportsThinking("siliconflow")).toBe(false);
    expect(platformSupportsThinking("custom")).toBe(false);
    expect(platformSupportsBalance("deepseek")).toBe(true);
    expect(platformSupportsBalance("siliconflow")).toBe(false);
    expect(platformSupportsBalance("custom")).toBe(false);
  });

  it("platformLabel 返回中文显示名（设置页与气泡文案共用）", () => {
    expect(platformLabel("deepseek")).toBe("DeepSeek 官方");
    expect(platformLabel("siliconflow")).toBe("硅基流动");
    expect(platformLabel("custom")).toBe("自定义 API");
  });
});