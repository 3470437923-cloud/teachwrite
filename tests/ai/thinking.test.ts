/**
 * 思考档位模型：四档 ↔ 协议形态映射、D-011 优先级、平台支持判定。
 * 这套规则原来是散落在界面与协议之间的隐含约定，B4 起集中到 core 并在此锁住。
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, deriveProfileId, type Prefs, type Provider } from "../../src/core/prefs";
import {
  DEFAULT_THINKING_LEVEL,
  FORCED_OFF,
  THINKING_STOPS,
  choiceOfLevel,
  effectiveThinking,
  isThinkingLevel,
  levelOfChoice,
  normalizeThinkingLevel,
  profileThinkingLevel,
  thinkingSupportedFor,
} from "../../src/core/ai/thinking";

const DEEPSEEK: Prefs = {
  ...DEFAULT_PREFS,
  llmBaseUrl: "https://api.deepseek.com",
  apiKey: "sk-x",
  model: "deepseek-flash",
};

/** 造一条具名配置（平台/思考字段显式给） */
function profile(platform: Provider["platform"], extra: Partial<Provider> = {}): Provider {
  const baseUrl = platform === "siliconflow" ? "https://api.siliconflow.cn/v1" : "https://api.deepseek.com";
  const name = extra.name ?? "档位";
  return {
    name,
    baseUrl,
    apiKey: "sk-x",
    model: "deepseek-flash",
    useAnthropicFormat: false,
    id: deriveProfileId(name, baseUrl),
    platform,
    ...extra,
  };
}

describe("四档定义", () => {
  it("恰好四档且顺序为 关闭 → 低 → 高 → 最高", () => {
    expect(THINKING_STOPS.map((s) => s.level)).toEqual(["off", "low", "high", "max"]);
    expect(THINKING_STOPS.map((s) => s.label)).toEqual(["关闭", "低", "高", "最高"]);
  });

  it("每档都有代价说明（不给模糊的「更强」）", () => {
    for (const s of THINKING_STOPS) expect(s.hint.length).toBeGreaterThan(8);
  });

  it("官方默认档是 high（附录 A §2）", () => {
    expect(DEFAULT_THINKING_LEVEL).toBe("high");
  });
});

describe("档位 ↔ 协议形态", () => {
  it("off → 关闭（effort 仍带默认值，但 enabled=false 时协议层不会发档位）", () => {
    expect(choiceOfLevel("off")).toEqual({ enabled: false, effort: "high" });
  });

  it("low / high / max → 开启 + 对应强度", () => {
    expect(choiceOfLevel("low")).toEqual({ enabled: true, effort: "low" });
    expect(choiceOfLevel("high")).toEqual({ enabled: true, effort: "high" });
    expect(choiceOfLevel("max")).toEqual({ enabled: true, effort: "max" });
  });

  it("形态 → 档位可逆；null 形态返回 null（表示没有显式设置）", () => {
    for (const level of ["off", "low", "high", "max"] as const) {
      expect(levelOfChoice(choiceOfLevel(level))).toBe(level);
    }
    expect(levelOfChoice(null)).toBeNull();
    expect(levelOfChoice(undefined)).toBeNull();
  });

  it("外部输入解析：非法值一律 null（调用方回落到配置默认）", () => {
    expect(normalizeThinkingLevel("max")).toBe("max");
    expect(normalizeThinkingLevel("medium")).toBeNull();
    expect(normalizeThinkingLevel(3)).toBeNull();
    expect(isThinkingLevel("off")).toBe(true);
    expect(isThinkingLevel("none")).toBe(false);
  });
});

describe("配置级默认（D-011 第二级）", () => {
  it("未设置任何思考字段 → null（表示没有配置级默认）", () => {
    expect(profileThinkingLevel(profile("deepseek"))).toBeNull();
  });

  it("thinking:false → 关闭；thinking:true 且无档位 → 官方默认 high", () => {
    expect(profileThinkingLevel(profile("deepseek", { thinking: false }))).toBe("off");
    expect(profileThinkingLevel(profile("deepseek", { thinking: true }))).toBe("high");
  });

  it("reasoningEffort 生效；thinking:false 时档位被开关压过", () => {
    expect(profileThinkingLevel(profile("deepseek", { reasoningEffort: "max" }))).toBe("max");
    expect(profileThinkingLevel(profile("deepseek", { thinking: false, reasoningEffort: "max" }))).toBe("off");
  });
});

describe("会话生效档位（D-011 优先级）", () => {
  it("没有具名配置时用平台内置初值（官方默认开启 + high）", () => {
    expect(effectiveThinking(DEEPSEEK, null)).toBe("high");
  });

  it("配置级默认覆盖内置初值", () => {
    const prefs: Prefs = { ...DEEPSEEK, savedProviders: [profile("deepseek", { reasoningEffort: "low" })], activeApiProfile: "" };
    // 键匹配命中该档位（baseUrl + model 一致）
    expect(effectiveThinking(prefs, null)).toBe("low");
  });

  it("会话级临时值优先级最高（只存内存）", () => {
    const prefs: Prefs = { ...DEEPSEEK, savedProviders: [profile("deepseek", { reasoningEffort: "low" })] };
    expect(effectiveThinking(prefs, "max")).toBe("max");
    expect(effectiveThinking(prefs, "off")).toBe("off");
  });

  it("平台不支持时的强制关闭形态就是「关闭」档", () => {
    expect(levelOfChoice(FORCED_OFF)).toBe("off");
  });
});

describe("平台支持判定", () => {
  it("DeepSeek 官方地址支持（即使没有具名配置）", () => {
    expect(thinkingSupportedFor(DEEPSEEK)).toBe(true);
  });

  it("聚合 / 自建地址默认不支持（KL-DF-07 未实测，宁可不发）", () => {
    expect(thinkingSupportedFor({ ...DEEPSEEK, llmBaseUrl: "https://api.siliconflow.cn/v1" })).toBe(false);
    expect(thinkingSupportedFor({ ...DEEPSEEK, llmBaseUrl: "https://my.gateway.local/v1" })).toBe(false);
  });

  it("自定义端点显式声明 supportsThinking 后支持", () => {
    const p = profile("custom", { baseUrl: "https://my.gateway.local/v1", supportsThinking: true });
    expect(thinkingSupportedFor({ ...DEEPSEEK, llmBaseUrl: "https://my.gateway.local/v1", savedProviders: [p] })).toBe(
      true,
    );
  });

  it("地址与当前档位不一致时以地址为准（参数跟着地址走，不跟着档位走）", () => {
    const ds = profile("deepseek", { name: "主力" });
    const prefs: Prefs = {
      ...DEEPSEEK,
      llmBaseUrl: "https://api.siliconflow.cn/v1",
      savedProviders: [ds],
      activeApiProfile: ds.id ?? "",
    };
    expect(thinkingSupportedFor(prefs)).toBe(false);
  });

  it("硅基流动即使声明 supportsThinking 也是……按显式声明放行（用户自己负责）", () => {
    const p = profile("siliconflow", { supportsThinking: true });
    expect(thinkingSupportedFor({ ...DEEPSEEK, savedProviders: [p], activeApiProfile: p.id ?? "" })).toBe(true);
  });
});