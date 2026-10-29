/**
 * 模型组合框的过滤纯函数（设置页自绘下拉的回归锁）。
 *
 * 背景：原生 datalist 在 WebView2 里弹层高度不受控、只按前缀过滤，
 * 长清单显示不全（用户实测"模型下拉框疑似显示不全"）。自绘弹层用
 * 本函数做「输入即筛选、清空见全部」，行为必须可测、不随 UI 改动漂移。
 */
import { describe, expect, it } from "vitest";
import { filterModelOptions } from "../../src/core/ai/models";

const OPTIONS = ["deepseek-flash", "deepseek-v4-pro", "DeepSeek-R1", "qwen3-32b"];

describe("filterModelOptions（模型下拉过滤）", () => {
  it("空查询返回全量（含纯空白查询），且不改动原数组", () => {
    expect(filterModelOptions(OPTIONS, "")).toEqual(OPTIONS);
    expect(filterModelOptions(OPTIONS, "   ")).toEqual(OPTIONS);
    expect(OPTIONS).toHaveLength(4); // 返回副本，不在原数组上动手
  });

  it("子串匹配且大小写不敏感", () => {
    expect(filterModelOptions(OPTIONS, "flash")).toEqual(["deepseek-flash"]);
    expect(filterModelOptions(OPTIONS, "DEEPSEEK")).toEqual([
      "deepseek-flash",
      "deepseek-v4-pro",
      "DeepSeek-R1",
    ]);
  });

  it("中间子串也命中（不是 datalist 的前缀匹配）", () => {
    expect(filterModelOptions(OPTIONS, "32b")).toEqual(["qwen3-32b"]);
    expect(filterModelOptions(OPTIONS, "v4")).toEqual(["deepseek-v4-pro"]);
  });

  it("无命中返回空数组（调用方据此不展开弹层）", () => {
    expect(filterModelOptions(OPTIONS, "gpt-5")).toEqual([]);
    expect(filterModelOptions([], "任意")).toEqual([]);
  });
});
