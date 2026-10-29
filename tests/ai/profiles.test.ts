/**
 * 具名接口配置的纯逻辑：保存 / 覆盖 / 删除 / 应用 / 命名建议 / 平台切换补丁。
 * 这些规则原来散在界面事件处理里，无法单测；B3 起集中到 core 并在此锁住。
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, deriveProfileId, type Prefs } from "../../src/core/prefs";
import {
  hasProfileNamed,
  isActiveProfile,
  platformPatch,
  profileFromPrefs,
  profilePatch,
  removeProfile,
  suggestProfileName,
  upsertProfile,
} from "../../src/core/ai/profiles";
import { presetOf } from "../../src/core/ai/platforms";

const base: Prefs = {
  ...DEFAULT_PREFS,
  llmBaseUrl: "https://api.deepseek.com",
  apiKey: "sk-abcdefghijklmn",
  model: "deepseek-flash",
};

describe("从当前配置生成档位", () => {
  it("name 去空白、平台按地址推断、id 由 name + baseUrl 派生", () => {
    const e = profileFromPrefs(base, "  主力  ");
    expect(e.name).toBe("主力");
    expect(e.platform).toBe("deepseek");
    expect(e.id).toBe(deriveProfileId("主力", "https://api.deepseek.com"));
    expect(e.apiKey).toBe("sk-abcdefghijklmn");
    expect(e.useAnthropicFormat).toBe(false);
  });

  it("地址推断覆盖三个平台", () => {
    expect(profileFromPrefs({ ...base, llmBaseUrl: "https://api.siliconflow.cn/v1" }, "x").platform).toBe("siliconflow");
    expect(profileFromPrefs({ ...base, llmBaseUrl: "https://my.gateway.local/v1" }, "x").platform).toBe("custom");
  });
});

describe("upsert / remove", () => {
  it("新 id 追加、同 id 覆盖、顺序稳定", () => {
    const a = profileFromPrefs({ ...base, model: "m1" }, "A");
    const b = profileFromPrefs({ ...base, model: "m2" }, "B");
    const l1 = upsertProfile([], a);
    expect(l1).toHaveLength(1);
    const l2 = upsertProfile(l1, b);
    expect(l2.map((p) => p.name)).toEqual(["A", "B"]);
    // 同 id（同 name + baseUrl）→ 覆盖而不是追加
    const l3 = upsertProfile(l2, { ...a, model: "m9" });
    expect(l3).toHaveLength(2);
    expect(l3.find((p) => p.id === a.id)?.model).toBe("m9");
    expect(l1).toHaveLength(1); // 纯函数：入参不变
  });

  it("空名 / 空地址视为无效，返回**同一引用**（调用方据此提示未保存）", () => {
    const a = profileFromPrefs(base, "A");
    const list = [a];
    expect(upsertProfile(list, { ...a, name: "   " })).toBe(list);
    expect(upsertProfile(list, { ...a, baseUrl: "  " })).toBe(list);
  });

  it("改名即新档位（id 由名字派生：刻意行为，不是缺陷）", () => {
    const a = profileFromPrefs(base, "A");
    const renamed = profileFromPrefs(base, "A 改名");
    expect(renamed.id).not.toBe(a.id);
    expect(upsertProfile([a], renamed)).toHaveLength(2);
  });

  it("removeProfile 按 id 删除，未知 id 不动数组内容", () => {
    const a = profileFromPrefs(base, "A");
    const b = profileFromPrefs({ ...base, model: "other" }, "B");
    expect(removeProfile([a, b], a.id ?? "").map((p) => p.name)).toEqual(["B"]);
    expect(removeProfile([a, b], "p不存在")).toHaveLength(2);
  });
});

describe("应用档位与当前判定", () => {
  it("profilePatch 写回全局键并把 activeApiProfile 指向该档位", () => {
    const e = profileFromPrefs({ ...base, useAnthropicFormat: true }, "A");
    expect(profilePatch(e)).toEqual({
      llmBaseUrl: e.baseUrl,
      apiKey: e.apiKey,
      model: e.model,
      useAnthropicFormat: true,
      activeApiProfile: e.id,
    });
  });

  it("isActiveProfile 与 activeProfile 同口径（id 命中优先，悬空 id 回退键匹配）", () => {
    const a = profileFromPrefs(base, "A");
    const b = profileFromPrefs({ ...base, model: "别的模型" }, "B");
    const list = [a, b];
    // ① id 命中
    expect(isActiveProfile({ ...base, savedProviders: list, activeApiProfile: a.id ?? "" }, a)).toBe(true);
    // ② 无 id → 键匹配（地址 + 模型）
    expect(isActiveProfile({ ...base, savedProviders: list, activeApiProfile: "" }, a)).toBe(true);
    expect(isActiveProfile({ ...base, savedProviders: list, activeApiProfile: "", model: "别的模型" }, a)).toBe(false);
    // ③ id 指向另一条已存在档位：本条不算当前（id 是更强的意图表达）
    expect(isActiveProfile({ ...base, savedProviders: list, activeApiProfile: b.id ?? "" }, a)).toBe(false);
    // ④ id 悬空（指向不存在的档位）：回退键匹配，与 activeProfile 一致
    expect(isActiveProfile({ ...base, savedProviders: list, activeApiProfile: "p不存在" }, a)).toBe(true);
  });
});

describe("平台切换补丁", () => {
  const openai = { useAnthropicFormat: false };
  const anthropic = { useAnthropicFormat: true };

  it("内置平台：写内置地址并清掉 activeApiProfile（不再代表某条已存档位）", () => {
    expect(platformPatch("deepseek", presetOf("deepseek"), openai)).toEqual({
      llmBaseUrl: "https://api.deepseek.com",
      activeApiProfile: "",
    });
  });

  it("自定义平台：什么都不改（保留用户已填地址，清空等于毁数据）", () => {
    expect(platformPatch("custom", presetOf("custom"), anthropic)).toEqual({});
  });

  it("平台无 Anthropic 端点时把协议拨回 OpenAI（避免必然 404）", () => {
    expect(platformPatch("siliconflow", presetOf("siliconflow"), anthropic)).toEqual({
      llmBaseUrl: "https://api.siliconflow.cn/v1",
      activeApiProfile: "",
      useAnthropicFormat: false,
    });
    expect(platformPatch("siliconflow", presetOf("siliconflow"), openai)).toEqual({
      llmBaseUrl: "https://api.siliconflow.cn/v1",
      activeApiProfile: "",
    });
  });

  it("DeepSeek 有 Anthropic 端点：选 Anthropic 时协议保持不动", () => {
    expect(platformPatch("deepseek", presetOf("deepseek"), anthropic)).toEqual({
      llmBaseUrl: "https://api.deepseek.com",
      activeApiProfile: "",
    });
  });
});

describe("档位命名建议", () => {
  it("首个用平台显示名，重名时递增编号", () => {
    expect(suggestProfileName([], "deepseek")).toBe("DeepSeek 官方");
    const l = [profileFromPrefs(base, "DeepSeek 官方")];
    expect(suggestProfileName(l, "deepseek")).toBe("DeepSeek 官方 2");
    expect(suggestProfileName([...l, profileFromPrefs(base, "DeepSeek 官方 2")], "deepseek")).toBe("DeepSeek 官方 3");
  });

  it("hasProfileNamed 忽略首尾空白", () => {
    const l = [profileFromPrefs(base, "主力")];
    expect(hasProfileNamed(l, " 主力 ")).toBe(true);
    expect(hasProfileNamed(l, "")).toBe(false);
    expect(hasProfileNamed(l, "备用")).toBe(false);
  });
});